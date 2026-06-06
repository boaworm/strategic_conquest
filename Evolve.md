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

### Run 2 — CUDA validation — completed clean

Same Run 1 config but on the GB10 box (NVIDIA Blackwell + Grace ARM, 20-core). Goal: prove the gen 7 hang was MPS-specific.

```
pop=20  gens=10  games-per-agent=3  workers=8  scale=0.03  models=army production  max-turns=150
```

All 10 generations completed in ~10 minutes (~1 min/gen). **0 hangs, 0 timeouts.** Best fitness still in noise band [0.13, 0.18] — same range as Run 1, no real signal at games=3. Conclusion: hang was MPS-specific (multiple sidecars + shared M1 GPU); CUDA tolerates the load fine.

Champion ONNX export crashed at the end: `_export_model_to_bytes` hardcoded `15`-channel dummy input but movement experts have 17 channels. Same root cause as bug #1 (`mov=17ch` vs `prod=15ch`). Fix: infer `in_channels = model.conv1.weight.shape[1]`.

### Additional bug found while writing the champion re-export

Production checkpoints (`production.pt`) were saved by `torch.compile`-wrapped training, so their `model_state` keys carry an `_orig_mod.` prefix. The bare `ProductionCNN.state_dict()` does not. Result:

- `_build_base_npz` packed `production/_orig_mod.conv1.weight`
- `_handle_set_base` iterates the model's bare keys and looks up `production/conv1.weight` — **no match → falls through to "keep current weights"**.

**Every prior run silently no-op'd production perturbations.** Only the eight movement experts were actually being evolved. Fixed by stripping the prefix in `_build_base_npz` / `_build_delta_npz` and in the final ONNX-export `load_state_dict`.

## Robustness fixes applied for the big run

- `best_ever` tracked outside the population — survives elite-clone re-evaluation noise.
- Per-genome timeout in `MoEEvalPool.evaluate_b64` via `threading.Timer` → kills the sidecar, raises in the eval thread.
- Sidecar respawn: on any failure the pool replaces the dead `_EvalServer` with a fresh one (and re-sends the cached base weights).
- Mutation strength CLI knob: was hardcoded `strength=0.1`, 3.3× the initial `scale=0.03`. Compounded across gens → pathological mutants. Now defaults to `0.03` (matches scale).
- Per-genome `weights_npz` is held only for the gen's evaluation phase, then dropped — avoids OOM on long runs.

## Benchmarks — workers vs throughput vs stability (GB10, Blackwell + Grace)

Setup: pop=40, gens=3, games=8, scale=0.03, mutation-strength=0.03, max-turns=100, all 9 experts, 50×20 map.

| Workers | Result | Notes |
|---|---|---|
| 1  | Healthy, ~8 s/genome | Baseline; one CUDA context, no contention |
| 8  | Healthy, 0 timeouts | gen wall: 159 s → 252 s (gentle drift, no failure) |
| 10 | Healthy, 0 timeouts | gen wall: 172 s → 256 s — **no throughput gain over 8** |
| 20 | **Gen 2 mass-timeout** | All 17 surviving sidecars hit 120 s timeout simultaneously. Even the unchanged elite. |

Root cause of workers=20 failure: a single Blackwell GPU + 20 separate CUDA contexts = command-queue contention. Each NN forward serializes against 19 peers; per-game time blows up 6×, pushing 8-game evals past 120 s. workers=8–10 sits at the saturation point; more workers strictly hurt.

CPU was largely idle in all configs — the bottleneck is GPU launch latency on tiny (~250K-param) models, not compute or memory bandwidth. Each per-unit inference is ~250 µs of kernel launch overhead + <100 µs of actual compute. Real wins would require **batched inference** (one shared sidecar serving N workers), **CPU inference**, or **onnxruntime-in-Node** to skip the IPC. Each is a 1–2 day refactor; not done.

## Run 3 — overnight evolution — 80 gens, 9 experts

Launched 2026-06-03 22:38.

```
pop=80  gens=80  games-per-agent=8 (halved to 4 in first 40 gens)  workers=10
scale=0.03  mutation-rate=0.05  mutation-strength=0.03  elitism=2
map=50×20  max-turns=100  per-genome-timeout=180 s
checkpoints=packages/trainer/ai/checkpoints/frank-moe-v1.0  (all 9 experts)
```

### Actual performance on GB10

| Metric | Value |
|---|---|
| Wall time per generation | **~6.93 min/gen** (533 min for 77 gens at sample) |
| Total wall (projected) | ~9.2 h for full 80 gens |
| Throughput | ~93 games/min effective (80 × 8 / 6.93 × 60⁻¹) |
| Errors / timeouts across 77 gens | **0 / 0** |
| Per-checkpoint JSON size | **47 MB** (perturbations for 9 experts × ~241k params each, dumped as Python lists) |
| Disk used after 77 gens | ~3.6 GB on `/media/henrik/data/evolution/` |
| Sidecar respawns observed | 0 |

Throughput is GPU-bound. CPU usage stayed mostly idle (well under 10 effective cores worth of work). The unified-memory Grace+Blackwell SoC means PCIe isn't the issue — GPU command-queue serialization is.

### Is it actually getting better?

