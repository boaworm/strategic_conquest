# Evolve.md — Frank-MoE-v1.0 evolution log

Tracking work on evolving `frank-moe-v1.0` away from its known weaknesses.

## Baseline (frank-moe-v1.0)

Recorded from 8 games vs basicAgent in `tmp/replays/`:
- Record: 0–8 (every game lost, 0 cities held at end)
- Captures: 22 across 8 games, held a median of 1–6 turns
- Garrison behaviour: SLEEP count = 0 across all games — armies never stay on a captured city
- Movement: army expert picks MOVE every turn (0% stationary) but units only visit 2–13 distinct tiles. Many oscillate between 2 adjacent tiles for 30+ turns
- Unit lead: frank does briefly out-produce basicAgent (peak +14 units in d842ec9b); the lead collapses once city deficit compounds
- Opponent behaviour: basicAgent garrisons only ~25% of its cities; 88% of frank's attacks on p2 cities find no defender. frank still fails to convert those attacks into held cities

Root-cause hypothesis: army expert's `target_tile` head produces short-range, locally-anchored targets. On enemy islands with no friendly-city gradient, behaviour degenerates into oscillation.

## Evolution infrastructure

- `train_3_evolve_moe.sh` — wrapper, defaults: pop=100, gens=30, games=10, workers=8, scale=0.05, map=50×20, max_turns=300
- `packages/trainer/ai/evolve_moe.py` — main loop. Tournament-3 selection + 1-point crossover per layer + per-element mutation (rate=0.05, strength=0.1). Elitism=2.
- Fitness = `mean( cityScore / (maxTurns * totalCities) )` over `games-per-agent` games, where `cityScore = Σ_turn (# p1 cities)`. Range ~[0,1]; basicAgent's reference fitness if it held everything for the full game = 1.0.
- Eval pool: N persistent Node.js `eval_server.js` processes, each shelling out to a Python MPS sidecar that hot-swaps perturbed weights between genomes.
- `--checkpoints` should point at `packages/trainer/ai/checkpoints/frank-moe-v1.0` (NOT the default `moe/` working dir).
- `--models` flag lets us evolve only some experts (e.g. just `army production`).

## Speedup plan (knobs ranked by expected impact)

| Knob | Default | Proposed | Why |
|---|---|---|---|
| `--map-width × --map-height` | 50×20 = 1000 tiles | **fixed at 50×20** | Frank's ONNX files were exported with static input shape 22×50 (`Got: 12 Expected: 22` if you try 30×10). Re-exporting with dynamic axes is possible but out of scope — we evolve on the same map size frank was trained on. |
| `--max-turns` | 300 | 150 | Most games we saw decided by T100; cap at 150 |
| `--games-per-agent` | 10 (halved early) | 4 / 8 | Noisy but cheap early, then refine |
| `--population` | 100 | 40 | Need to converge fast; bigger pop = more parallel but more wall time per gen |
| `--workers` | 8 | 10 on M1 Max | Match perf-core count |
| `--models` | all 9 | `army production` | Targets the two experts implicated in the losses |
| `--scale` (init perturb σ) | 0.05 | 0.03 | Smaller jumps from a trained baseline are usually safer |

Anything <0.5 s per genome eval per game makes pop=40 × gens=20 × 8 games ≈ 6400 games doable in ~15 min on 8 workers. Benchmark to confirm before launching.

## Bugs fixed before launching

1. **`moe_mps_server.py`** hardcoded `channels=15` for both `MovementCNN` and `ProductionCNN`. Frank's movement experts were trained with 17 input channels (13 base + position + carried + dx + dy). `load_state_dict` failed with `size mismatch for conv1.weight: [64, 17] vs [64, 15]`. Fix: infer `mov_channels` and `prod_channels` from the first conv weight in the npz at `SET_BASE` time.
2. **`eval_server.js` MPSSidecar.inferMovement** read `(5 + H*W) * 4` bytes for the movement response, but the sidecar writes only `(2 + H*W) * 4` bytes — the model has 2 action types (MOVE, SKIP); it used to have 5 (MOVE/SKIP/SLEEP/LOAD/UNLOAD), and the wrapper was never updated. The eval loop was deadlocking on `_readExact` waiting for 12 bytes that would never arrive. Fix: `NUM_ACTIONS = 2`.

