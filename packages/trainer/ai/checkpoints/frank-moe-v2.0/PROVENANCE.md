# frank-moe-v2.0

ONNX inference weights produced by Run 7 of the neuroevolution loop
(`evolve_moe.py`, see `Evolve.md`).

## Lineage

- **Base**: `frank-moe-v1.0/` — original IL-trained MoE.
- **Run 7 source**: `/media/henrik/data/evolution/run_20260605_1008/champion/`
- **Selected at**: generation 3 of 16
- **Training fitness**: 0.1961 (bounded mode)
- **Re-eval (games=32)**:
  - C1 pure cityScore:           0.1410 ± 0.0129
  - C4 bounded training fitness: 0.1888 ± 0.0125
- **Re-eval gap vs frank-v1.0**: −0.093 on pure cityScore (z ≈ −2.8σ — champion holds fewer cities than the IL baseline)

## Training config (Run 7)

```
pop=20  gens=16  games=32  workers=10  max-turns=300
scale=0.03  mutation-rate=0.05  mutation-strength=0.03  elitism=2
fitness-mode = bounded
fitness = cityScore + 0.05 · tanh(strikeValue / 100)
strike location factor = 1 + 4 · dist_to_enemy_city / (dist_to_my_city + dist_to_enemy_city)
```

## Warning

Statistical re-eval at games=32 shows v2.0 is **below v1.0 on pure cityScore**.
The strike-augmented training objective measured v2.0 as comparable to v1.0
only because frank's natural strike behavior already saturates the bounded
strike cap, so the strike term contributes ~+0.05 to both equally.

Recorded games may reveal qualitative behavioral differences not captured
by the fitness metric. That's the reason for the head-to-head test.