| Phase | Generations | Games/genome | Mean of per-gen Best | Median per-gen Best | Peak per-gen Best | Mean of per-gen Mean |
|---|---|---|---|---|---|---|
| Baseline (frank, 1-game samples) | — | 1 | — | — | — | 0.041–0.229 (σ≈0.06) |
| Phase 1 | 1–40 | 4 | 0.298 | 0.260 | **0.3065** | 0.182 |
| Phase 2 | 41–77 | 8 | 0.250 | 0.237 | 0.252 | 0.184 |

**Interpretation:**

1. **Real improvement vs baseline: ~2×.** Phase 2's denoised per-gen Best ≈ **0.236**, vs frank baseline ≈ 0.09–0.13. The population *did* evolve away from baseline behavior, and consistently so.
2. **Phase 1's "0.3065" is noise inflation, not signal.** With games=4, individual genome fitness has σ ≈ 0.03–0.04. Over 40 gens × 80 genomes = 3200 draws, the maximum gets pulled well above the true mean (extreme-value statistics — `max ≈ μ + σ·√(2·ln N)`). Once gen 41+ uses games=8 (σ halves), no genome reproduces 0.3065. The 8-game evaluations top out at 0.252.
3. **Phase 2 plateaued.** Std-dev of per-gen Best across the last 20 gens = **0.007** (≈3% of mean). The population reached steady state by ~gen 60. The crossover/mutation operator is producing equally fit children — neither escaping nor breaking the current local maximum.
4. **Mean of all genomes stayed flat (~0.18 across both phases).** Selection is keeping the top, but the gene pool isn't drifting upward — most children are no better than their parents.

**The exported champion (`best_ever.json` = gen 23, 4-game fitness 0.3065) is almost certainly weaker than a typical phase-2 elite.** Recommended post-processing: pull the top-3 gen-≥40 checkpoints, re-evaluate each over 32 games, pick the winner. That's the actual best evolved agent.

**Lessons (genetic-NN-evolution generally):**
- *Eval noise dominates selection.* With games=4 here, σ≈0.03–0.04. Selection pressure is meaningful only if the per-genome fitness gap exceeds ~2σ. Most of our gen-to-gen "improvements" are below that threshold.
- *Extreme-value bias is invisible during the run.* Each gen's "best" is a maximum-of-80 sample; the reported trajectory is biased upward by `σ·√(2·ln 80) ≈ 2.8·σ`. Need to compare the *mean* (or a denoised re-eval) across gens, not the per-gen best.
- *Adaptive games-per-agent is a trap unless you re-evaluate the elites.* Halving games to save compute in early gens lets noise winners survive into the high-fidelity phase, and the elitism mechanic clones them forward forever even though their true fitness is much lower.
- *Convergence ≠ done.* A flat trajectory might mean "found the local max" or "operator can't explore further from here". Distinguishing the two needs operator-diversity probes (re-randomize a fraction of the population) or different operator settings.

### Cost summary

~9 hours of GB10 wall time + ~3.6 GB disk. The infrastructure is solid; the evaluation methodology was not. See "Step 0 results" below for the actual fitness numbers — they overturn the optimistic reading above.

### Step 0 results — DENOISED COMPARISON OVERTURNS RUN 3

`tmp/reeval_champions.py` re-evaluated the top phase-2 checkpoints + `best_ever.json` + frank baseline over **games=32** each (target σ ≈ 0.011), same map and max_turns=100.

| Candidate | Denoised mean | ±sem | per-game std |
|---|---|---|---|
| **frank baseline (no perturbation)** | **0.2445** | 0.0162 | 0.092 |
| gen 40 (raw per-gen Best 0.2629) | 0.1925 | 0.0101 | 0.057 |
| `best_ever` (gen 23, games=4 → 0.3065) | 0.1901 | 0.0107 | 0.061 |
| gen 79 (raw per-gen Best 0.2496) | 0.1841 | 0.0094 | 0.053 |
| gen 49 (raw per-gen Best 0.2521) | 0.1783 | 0.0094 | 0.053 |

**Run 3 evolution destroyed fitness.** Every evolved candidate scores **0.052–0.066 below frank baseline** — a 3–4σ gap from baseline's sem.

The earlier "~2× over baseline (0.09–0.13 → 0.236)" claim was wrong. The 0.09–0.13 baseline figure came from the *original* Evolve.md Run 0 measurements taken on a different config (max_turns=300, 1-game samples). The actual baseline at this run's max_turns=100 is **0.2445**, not 0.09–0.13. Evolution was always operating below baseline; we just didn't know it because we never re-measured baseline under the same conditions.

### Why did evolution make things worse?

Look at the per-game std column: frank's per-game std is **0.092** — *higher than any evolved genome's*. Frank occasionally produces ugly samples (single-game scores as low as 0.07) and occasionally great ones (0.42). The evolved genomes cluster tightly around 0.19, std 0.05–0.06 — consistent mediocrity.

With games=4–8 per evaluation during evolution:
- Frank-like high-EV/high-variance genomes get sem ≈ 0.092/√8 ≈ 0.033 → an 8-game sample of a frank-equivalent individual could easily read 0.18 (mean − 2σ).
- Selection saw those low readings and discarded them.
- The evolved genomes with low per-game variance survived selection because their 8-game samples never looked unlucky.