## Benchmark results (50×20, max_turns=150, baseline frank)

| Workers | Wall time | Games | s/game (parallel) |
|---|---|---|---|
| 1 (3 games sequential) | 24.3 s | 3 | 8.1 |
| 2 (1 game each, parallel) | 5.9 s | 2 | 2.93 |
| 4 (1 game each, parallel) | 11.8 s | 4 | 2.95 |
| 8 (1 game each, parallel) | 18.5 s | 8 | 2.31 |

→ 8-worker pool ≈ **26 games/min**. MPS contention caps the speedup at ~3.4× over 1 worker (8 separate sidecar processes share the same M1 Max GPU).

Fitness noise on baseline: 8 single-game runs spanned 0.041 – 0.229 (mean ≈ 0.09, σ ≈ 0.06). Need ≥3 games/agent to denoise selection.

## Runs

### Run 1 — smoke test — **HUNG at gen 7/10**

Settings actually used:

```
pop=20  gens=10  games-per-agent=3  workers=8  scale=0.03  models=army production  max-turns=150
```

Outcome:
- Gen 1: Best 0.1454  Mean 0.1146
- Gen 2: Best 0.1854  Mean 0.1060
- Gen 3: Best 0.1543  Mean 0.1173
- Gen 4: Best 0.1862  Mean 0.1072
- Gen 5: Best 0.1419  Mean 0.1037
- Gen 6: Best 0.1502  Mean 0.0992
- Gen 7: 18/20 genomes evaluated, then **stalled forever** — 2 MPS sidecars died silently, eval_server.js `proc.stdout.readline()` blocks on the closed pipe, Python `ThreadPoolExecutor.as_completed` waits for futures that will never resolve.

Conclusions:
1. **Best fitness wandered in [0.142, 0.186]** — pure noise on 3 games/agent. No real improvement over baseline (~0.13). The elitism mechanic clones the perturbations of the previous best but **re-evaluates from scratch with `fitness: 0.0`**, so each generation's reported "best" is a fresh noisy sample of whichever genome happened to win the dice roll that gen.
2. **No per-genome timeout** means a single sidecar crash hangs the entire run. The evaluate loop in `evolve_moe.py` needs:
   - A per-genome wall-clock timeout (e.g. `future.result(timeout=30)`).
   - On timeout: mark that genome fitness=0, log the failure, replace/restart the dead sidecar so the pool can continue.
3. **Reported best is from re-evaluation, not stored best.** Need to either (a) skip re-evaluation of elite (cache fitness), or (b) keep a `best_ever` outside the population so we don't lose the discovery.

### Fixes needed before Run 2

- [ ] Add per-genome timeout in `evolve_moe.py` (≥2× expected time, then fail genome with fitness=0)
- [ ] Detect dead sidecar in `MoEEvalPool` and respawn it
- [ ] Track `best_ever` (genome + fitness) across the whole run, not just per-generation best
- [ ] Optional: skip re-evaluation for elite to reduce noise consumption


Goal: confirm the loop runs end-to-end and produces a higher-fitness champion than baseline.

```
pop=20  gens=10  games-per-agent=3  workers=8  scale=0.03  models=army production
```

Estimated cost: 20×3 = 60 games/gen ÷ 26/min = **2.3 min/gen × 10 = ~25 min total**.

Settings rationale:
- `--models army production` — limit search to the experts most implicated in losses (army never garrisons; production mix may also matter). Reduces genome size 9× → faster eval npz and saner mutation surface.
- `scale=0.03` smaller than default `0.05` — start tight, ramp later if we see no movement.
- Elitism stays at default 2.