**Selection pressure under noise rewards low variance, not high mean.** When the noise window (games=4–8) is comparable to the genuine fitness gap, the search converges on conservative low-variance policies rather than high-EV ones. The current crossover + Gaussian-mutation operator at scale=0.03 happens to be very good at producing low-variance children, so the run found a local low-variance valley *worse than baseline* and stayed there.

### Methodology errors uncovered (must fix before any A/B/C/D run)

1. **Baseline must be re-measured under each run's exact eval conditions** (games-per-agent, map size, max_turns, opponent, opponent seed) and posted alongside per-gen Best/Mean. Otherwise we have no idea whether the population is above or below baseline.
2. **games-per-agent during evolution is too small** for the per-game variance we observed (0.05–0.09). With σ ≈ 0.09 and population top-1 advantage ≈ 0.05, we need games ≳ 32 to get sem < 0.02 (necessary for selection to actually pick the better genome over the noisier neighbor). Phase-1 at games=4 had sem ≈ 0.045 — bigger than the inter-genome differences. Selection was effectively random for phase 1.
3. **Fitness function rewards short-game city-holding** — `Σ_turn (#p1 cities) / (maxTurns × totalCities)` over a 100-turn cap. Frank already does early-game captures well; the operator couldn't find improvements at this metric, so it drifted into the low-variance valley. A proper objective (win-rate, or city-count at game end, or score margin at game end) would test different policy traits.
4. **`max_turns=100` truncates games before decisions are made.** Original baseline measurements were at `max_turns=300`. Frank at games=8 vs basicAgent had a "Record 0–8, every game lost" — that's a *late-game* phenomenon visible only past T100. At T≤100 the game hasn't ended yet for frank, and our fitness rewards momentary city-holding instead of strategic outcome.
5. **Variance-aware selection** — vanilla tournament-3 selection on a noisy single-eval-per-genome implicitly prefers low-variance genomes. Mitigations: re-evaluate elites with more games, average over recent generations, or use median fitness across multiple evals instead of single-eval mean.

## Run 4 — methodology validation — clean negative result

After Step 0 destroyed the "Run 3 improved over baseline" claim, we built a cleaner experiment to answer one binary question: **can evolution improve from frank under proper conditions?**

### Config

```
pop=20  gens=10  games-per-agent=16 (constant — NO early halving)
workers=10  max-turns=300  per-genome-timeout=600 s
scale=0.03  mutation-rate=0.05  mutation-strength=0.03  elitism=2
baseline-every=2  (re-measure frank baseline at gens 0,2,4,6,8,10)
all 9 experts  50×20 map
```

Methodology changes vs Run 3:
- **baseline tracked inline** — `--baseline-every N` flag added; injects an empty-perturbation "genome" to one worker every N gens, reports mean ± sem
- **constant games-per-agent** — `--halve-games-first-half` is off by default now (was the silent default in Run 3, source of `best_ever` noise inflation)
- **max_turns=300** (matches original frank baseline conditions) instead of 100
- **games=16 with sem ≈ 0.025–0.045** — denoised enough to distinguish a 0.05 fitness gap

### Hardware behavior recap (correcting a misread)

A diagnostic during gen 1 timeouts showed nvidia-smi reading 85% util. Initial conclusion was "GPU saturated, drop workers." Wrong. **GPU was drawing 28 W on a GB10** (TDP ~100 W+). Util% only reports "scheduler has work", not load magnitude.

True picture:
- GPU is **barely warm** — tons of headroom.
- Sidecars at 70–80% CPU each — bottleneck is **Python+IPC per-inference latency**, not GPU compute.
- Each NN call is ~5–10 ms of overhead wrapping <100 µs of actual GPU work.
- 33k inferences/genome at max_turns=300 → 165–330 s baseline, exceeds 600 s for genomes that run to the cap.
- workers=10 hits perf-core ceiling (10 P-cores + 10 E-cores on Grace SoC). workers=20 dies because workers 11–20 land on E-cores at ~3× slower Python.

So "workers=20 contention failure" earlier was CPU scheduling on heterogeneous cores, not GPU contention. The fix isn't fewer workers — it's smaller per-genome compute or batched inference.

### Trajectory

| Gen | Best | Mean | Baseline (16-game) |
|---:|---:|---:|---:|
| 1 | 0.1506 | 0.1262 | 0.2495 ± 0.045 |
| 2 | 0.1598 | 0.1246 | 0.3078 ± 0.048 |
| 3 | 0.1537 | 0.1265 | — |
| 4 | 0.1408 | 0.1158 | 0.2425 ± 0.040 |
| 5 | **0.1628** | 0.1261 | — |
| 6 | 0.1592 | 0.1267 | 0.2309 ± 0.042 |
| 7 | 0.1568 | 0.1237 | — |
| 8 | 0.1550 | 0.1265 | 0.2370 ± 0.040 |
| 9 | 0.1586 | 0.1327 | — |
| 10 | 0.1538 | 0.1176 | 0.2204 ± 0.041 |

- Mean baseline across 5 readings: **~0.247** (range 0.22–0.31, the per-batch baseline variance is real — different random map samples).
- Mean evolved Best across 10 gens: **~0.156** (range 0.141–0.163).
- Gap stays at **~0.09**, never closes.

### What this actually proves

1. **Initial population is already below baseline.** Random Gaussian perturbations (scale=0.03) of frank produce children whose best-of-20 is 0.151 vs baseline 0.247. **Every direction from frank is downhill at this scale.** That's a sharp fitness peak, not a flat plateau.
2. **The operator (Gaussian mutation + 1-point per-layer crossover) can't climb back.** After 10 gens of selection, best_ever moves from 0.151 → 0.163 — a 0.012 wiggle, well inside per-batch noise. No real progress.
3. **Mean of the population stays flat at ~0.126**, far below baseline. So the bulk of children produced by crossover+mutation are also damaged. Selection holds the rare lucky one, mutation keeps making damaged children.
4. **The two earlier-noted patterns — Run 3's "low-variance valley" and validation's "always below baseline" — are the same phenomenon.** Run 3 just had so much eval noise that it looked like selection was working when it wasn't.

### Why is frank's fitness peak so sharp?

Frank was trained via IL on basicAgent. The CNN weights encode a learned *function* — a specific mapping from board state to action probabilities. That function is hand-crafted in basicAgent (priority tiers, target-value scoring, persistent transport targets). Reproducing such a discrete-logic function through CNN weights requires precise coordinated values across many parameters. **Small random noise breaks that coordination** the way one rogue weight in a transistor circuit breaks logic.

This is fundamentally different from gradient-trained networks finding their own representation. Frank didn't "learn what works"; it was *forced* to approximate a known logical decision procedure. There's no neighborhood of equivalent solutions around frank — there's just frank's specific reconstruction of basicAgent's logic, and any deviation degrades it.

### What this means for A/B/C/D

All four candidates from the earlier TODO list assumed mutation could move frank's policy meaningfully. Run 4 falsifies that assumption.

- **A (warm restart from champion)**: pointless — the "champion" itself is below baseline. There's nothing to warm-restart from.
- **B (stronger exploration with diversity injection)**: maybe useful, but increasing `scale` from 0.03 makes individual damage *worse*, not better. The signal-to-noise ratio gets worse. Random restart helps GAs that are stuck in local maxima, not GAs whose entire neighborhood is downhill.
- **C (resume Run 3's population)**: same problem as A — the population to resume is already corrupted.
- **D (army-only)**: smaller genome, more selection pressure per param. Plausibly the *only* one of the four that might help, because the per-weight damage budget is concentrated on one expert (8× less surface area for noise to corrupt).

### What would actually be worth trying

In rough order of how much it'd teach:

1. **Random-init evolution** (not from frank): seed the population with weights drawn from `N(0, 0.05)` or similar, no inheritance. See whether evolution can find *any* coherent policy from scratch. If yes, the operator is fine but frank's peak is just too sharp to perturb. If no, the operator is fundamentally too weak for this state/action space — go back to gradient methods.
2. **Gradient-based fine-tune** instead of evolution: backprop a fitness-shaped loss through frank with a small LR. Match selection pressure to local geometry. Evolution's strength is search at scale; if we already have a good initialization, gradient descent strictly dominates.
3. **Coarser action-space evolution**: don't perturb conv weights — perturb the *target-tile prior* (e.g., add a value-map bias to the last layer outputs). This restricts mutations to "what to attack" rather than "how to compute features", and respects the fact that frank's feature extractors are already useful.
4. **Reward shaping**: per Henrik's strike-value observation, augment fitness with `(enemy_value_destroyed − own_value_lost)` and re-run with the same operator. Even if the operator can't recover frank's exact logic, it might find policies that score well on the new objective. Tests whether the failure was operator-or-objective.

### Conclusions for the academic record

- GA + small Gaussian mutation **does not work** as a fine-tuning step for IL-trained policies that encode handcrafted decision logic. The operator's exploration distribution is wider than the fitness peak's basin.
- The original premise of Run 3 — "evolve away frank's weaknesses while keeping its strengths" — was geometrically incoherent. You can't preserve a sharp-peak solution while exploring it. Any non-zero exploration radius leaves the peak.
- Run 4 is the cheapest possible disproof. ~70 min of GB10 wall time + ~half a gigabyte of checkpoints answered a question that Run 3's 9 hours could not.

## TODO — next directions

### Step 0 — Denoise the candidates (mandatory prerequisite)

Run-3's exported champion is `best_ever.json` (gen 23, games=4, fitness 0.3065). Phase-2 evidence says that number is noise inflation, not signal. Before any follow-up run we need to know the *actual* best evolved genome.

- [ ] Write `tmp/reeval_champions.py`: load top-3 gen-≥40 checkpoints + `best_ever.json`, re-evaluate each over **games=32** (target σ ≈ 0.011 — 4× less noisy than phase-2 single-gen Best).
- [ ] Pick the denoised winner; that becomes the warm-start base for direction A or C.
- [ ] Compare denoised winner's fitness against frank baseline measured the same way (games=32, same map distribution, same `BasicAgent` opponent) — confirms the ~2× claim.

### A — Warm restart from the denoised champion

Load Run-3's true winner as the new base. Same scale=0.03 initial perturbations, same operator.

- [ ] Extend `evolve_moe.py` with `--base-perturbation <best_ever.json>` flag that adds the loaded perturbation to the base checkpoint weights before the population is initialized.
- [ ] Re-run: pop=80, games=8 (no halving), gens=80, scale=0.03, mutation-strength=0.03.

**What we'd learn:** whether local search around an evolved point breaks the 0.236 plateau, or whether small Gaussian noise on a converged genome is fundamentally incapable of escaping. If A also plateaus around 0.236, the operator is the bottleneck, not the starting point.

### B — Stronger exploration, fresh start

Restart from frank baseline with operator settings tuned for *exploration over exploitation*.

- [ ] `scale=0.05` (initial perturbation σ, up from 0.03)
- [ ] `mutation-strength=0.05` (matches scale; up from 0.03)
- [ ] No early-games halving — `games=8` throughout (kill the phase-1 noise window)
- [ ] **Diversity injection**: replace the bottom 20% of each generation with fresh random perturbations of the base (new CLI flag `--random-restart-rate 0.2`).
- [ ] Same gens=80, workers=10.

**What we'd learn:** whether Run 3's plateau was caused by *operator weakness* (too-small mutations + premature convergence) rather than a true local maximum. The random-restart technique is a standard GA tool we haven't tried; this measures its value.

### C — Continue Run 3's population (warm restart with diversity)

Resume from gen 77's full population, not just the winner.

- [ ] Add `--save-population` flag to `evolve_moe.py`: after each gen, write the full population (perturbations + fitness) to `population_gen{N}.json.gz`.
- [ ] Add `--resume-from <population_gen{N}.json.gz>` flag.
- [ ] Resume Run 3 from gen 77 for another 80 gens. Optionally bump mutation-strength to 0.05 to add exploration.

**What we'd learn:** whether keeping *diversity* of converged-but-different individuals helps the operator find improvements the single-champion warm restart can't. Directly tests "true local max vs operator-stuck" — if C beats A by a meaningful margin, diversity preservation is the unlock.

### D — Targeted-expert evolution: army only

Re-run with `--models army` only.

- [ ] Same code, no changes — just narrower `--models` arg.
- [ ] Scale=0.05, mutation-strength=0.05 (larger because the search space is 9× smaller).
- [ ] pop=80, games=8, gens=80.

**What we'd learn:** whether army (the most-implicated expert per Run 0 analysis: oscillates, never garrisons) responds more strongly to selection when it isn't being mixed with eight other simultaneously-evolving experts. Smaller genome → more mutations per parameter per generation → faster per-parameter selection pressure.

### Cross-cutting investments (only worth it if A–D plateau too)

- **Batched inference** in `moe_mps_server.py`: one shared sidecar serving N concurrent Node workers via a batched forward pass. Expected 5–10× throughput. Lets us run pop=500 × 200 gens overnight instead of pop=80 × 80.
- **CPU inference** path: each worker independent, no GPU contention. Verify whether 20 truly-parallel CPU workers beat 10 GPU-contended ones for these tiny (~250K-param) models.
- **onnxruntime-in-Node**: skip the Python sidecar entirely, run ONNX inference inside `eval_server.js`. Eliminates IPC overhead.

### Operator-design ideas (academic, deeper)

- **CMA-ES** instead of Gaussian mutation + 1-point crossover. Self-adapting covariance matrix tracks the search distribution's principal axes. Strong on plateaus.
- **Layer-wise mutation rates**: early conv layers may need less perturbation than the action-type/target-tile heads. Currently every weight has the same 0.05 mutation probability.
- **Novelty search**: instead of (or alongside) fitness, reward genomes whose game-behavior is *different* from current population (e.g. distinct unit-position trajectories). Pulls the population off local maxima even when fitness signal is flat.
- **Speciation (NEAT-style)**: cluster the population by genome similarity, run separate elite tracks per cluster. Preserves diversity without random restart.

## Run 5 — strike-value augmented fitness — strike-happy degeneracy

Hypothesis from Henrik: the cityScore fitness is blind to strike quality. Augment it with `enemy_value_destroyed − own_value_lost`, with a defensive location multiplier that favors kills near our own cities. Maybe selection then rewards "frank-like play AND good targeting."

### Config

```
pop=20  gens=28  games=16  workers=10  max-turns=300
fitness = α · cityScore + β · strikeValue            (additive)
strike event value = (enemy_buildTime + cargo) − own_buildTime
strike event multiplier = 1 + γ / max(1, dist_to_my_nearest_city)
α=1.0  β=0.001  γ=3.0
```

`UNIT_STATS[type].buildTime` used as unit value (same source basicAgent uses for tier scoring). Strike events extracted from `applyAction()`'s `combat` field (single-target combat only — missile blast not yet tracked).

### Trajectory

- Baseline (16-game): ~0.26 mean across 14 readings
- Evolved Best: mean **0.567**, max 0.6665 at gen 3, *never beaten* in 25 more gens
- Evolved Mean (population): **0.413** — every random perturbation scores ~2× baseline
- 12 timeouts across 28 gens (~3% of evals)

The fitness numbers exploded vs Run 4. Looked great. Wasn't.

### Disambiguation (re-eval at games=32)

| Candidate | Pure cityScore (C1) | Training objective (C2: α=1 β=0.001 γ=3) |
|---|---|---|
| Run-5 champion | **0.1229 ± 0.0108** | 0.4056 ± 0.0438 |
| Frank baseline | **0.1899 ± 0.0214** | (not measured) |
| Δ champion − baseline | **−0.067 (z ≈ −2.8σ)** | — |

**Strike-happy degeneracy confirmed at 2.8σ.** Champion holds 35% fewer cities than frank, but compensates with ~280 strike-units per game. The fitness *formula* rewarded what it was designed to reward; the *semantics* drifted because the auxiliary signal could compensate for the proxy it was added to.

This was the exact failure mode flagged before launch ("β too big → suicidal striker"). Tuning β lower would have just made the strike signal harder to find. The fundamental issue: **additive auxiliary signals let the operator trade the primary objective away.**

## Run 6 — multiplicative fitness to bound the trade — different degeneracy, same outcome

Fix attempt: switch from additive to multiplicative.

```
fitness = cityScore · (1 + β · strikeValue)
```

Intent: zero cityScore → zero fitness, regardless of strikes. The operator literally cannot abandon cities for kills.

### Config

```
pop=20  gens=48  games=16  workers=10  max-turns=300
fitness-mode = multiplicative
β=0.001  γ=3.0  baseline-every=4
```

~12 hour overnight run. Completed cleanly. 38 timeouts across 48 gens (~4% of evals; pool respawned each).

### Trajectory

- Baseline (multiplicative, 13 readings): mean **0.246**, range 0.18–0.32
- Evolved Best: mean 0.214, peak **0.2626 at gen 1**, *never beaten* in 47 more gens
- Evolved Mean: 0.159

The plateau pattern is now a signature: gen 1 or 2 wins, elite-locked forever.

### Disambiguation (re-eval at games=32)

| Candidate | C1 pure cityScore | C3 multiplicative training |
|---|---|---|
| Run-6 champion | 0.1036 ± 0.008 | 0.165 ± 0.017 |
| Frank baseline | 0.2201 ± 0.025 | 0.266 ± 0.037 |
| Δ champion − baseline | **−0.116 (z ≈ −4.5σ)** | **−0.101 (z ≈ −2.5σ)** |

**Champion lost on BOTH metrics.** Not just on pure cityScore (worse than Run 5's −2.8σ at −4.5σ), but **also on the multiplicative training objective it was selected for**. Frank-baseline-equivalent genome would score ~0.266; champion scored 0.165 in denoised eval.

### How did training report `best_ever=0.2626` then?

Same noise-inflation pattern as Run 3. games=16 single-sample sem ≈ 0.045. Across 20 genomes × 48 gens = 960 fitness draws, the maximum gets pulled up by extreme-value statistics. The gen-2 reading of 0.2626 was inflated noise; the denoised reading is 0.165. Once elite-cloned into gen 2, that noise-winner rode the elitism mechanism unchallenged for 46 more gens.

### What Run 6 added to the picture

1. **Multiplicative bounding didn't save us.** The intent was correct: prevent the operator from abandoning cities. What happened: the operator held the *minimum* positive cityScore (≈0.10 vs frank's 0.22), then maximized strike count to ~600/game so the multiplier `(1 + β·strikeValue)` blew up to ~2.6×. Net effect: a new, worse degeneracy. **Any auxiliary signal with unbounded range will be gamed.** Multiplicative didn't fix the failure mode, it relocated it.
2. **Noise dominance is structural at games=16 / pop=20.** Even with a "correct" multiplicative fitness shape, selection picks noise winners. Selection only beats noise if `inter-genome-fitness-gap > 2·sem`. With sem≈0.045 and frank-vs-perturbation gap ≈0.05, that's coin-flip selection at best. The elitism mechanic then preserves any random win indefinitely.
3. **Frank-baseline-equivalent is itself unreachable from frank+noise.** The Run 6 champion didn't just fail to beat frank — it scored worse than frank does on the *exact same metric being optimized*. The operator cannot recover frank-level play even when given a fitness that rewards it.

### Architectural realization across Runs 3–6

| Attempt | Fitness shape | Outcome | Failure mode |
|---|---|---|---|
| Run 3 | cityScore only | Plateaued ~0.19 vs baseline 0.245 | Low-variance valley; noise dominated selection |
| Run 4 | cityScore only (validated config) | Plateaued ~0.16 vs baseline 0.247 | Same; just measured cleanly |
| Run 5 | cityScore + strike (additive) | Champion at 0.12 cityScore vs 0.19 baseline | Strike compensated for city loss |
| Run 6 | cityScore × (1 + strike) (multiplicative) | Champion at 0.10 cityScore vs 0.22 baseline | Held minimum cities to keep multiplier in play |

**Two failures share a single root cause: noise-dominated selection on a sharp fitness peak.** No fitness reformulation tested so far has changed this because:
- The peak around frank's IL-trained weights is sharper than the mutation distribution can resolve.
- The 16-game eval noise is larger than the inter-genome fitness gap the operator could ever produce locally.
- Selection picks the noise winners, elitism locks them in.

Changing α/β/γ/mode rearranges which damaged-frank-clone gets locked in. None of them recover frank's actual decision logic.

### Implications for next steps

Falsifies (or weakens) the remaining TODO directions:

- **A (warm-restart from a champion)**: any "champion" from Runs 3/5/6 is below frank. Warm-starting from frank itself would just rerun the same experiment.
- **B (stronger exploration + diversity injection)**: larger mutation makes the per-genome damage worse, not better. Random restart populates with more sub-baseline genomes. Doesn't address noise-vs-gap.
- **C (resume Run-3 population)**: same problem — start position is sub-baseline.
- **D (army-only)**: only direction still potentially worth trying. Concentrates mutation budget on one expert, possibly enough that some children land in an actually different basin. Long shot.

What would actually move the needle, in order of expected impact:

1. **Increase games-per-agent to ≥32 *during evolution***. With sem ≈ 0.011, selection can detect 0.03 gaps. Costs 2× wall time. The single highest-leverage change.
2. **Re-evaluate elites every gen** (don't trust the cached eval). Prevents noise-winner lock-in. Either re-run elites with games=32 confirmation OR average fitness across the last K gens.
3. **Drop strike-value augmentation entirely** — Runs 5 & 6 show it's a distraction; the operator gamed it both ways. Stick with pure cityScore.
4. **Use a discrete-outcome fitness**: win rate per game (1 if frank wins, 0 if not). Noisier per-game, but unbiased and immune to "city-turns ≠ winning" criticism. Combine with #1 (games ≥ 32 to make win-rate samples meaningful).
5. **If 1–4 still plateau**: GA + Gaussian mutation is the wrong tool for this problem. Switch to gradient-based fine-tune of frank against a game-outcome reward (REINFORCE/PPO).

### Lesson for the academic record

Across four evolution runs with three different fitness functions, *every* champion was worse than the frank baseline they were derived from. The failure mode evolved (low-variance valley → strike-happy → minimum-city + maxi-strikes), but the conclusion didn't:

> **Genetic algorithms with Gaussian mutation cannot fine-tune an imitation-learning-trained policy on a sharp-peak fitness landscape when per-genome eval noise exceeds the inter-genome fitness gap.**

The bottleneck is noise, then fitness shape, then operator. None of those were the *cause* of failure individually; they compound. Fixing fitness without fixing noise just reshapes the degeneracy.

## Run 7 — bounded strike fitness with zone-based location + games=32 — methodology fixes applied

After Run 6's multiplicative-degeneracy, three changes:

1. **Bounded fitness**: strike contribution capped via `tanh`, so it can't outrun cityScore.
2. **Zone-based location**: enemy proximity to *my* cities matters most (defensive), proximity to *their* cities matters least.
3. **games=32 throughout** (no halving), targeting sem ≈ 0.011 — chosen to make selection detect genuine 0.03 gaps.

### Config

```
pop=20  gens=16  games=32  workers=10  max-turns=300  per-genome-timeout=900s
scale=0.03  mutation-rate=0.05  mutation-strength=0.03  elitism=2  baseline-every=4
fitness-mode = bounded
fitness = cityScore + β · tanh(strikeValue / strikeScale)
strike location factor = 1 + γ · dist_to_enemy_city / (dist_to_my_city + dist_to_enemy_city)
β=0.05  γ=4.0  strikeScale=100
```

Defaults chosen so:
- Strike contribution capped at ±0.05 (~20% of typical cityScore).
- Location: 5× near my cities, 1× near theirs.
- `tanh` scale 100: a frank-like ~50 strike-units/game → tanh(0.5) = 0.46 → +0.023 contribution. Plenty of room above.

Also added single-line timeout logging (was 12-line traceback): one observed timeout in 16 gens × 20 genomes = 320 evals (0.3% rate, down from Run 6's 4%).

### Trajectory — first time the operator showed gen-over-gen progress

| Gen | Best | Best_ever | Mean | Baseline (games=32) |
|---:|---:|---:|---:|---:|
| 1  | 0.1822 | **0.1822** | 0.1336 | 0.2199 ± 0.028 |
| 2  | 0.1909 | **0.1909** | 0.1586 | — |
| 3  | 0.1930 | **0.1930** | 0.1461 | — |
| 4  | **0.1961** | **0.1961** | 0.1296 | 0.2113 ± 0.029 |
| 5  | 0.1778 | 0.1961 | 0.1314 | — |
| 6–16 | range [0.18, 0.19] | 0.1961 | range [0.11, 0.17] | 0.2499, 0.2270, 0.2306 |

**Best_ever moved in gens 1→2→3→4, then locked.** Four monotonic improvements across the first four gens — first run where this happened. The lower noise (sem ≈ 0.028 in observed batches) let the operator confirm tiny gains (~+0.014 in 3 gens) before plateauing.

Plateau still kicked in at gen 4, identical pattern to Runs 3/5/6 — just at a fitness 0.014 higher than gen 1.

### Disambiguation (re-eval at games=32 each)

| Candidate | C1 pure cityScore | C4 bounded training |
|---|---|---|
| Run-7 champion | 0.1410 ± 0.0129 | 0.1888 ± 0.0125 |
| Frank baseline | 0.2337 ± 0.0303 | 0.2842 ± 0.0378 |
| Δ champion − baseline | **−0.093 (z ≈ −2.8σ)** | **−0.095 (z ≈ −2.4σ)** |

Champion lost on both metrics — same outcome as Runs 5/6, *smaller* than Run 6 (which was −0.116) but no improvement on Run 5 (−0.067).

### Sharp new insight: bounded fitness saturated → zero selection pressure from strikes

- Champion training fitness 0.189 = cityScore 0.141 + strike contribution **0.048** (≈ +0.05 tanh ceiling)
- Frank baseline training fitness 0.284 = cityScore 0.234 + strike contribution **0.050** (= +0.05 tanh ceiling)

**Frank's basicAgent-derived strike behavior already saturates the bounded cap.** β=0.05 + strikeScale=100 means anything past ~strikeValue=300 hits diminishing returns; both frank and the champion produce far more than that, so tanh saturates for both. The strike component is effectively a *constant +0.05* added to both candidates.

Consequence: **the operator was selecting on pure cityScore again**, just with a constant +0.05 offset that contributes no signal between genomes. Run 7 was structurally equivalent to Run 4 (pure cityScore), explaining the identical failure mode at slightly tighter noise.

### Cross-run picture: strike fitness shape vs frank's saturation

| Run | Fitness shape | Frank's strike saturation | Effective signal | Champion vs baseline (cityScore) |
|---|---|---|---|---|
| 4 | cityScore only | n/a | cityScore | −0.09 (gap noisy at games=16) |
| 5 | α·cityScore + β·strike (β=0.001) | not saturated (linear) | mostly strike | −0.067, z=−2.8σ |
| 6 | cityScore · (1 + β·strike) (β=0.001) | partial (multiplier ~1.4×) | strike-amplified | −0.116, z=−4.5σ |
| 7 | cityScore + β·tanh(strike/scale) (β=0.05, scale=100) | **fully saturated** | cityScore only | −0.093, z=−2.8σ |

The shape of the strike term controls *whether* the operator can game it, but the bounded-saturated case (Run 7) ended up providing no signal at all because frank's level of strikes is already past the saturation knee.

### To make bounded strikes carry selection signal

Two paths:

1. **Raise the saturation scale far above frank's natural level.** With `strikeScale=500`:
   - Frank strikes ~600 → tanh(1.2) = 0.83 → +0.041 contribution (NOT saturated)
   - An "exceptional" genome at strikes ~1500 → tanh(3) = 0.995 → +0.050 contribution (saturated)
   - Now there's *room above frank* for the operator to discover.
2. **Reward *quality* of strikes, not quantity**: scale strike value by relative cost ratio (cheap kills expensive = high value), so the operator gets credit only for *good* strikes rather than *many* strikes. Mostly an engineering re-design — the zone factor was a step toward this; could go further (e.g., transport-with-cargo strikes count 3×).

Both are 1–2 hour code changes if we want to try a Run 8.

### What we've actually learned across Runs 3–7

- **Eval noise dominates selection when σ_eval ≳ inter-genome σ_fitness.** True even at games=32 here. We'd need games ≥ 64 *or* fewer competing genomes to claim genuine selection. Each doubling of games halves σ but doubles wall time.
- **Auxiliary fitness signals only help if they have headroom above the baseline.** Saturation → no signal. Unboundedness → gameable. Sweet spot is narrow.
- **Frank's IL weights are on a sharp fitness peak.** Random Gaussian perturbations at scale 0.03 lose 0.05–0.10 cityScore immediately. The operator can't ever recover that loss because every child mutation steps off the peak again. Selection finds the *least* damaged child, not a better one.
- **Distance/zone-based strike weighting changed champion behavior at the margin** (cityScore −0.093 vs Run 6's −0.116) but didn't change the qualitative outcome. The agent still abandoned cities; it just abandoned slightly fewer.

### Honest framing for the academic record

Each fitness redesign was a sharper hypothesis about what the operator was doing wrong, and each empirical result narrowed the search:

- Run 5 ruled out: "more signal will produce more progress" (unbounded signal got gamed instead).
- Run 6 ruled out: "multiplicative bounding will prevent abandoning the primary objective" (the multiplier could still blow up).
- Run 7 ruled out: "bounded strike + zone weighting + denoised eval will produce frank-equivalent or better play" (bounded saturated, denoising helped at the margin only).

The remaining hypothesis is now narrower: **either** we need an unsaturated strike signal AND tight noise AND a different operator, **or** GA on this initialization is fundamentally the wrong tool and we should switch to gradient methods (REINFORCE/PPO) against the same fitness.

### Concrete next-experiment menu

Ranked by expected information gain per hour:

1. **Run 8: bounded + unsaturated strike** — keep Run 7 config, raise `strikeScale` to 500 so frank sits at +0.041 (not capped), leaving room for the operator to find genomes that strike *better* than frank. ~8h. Tests whether the operator can move when the auxiliary signal genuinely differentiates.
2. **Run 9: targeted-expert** — `--models army production` only at scale=0.05, mutation-strength=0.05, games=32, bounded fitness with unsaturated scale. Concentrates mutation surface on the 2 experts the operator might be able to actually move. ~6h. Falsifies (or saves) direction D.
3. **Gradient-based fine-tune** of frank against the same bounded fitness — switch tools entirely. Backprop a fitness-shaped surrogate loss through frank with a small LR. Direct test of "GA was wrong tool" vs "the problem is unfixable from frank." 1–2 days to wire up.
