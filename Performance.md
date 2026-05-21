# Performance — MoE Training on GB10 / DGX Spark

Analysis of why GPU power draw sits at 35–45 W (just above the ~35 W idle floor)
while `nvidia-smi` reports 100 % utilisation, and a tiered list of improvements.

Scope: the supervised imitation-learning stage (`train_2_learn_moe.sh` →
`train_movement.py` / `train_production.py`). Neuroevolution (`train_3`) has a
different profile and is noted separately at the end.

---

## Update (2026-05-21) — measured results & corrected diagnosis

Tiers 1–3 were implemented and measured on the army shard:

| Configuration | Epoch time | Verdict |
|---|---|---|
| Baseline (original DataLoader pipeline) | ~138 s | — |
| Tier 1 + 2 (dataset on GPU, no DataLoader, no GradScaler, `torch.compile`) | **~83–86 s** | 1.66× — kept |
| Tier 3 (full forward+loss compiled as one CUDA graph) | ~113 s | **reverted** |
| channels_last + circular-pad fuse | — (OOM) | channels_last reverted; pad-fuse kept |
| `reduce-overhead` mode | — (crash) | reverted → plain `torch.compile` |

### Status — pipeline concluded

Pipeline optimisation is **done**. The kept result is **138 s → ~85 s/epoch
(~1.6×)**, from Tier 1 + 2 (dataset resident on the GPU, no DataLoader, no
GradScaler, default `torch.compile`). Everything attempted beyond that — Tier 3
(full-step CUDA graph), channels_last, and `torch.compile`'s `reduce-overhead`
mode — regressed, OOM'd or crashed and was reverted. `reduce-overhead` in
particular kept stateful global CUDA-graph trees that broke across the per-file
`torch.compile` re-invocations (a CUDA driver error on file 2); default
`torch.compile` keeps Inductor kernel fusion without that fragility. The profile
confirms the model is memory-bandwidth-bound and ~85 s is near the floor for this
architecture on GB10's ~273 GB/s. The `_circular_pad` fuse was kept (numerically
identical, slightly cleaner).

**Next step — rework the model (Tier 4).** This is the only remaining lever: a
higher-arithmetic-intensity / larger network that both uses the GPU properly and
improves the agent. It is a deliberate design-and-retrain effort — see the
**Tier 4 — Model rework** section below — **not** further pipeline tuning. Do not
reopen the pipeline; channels_last can be retried later but only with a fixed
conservative batch (see the follow-ups).

**Corrected diagnosis.** The sections below assumed this workload is compute- or
launch-bound and projected a ~10–20 s floor. **That was wrong.** GPU power never
rises above ~47 W while training, on a part that draws ~100 W for genuine
compute. Low power while active is the signature of a **memory-bandwidth-bound**
workload: small FLOPs, but every conv / BatchNorm / ReLU / circular-pad layer
streams sizable feature maps to and from memory. Estimated activation traffic is
~17–23 TB per epoch; ÷ GB10's ~273 GB/s unified LPDDR5X ≈ **60–85 s**. The
measured ~83 s is therefore already close to the bandwidth floor.

**Why Tier 3 was reverted.** A whole-region CUDA graph reserves a static memory
pool ≈ batch × activations. At batch 20 K that pool plus the resident dataset hit
~117 GB and swapped; dropping to batch 8 K to fit then meant 2.5× more steps. For
a bandwidth-bound model total memory traffic is ~batch-independent, so more steps
only add per-step overhead — it ran *slower* (83 → 113 s). The code is back at the
Tier 1 + 2 state.

**What this means for the rest of this doc.** Tiers 1–3 targeted the data *feed*
and kernel *dispatch*. The feed waste was real and is now gone (138 → 83 s);
dispatch was never the true ceiling. Further speedups must **reduce activation
memory traffic** — that is architectural (Tier 4): fuse the circular pads (§3.2),
replace the 256-channel tile-head concat with FiLM-style modulation (§4.2),
reconsider channel widths. Tier 4 is also the only lever that improves the agent.
Confirm the bandwidth-bound picture with a real kernel breakdown:
`PROFILE=1 RESUME=1 DATA_DIR=… ./train_2_learn_moe.sh <unit>` writes a Chrome
trace to `tmp/profile_<unit>.json`.

### Profile results (2026-05-21, eager, batch 1024, 20 steps)

The kernel breakdown confirmed bandwidth-bound: real convolution math is a
minority of GPU time; the rest is data movement —

- `aten::copy_` + `Memcpy DtoD` ≈ **1.45 s** — mostly the circular-pad
  materialising padded tensors.
- BatchNorm (fwd/bwd/stats) ≈ **1.3 s**; elementwise / ReLU / add / fill ≈
  **2+ s** — all memory-bound.
- `nchwToNhwc` + `nhwcToNchw` ≈ **0.76 s** — pure layout-conversion waste.
- `CatArrayBatched` ≈ **0.15 s** — the 256-channel tile-head concat.
- cuDNN convolution ≈ **1.3 s** — the only real compute.

### Follow-ups to pick up

Three profile-driven changes, in order. All reduce memory traffic.

- [~] **channels_last (NHWC)** — **tried and reverted 2026-05-21.** With the
  fill-memory auto-batch (~20 K samples) it repeatedly pushed past 128 GB and
  OOM'd: cuDNN's NHWC conv path needs more workspace and the auto-batch leaves no
  margin. Its measured benefit (eager profile) was a wash anyway. To revisit, it
  needs a *fixed conservative batch* (not the fill-memory auto-batch) so the
  extra workspace fits. `_circular_pad` is left channels_last-ready (dormant
  branch) for that retry.
- [x] **Fuse the circular padding** — done 2026-05-21 (kept). `_circular_pad` in
  `models_moe.py` does the circular-X pad only; the constant Y-pad is folded into
  each conv via `padding=(1, 0)`. Verified bit-identical (0.0 diff on the
  backbone) and ONNX export OK — no retrain, existing checkpoints valid. Net: one
  fewer `F.pad` per conv (a tiny win even in NCHW); does not depend on
  channels_last.
- [ ] **FiLM instead of the 256-channel concat** — `MovementCNN.forward` does
  `torch.cat([feat, global_ctx])` → a 256-ch tensor fed to the tile head
  (`CatArrayBatched` + elementwise on double the channels). Replace with
  FiLM-style modulation: project the pooled global vector to per-channel
  scale/shift and apply it to `feat`. Changes the architecture → **needs a
  retrain** (fold into the frank-moe retrain).

---

## 1. Diagnosis — why the GPU idles at 100 % "utilisation"

`nvidia-smi` utilisation is **"a kernel was resident during the sample window"**,
not "the SMs were busy". 100 % util + 35–45 W means the GPU is continuously
handed work, but each piece is so small the SMs finish almost immediately and
then wait. Two independent problems stack up:

**Problem A — the pipeline is launch-bound and sync-bound.**
The model is tiny (~240 K parameters: 3 conv layers, ≤128 channels, 22×50 grid).
A forward+backward step is a few hundred microseconds of real math wrapped in
hundreds of microseconds of kernel-launch overhead, Python orchestration, and at
least one forced CPU↔GPU synchronisation per step (the `GradScaler`). The GPU
spends most of every step waiting for the next instruction.

**Problem B — the data path does ~3–4× redundant memory traffic per batch.**
The dataset is already one contiguous tensor in RAM, but it is fed through a
per-sample `DataLoader` with worker processes. That re-extracts and re-stacks
every sample and ships the assembled batch across a process boundary — see §3.

The result: only ~43 optimizer steps per epoch (see §3), each dominated by
overhead. Across a full run — 8 movement experts × 8 files × 40 epochs ≈ **2,500+
epochs / ~110 K steps** — fixed per-step overhead is the dominant cost.

**Bottom line:** the GB10 GPU is not the bottleneck. The feed and the per-step
overhead are. There are also two distinct goals here, and they want different
fixes:

- **Make the current model train fast** → Tiers 1–3 (pipeline + kernels).
- **Actually use a GB10-class GPU** → Tier 4 (the model is ~240 K params trained
  on 4 M+ samples; it is badly underparameterised and cannot saturate this
  hardware no matter how well it is fed).

---

## 2. Hardware context: GB10 / DGX Spark

| Property | Value | Consequence for training |
|---|---|---|
| Memory | 128 GB **unified** LPDDR5X, ~273 GB/s, shared CPU+GPU | No PCIe transfer — but CPU and GPU **contend for the same bandwidth**. Memory-bound ops and redundant copies directly steal bandwidth from compute. |
| CPU↔GPU link | NVLink-C2C, coherent | "Host→device copy" is a within-RAM copy, not a bus transfer. Cheap-ish, but not free, and still costs bandwidth + a sync. |
| GPU | Blackwell, 5th-gen Tensor Cores | Enormous bf16/fp8 throughput, *if* fed large GEMMs back-to-back. Tiny kernels with gaps waste it entirely. |
| CPU | 20-core Grace (10×X925 + 10×A725) | Plenty of cores, but per-sample Python `DataLoader` work does not parallelise well and burns shared bandwidth. |

Two things matter most:

1. **Bandwidth is shared and modest (~273 GB/s).** Every redundant copy of a
   batch is bandwidth the GPU could have used. A 0.7 GB batch copied 3× ≈ 2 GB of
   traffic per step.
2. **Unified memory is an opportunity, not just a constraint.** Any dataset that
   fits in 128 GB can live *on the GPU* permanently. The entire `DataLoader` is
   unnecessary (see Tier 2).

---

## 3. Current pipeline — measured cost breakdown

Numbers below use the large army file `/media/henrik/data/ARMY/sample_1/worker-0-army.states.bin`
(53.7 GB on disk → 939,220 samples; 13-ch fp32 stored, 17-ch bf16 in RAM).

| Quantity | Value |
|---|---|
| Worker shards / unit | 8 (`--num-files 8`), each ~25–54 GB on disk |
| Samples / shard | ~939 K (53.7 GB army shard); proportionally fewer for smaller units |
| Dataset resident in RAM | 17 ch × 22 × 50 × 2 B = **37.4 KB/sample** → **~35 GB** (army file) |
| Auto batch size (`--target-vram-usage-gb 100`) | ~16 K–20 K |
| Batch tensor size | ~20 K × 37.4 KB ≈ **~0.7 GB per batch** |
| Train steps / epoch | ~939 K × 0.9 / 20 K ≈ **~43** |
| Total steps / full run | 9 experts × 8 files × 40 epochs × ~43 ≈ **~110 K** |
| Bandwidth floor / epoch (est.) | ~17–23 TB activation traffic ÷ ~273 GB/s ≈ **~60–85 s** — workload is bandwidth-bound, not compute-bound; see Update |

**What happens per batch today** (`train_movement.py:115-130`,
`dataset_moe.py:157-158`):

1. `DataLoader` sampler picks ~20 K indices into a `random_split` `Subset`.
2. Each index triggers a Python `__getitem__` → a `states17[idx]` slice.
   That is **~20 K Python calls and ~20 K tensor slices per batch**
   (~845 K per epoch) across 4 worker processes.
3. `default_collate` stacks the 20 K slices → a new ~0.7 GB tensor (copy #2).
4. The batch crosses the worker→main process boundary via `/dev/shm` (copy #3).
5. `states.to(device)` moves it again (copy #4).
6. `GradScaler.step()` reads a GPU flag to check for `inf` → **forced CPU↔GPU
   sync, every step**.

So ~0.7 GB of useful data costs ~2.5–3 GB of memory traffic plus a sync, for
~43 steps that each do only a few hundred µs of real math. The data is **already
a single contiguous tensor** — steps 1–5 are almost entirely avoidable.

Other current-code observations:

- `train_movement.py:74` — `persistent_workers=False`: the 4 workers are
  **re-forked every epoch** (40× per file).
- No `drop_last` → the final ragged batch has a unique shape →
  `cudnn.benchmark` re-autotunes and `torch.compile` may re-trace for it.
- `train_movement.py:105` — `torch.compile(model)` uses the **default mode**,
  which does *not* enable CUDA graphs. The launch overhead is left on the table.
- `train_movement.py:78` / `train()` is called once per file by `--num-files`,
  so the model is **rebuilt and re-compiled 8×** per expert (the doc's claim
  that compile "warms up once" is inaccurate; only the on-disk inductor cache is
  reused).
- Validation runs the full 10 % split **every epoch** (40×).
- `pin_memory` is set for production but not movement; on unified memory it is
  largely irrelevant either way.

---

## 4. Improvements

Each item lists **impact**, **effort**, **risk**, and code pointers. Ordered
roughly by return on effort.

### Tier 1 — Quick wins (hours, low risk)

**1.1 Drop `GradScaler` — it forces a per-step sync and bf16 does not need it.**
`GradScaler` exists for fp16's narrow exponent range. bf16 has fp32 range, so
scaling is a no-op — but `scaler.step()` still does an `inf`-check that reads a
GPU scalar back to the CPU, **serialising every step**. Replace with a plain
`loss.backward(); optimizer.step()`.
*Impact: removes one hard sync/step — significant for a launch-bound loop.
Effort: trivial. Risk: none for bf16.*
Code: `train_movement.py:87,127-129`, `train_production.py:97,136-138`.

**1.2 `drop_last=True` on the train DataLoader.**
Makes every batch shape-identical → `cudnn.benchmark` autotunes once,
`torch.compile` traces once, and CUDA graphs (1.3 / Tier 3) become possible.
Losing ≤1 partial batch out of ~43 is irrelevant.
*Impact: removes recompile/re-autotune stalls; prerequisite for graphs.
Effort: one kwarg. Risk: none.*
Code: `train_movement.py:75`.

**1.3 `torch.compile(model, mode="reduce-overhead")`.**
`reduce-overhead` wraps the compiled regions in **CUDA graphs**, collapsing
hundreds of tiny kernel launches into one replay — the single most direct fix
for a launch-bound model. Requires static shapes (1.2).
*Impact: large for this workload. Effort: one arg. Risk: low; falls back if a
graph break occurs. Verify loss curve is unchanged.*
Code: `train_movement.py:105`, `train_production.py:116`.

**1.4 `channels_last` memory format.**
`model.to(memory_format=torch.channels_last)` and feed inputs the same way.
NHWC is the native fast path for cuDNN Tensor-Core convolutions on Blackwell.
*Impact: small–moderate. Effort: low. Risk: low.*

**1.5 Fused optimizer.** `torch.optim.Adam(..., fused=True)` runs the whole
parameter update as one kernel instead of one-per-tensor.
*Impact: small but free. Effort: one kwarg. Risk: none.*
Code: `train_movement.py:84`, `train_production.py:95`.

**1.6 Validate every N epochs (e.g. 5), not every epoch.**
Validation is ~10 % of the data; running it 40× is ~4 full epochs of wasted
compute per file.
*Impact: ~10 % wall-clock. Effort: trivial. Risk: none.*

**1.7 `persistent_workers=True`** *(only if the DataLoader survives Tier 2)* —
avoids re-forking workers 40× per file. Tier 2 removes the DataLoader entirely,
which makes this moot — do Tier 2 instead if you can.

### Tier 2 — Keep the dataset on the GPU, delete the DataLoader (the big one)

This is the highest-impact change. The dataset is one contiguous tensor and
fits in unified memory many times over (~35 GB worst case in 128 GB). There is
no reason to stream it per-sample through worker processes.

**2.1 Load `states17` directly onto the GPU; index it on-device.**
Replace the `DataLoader` loop with:

```python
states  = dataset.states17.to(device, non_blocking=True)   # ~35 GB, once
actions = dataset.action_types.to(device)
tiles   = dataset.tile_idxs.to(device)

for epoch in range(epochs):
    perm = torch.randperm(train_n, device=device)          # on-GPU shuffle
    for s in range(0, train_n - batch_size + 1, batch_size):
        idx = perm[s : s + batch_size]
        xb  = states.index_select(0, idx)                  # one on-GPU gather
        ...
```

This removes copies #1–#4 and all per-sample Python from §3: an epoch goes from
~845 K Python calls to ~43 `index_select`s. The only remaining data cost is one
on-GPU gather per batch (~0.7 GB, bandwidth-bound, overlaps with compute).
*Impact: very large — this is the main fix for Problem B. Effort: medium (rewrite
the loop; keep the dataset loader, just retarget the tensors). Risk: low. Watch
total residency: dataset-on-GPU replaces dataset-on-CPU — do not keep both.*

**2.2 Even cheaper: shuffle once per epoch, then iterate contiguous views.**
Gather the whole tensor once with the epoch permutation, then slice contiguous
batches (`states_shuf[s:s+bs]` is a **zero-copy view**). Trades one ~35 GB
gather (~0.3–0.5 s/epoch) for zero per-batch gather cost. Either 2.1 or 2.2 is
fine; 2.2 is marginally faster and graph-friendly.

**2.3 Overlap file N+1 load with training on file N.**
`--num-files 8` currently loads a file (tens of GB from disk via `memmap`,
fp32→bf16 convert) with the GPU **idle**, then trains, then loads the next.
Prefetch the next file on a background thread / second process into a second
buffer. With 128 GB, two ~35 GB files co-resident is fine.
*Impact: removes minutes of GPU-idle disk wait per expert. Effort: medium.
Risk: low.*

**2.4 Build the model and `torch.compile` once, then loop files.**
Today `train()` is re-entered per file, rebuilding and recompiling the model 8×.
Hoist model creation + compile out of the per-file loop; only swap the dataset
tensors and reset the LR schedule.
*Impact: removes 7 redundant compiles per expert. Effort: medium (refactor
`main()`/`train()`). Risk: low.*

### Tier 3 — Kernel / graph level (after Tiers 1–2)

**3.1 Manual full-step CUDA graph.**
`reduce-overhead` (1.3) graphs forward and backward; the optimizer step and loss
are still separate launches. With data on the GPU (Tier 2) and a static batch
shape, capture the **entire step** — copy batch into a static input buffer,
forward, loss, backward, `optimizer.step()` — into one `torch.cuda.CUDAGraph`
and `replay()` it each iteration. This is the definitive cure for launch
overhead.
*Impact: large (on top of 1.3). Effort: medium-high. Risk: medium — graphs are
strict about static shapes/pointers and in-place ops; validate carefully.*

**3.2 Fuse the circular padding.**
`_circular_pad` (`models_moe.py:19-22`) issues **two `F.pad` kernels per conv**
(circular X, then constant Y) — 6 extra kernels + 6 padded-tensor materialisations
per forward. Options: pre-pad once and share across the 3 convs where geometry
allows; or fold the constant Y-pad into the conv (`padding=(1,0)`) and only
`F.pad` the X axis. Under CUDA graphs the *launch* cost disappears, but the extra
memory traffic from materialising padded tensors does not.
*Impact: small–moderate. Effort: low–medium. Risk: low (keep the cylindrical
semantics identical — verify outputs match).*

**3.3 fp8 GEMMs (experimental).** Blackwell Tensor Cores run fp8. For a small
conv net the gain is modest and accuracy needs care; treat as a low-priority
experiment, not a primary lever. bf16 is the pragmatic choice.

### Tier 4 — Model architecture (better agent *and* better GPU use)

The model is ~240 K parameters trained on **4 M+ samples per unit type**. It is
heavily underparameterised: it underfits the data *and* gives the GPU too little
work per launch. Growing the model fixes both — it is the only Tier that
improves the agent itself, and it is the real answer to "how do I use a GB10".

**4.1 Adopt a residual backbone.**
Replace the 3 plain convs with a small ResNet: a stem + **6–12 residual blocks**
at **128–256 channels** (with cylindrical X-padding throughout). This is 10–50×
the FLOPs/parameters, moving the model from launch-bound toward compute-bound —
i.e. the GPU starts doing actual work — while plausibly making a much stronger
policy.
*Impact: large for both utilisation and agent quality. Effort: medium. Risk:
medium — see 4.3 for the inference-cost constraint; requires a full retrain
(already planned for frank-moe).*

**4.2 Cheaper global context in the tile head.**
The tile head concatenates a broadcast global-avg-pool to make a 256-channel
tensor (`models_moe.py:73-74`) — doubling channel count and memory traffic for
one 1×1 conv. A FiLM-style modulation (project the pooled vector to per-channel
scale/shift and apply) gives the same global-context benefit at a fraction of
the bandwidth.
*Impact: small–moderate (bandwidth). Effort: low–medium. Risk: low.*

**4.3 Respect the CPU/CoreML inference budget.**
`CLAUDE.md` requires the runtime agent to run inference on CPU (or CoreML),
one forward per unit per turn. A larger model is fine there within reason —
budget it. A ~2–5 M-param conv net is still well under a millisecond per unit on
CPU. Measure ONNX CPU latency for any candidate architecture before committing,
and keep an eye on the `.onnx` size. This is a real constraint on how far 4.1
can go, not a blocker.

### Tier 5 — Train multiple experts together

All 8 movement experts share an **identical architecture**; they are currently
trained as 8 separate, sequential, individually-too-small runs. Batching them
multiplies the work per kernel launch.

**5.1 Grouped-convolution super-expert.** Stack K experts into one module using
`groups=K` convolutions: input `[B, K×C, H, W]`, every conv does all K experts
in one launch. One training run, K× the arithmetic intensity.
*Constraint:* each expert needs its own unit-type data resident. One file is
~16–35 GB bf16, so ~3 experts co-resident fits in 128 GB → train in groups of
2–3. *Impact: moderate–large (utilisation). Effort: high (data plumbing for K
datasets, K sets of labels/losses). Risk: medium.*

**5.2 Concurrent CUDA streams.** Simpler alternative: run several single-expert
training steps on separate CUDA streams so their tiny kernels interleave and
fill the SMs. Less elegant than 5.1 but much less plumbing.
*Impact: moderate. Effort: medium. Risk: medium (stream/memory management).*

Tier 5 is optional polish — Tiers 1–4 already get the GPU busy. Pursue it only
if profiling still shows gaps after a bigger model lands.

---

## 5. How to measure (do this first, and after each change)

Do not tune blind — confirm the bottleneck and quantify each change:

- **`torch.profiler`** around ~20 steps with `record_shapes=True`; export a
  Chrome trace. Look for gaps between kernels (launch-bound) vs. long kernels
  (compute-bound), and any `cudaStreamSynchronize` / `Memcpy` on the critical
  path.
- **`nsys profile -t cuda,nvtx`** for a system-level timeline — shows GPU idle
  gaps and CPU-side `DataLoader` activity directly.
- **`nvidia-smi dmon -s pucm`** during a run: watch `sm%`, `mem%`, and power
  together. Power is a good proxy — Tiers 1–3 should push the steady-state draw
  well above 45 W; if it does not, the change did not land.
- **Wall-clock per epoch**, printed already. The bandwidth floor for the current
  model is ~60–85 s/epoch (§3 / Update); the measured ~83 s is already near it,
  so further pipeline tuning has little left to give.
- Sanity: a fixed val-loss/accuracy baseline before/after each change so a
  speedup is not silently a correctness regression.

---

## 6. Suggested order

1. **Measure** — profile one expert, record epoch time + power (§5).
2. **Tier 1** — all of it; an afternoon, low risk, immediately visible in power.
3. **Tier 2.1/2.2** — dataset on GPU, delete the DataLoader. Biggest single win.
4. **Re-measure.** Tiers 1–2 should make the *current* model train near its
   compute floor.
5. **Tier 2.3/2.4** — overlap file loads, compile once.
6. **Tier 3.1** — full-step CUDA graph, if profiling still shows launch gaps.
7. **Tier 4** — bigger residual model. This is the strategic change: it is what
   actually makes a GB10 worthwhile and is the only tier that improves the agent.
   Pair it with the frank-moe retrain that is already planned.
8. **Tier 5** — only if gaps remain after a bigger model.

Expect Tiers 1–3 to make the existing model train several times faster; expect
Tier 4 to be where sustained power finally climbs toward the 100 W ceiling,
because the GPU is finally doing a GB10-sized amount of work.

---

## Tier 4 — Model rework: detailed next steps

The pipeline is done (~83 s/epoch, bandwidth-bound). Real gains now — both agent
strength and GPU utilisation — come from the model. Two fronts: the **network**
and the **data / representation**. First, a ceiling that frames everything.

### 4.A The ceiling: imitation learning cannot beat its teacher

The movement and production experts are trained by **imitation learning** on
(state, action) pairs collected from `BasicAgent` games. A bigger, better network
trained on those labels asymptotically *matches* `BasicAgent` — it cannot exceed
it. The architecture and representation work below makes the model match the
teacher more reliably, more sample-efficiently, and with better generalisation —
but the skill ceiling stays `BasicAgent` until the **label source** changes (4.D).

Decide up front what Tier 4 is for:
- **"Match BasicAgent better / cheaper"** — 4.B + 4.C + DAgger (4.D.1). No RL.
- **"Beat BasicAgent"** — the above, then RL fine-tuning (4.D.2).

### 4.B Network architecture

The current backbone — 3 conv layers (17→64→128→128, 3×3) — has two structural
problems beyond merely being small (~240 K params):

**4.B.1 Receptive field — the model cannot reason across the board.**
Three 3×3 convs give a receptive field of ~7×7 tiles on a ~22×50 map. The
convolutional features are therefore *local*: a unit's decision cannot spatially
account for anything more than ~3 tiles away. Global information reaches the
heads only as a single board-averaged vector (the `action_type` pool and the
tile-head concat) — there is no mechanism for spatially-resolved long-range
reasoning ("route my transport around the enemy fleet two-thirds of the map
away"). Fixes:
- **Depth** — ~10–16 residual blocks grow the receptive field to cover the whole
  board.
- **Explicit global mixing** — a few self-attention layers (1100 tiles → 1100²
  attention is cheap) or squeeze-excitation blocks let any tile attend to any
  other. A hybrid (residual conv trunk + 2–4 attention/mixer layers) is the
  modern game-net design and the recommended target.
- Keep circular X-padding in the convs; for attention, use a positional encoding
  that respects the X-wrap (the `dx`/`dy` channels already do this
  unit-relative).

**4.B.2 Width and depth.** 64/128 → 128–256 channels; 3 layers → a residual
stack. AlphaZero-class game nets are ~10–20 blocks at 128–256 ch. This is the
"enlarge it" that is explicitly fine — and a denser net is also what finally
makes the GB10 draw real power.

**4.B.3 Value / auxiliary heads.** The experts are policy-only. Add a **value
head** (predict the game outcome — the collector already records wins) as an
auxiliary task: it regularises the trunk, forces it to learn position
evaluation, and is *required* for RL fine-tuning (4.D.2). Other cheap auxiliaries
that improve the learned representation: predict enemy positions next turn,
predict whether a city is about to be captured.

**4.B.4 Shared trunk for the 8 movement experts (optional, larger change).**
Today there are 8 separate models. A shared conv/attention **trunk** + 8
lightweight per-unit-type **heads** would share universal features (terrain,
enemies, fog), train once on all data, and be the single bigger model that
genuinely uses the GPU. Tradeoff: it couples the experts and gives up the clean
MoE separation. Worth a prototype.

**4.B.5 FiLM tile head.** (Carried from the pipeline follow-ups.) Replace the
256-channel concat with FiLM modulation — cheaper, and a cleaner global-context
mechanism. Subsumed if attention (4.B.1) is added.

### 4.C Input representation — what the model currently cannot see

The 17-channel tensor has real gaps. Most fixes change `fillViewTensor`, so they
require **re-collecting data** (the stored shards hold only the 13 base
channels) — bundle them into one collection run.

**4.C.1 Enemy units are collapsed into ONE channel — the biggest gap.**
Friendly units get 8 channels (one per type, ch0–7); all visible enemy units are
summed into a single channel (ch9). **The model cannot tell an enemy army from
an enemy battleship.** For combat that is decisive — engage a transport, flee a
battleship. Give enemies per-type channels (8, or at minimum a land/sea/air
split). Highest-value representation fix.

**4.C.2 Unit stacking is invisible.** Channels 0–7 do *health-clamped*
accumulation; since every unit has `maxHealth = 1`, a tile with five armies
clamps to 1.0 — indistinguishable from one army. Stack sizes are lost. Add an
un-clamped (or log-scaled) per-tile count if stack depth matters.

**4.C.3 The acting unit's own state is missing.** The marker (ch13) says *which*
unit acts, but not its `movesLeft`, `fuel` (air units), `hasAttacked`, or
`sleeping`. A fighter with 2 fuel left plays nothing like one with 30. Feed these
as scalar side-inputs (like the production global vector) or broadcast channels.

**4.C.4 No cross-turn memory.** Each `act()` builds a fresh tensor and
`seenEnemies` resets each turn, so ch9 holds only *currently* visible enemies. A
competent player remembers where an enemy fleet was last seen. Add a decaying
"last-seen enemy" channel, frame-stacking (last K observations), or a recurrent
state. The decaying channel is the cheap option and fits the per-`act()`
structure.

**4.C.5 Strategic distance features.** `dx`/`dy` to the acting unit exist; cheap
additions: distance to the nearest enemy city, nearest friendly city, nearest
unexplored region. Directly useful, low cost.

### 4.D Labels and the data pipeline — getting past the ceiling

**4.D.1 DAgger — fix distribution shift (high value, no RL).** IL trains only on
states `BasicAgent` visits. The trained NN visits *different* states — the
consequences of its own mistakes — where it has no training signal, so errors
compound. DAgger: run the current NN, have `BasicAgent` label the states the NN
actually reaches, add them to the dataset, retrain; repeat. A large, cheap
quality gain that stays within "match BasicAgent." The headless engine is fast
enough (~2400 games/s on 8 workers).

**4.D.2 RL fine-tuning — exceed the teacher.** After the IL bootstrap, do
policy-gradient / PPO self-play with a game-outcome reward (already sketched as
"Phase 2" in `NN_Agent.md`). Requires the value head (4.B.3). Engine throughput
is ample for self-play. This is the *only* route to an agent stronger than
`BasicAgent`.

**4.D.3 Data balance.** Reservoir sampling (max 3000/game) likely
under-represents decisive moments — combat, city capture, transport
load/unload — relative to routine moves; consider oversampling them. The rarer
unit types also have much smaller shards (carrier ~4 GB vs army ~25 GB), so those
experts see less data and are weaker — collect more for them.

### 4.E Constraint — CPU / CoreML inference budget

`CLAUDE.md` requires the runtime agent to run inference on CPU (or CoreML), one
forward per unit per turn. A larger model is fine within reason — but budget it:
measure ONNX CPU latency for every candidate architecture before committing. A
~2–10 M-parameter conv/attention net is still well under a few ms per unit on
CPU, and attention over ~1100 tiles is cheap; watch the `.onnx` size. This caps
how far 4.B can be pushed — verify, don't assume.

### 4.F Recommended order

1. **Re-collect data** with per-type enemy channels (4.C.1) — and, since a
   collection run is needed anyway, fold in 4.C.2–4.C.5 at the same time.
2. **Bigger backbone** with a board-covering receptive field (4.B.1–4.B.2) plus a
   **value head** (4.B.3). Prototype the shared trunk (4.B.4) in parallel.
3. **Re-profile** the new model — a denser net should finally push GB10 power off
   the floor (the original goal of this whole exercise).
4. **DAgger** (4.D.1) to close the distribution-shift gap.
5. **RL fine-tuning** (4.D.2) — only if the goal is to beat `BasicAgent` (4.A).

The production expert shares the 4.B backbone gains; its 28-value global feature
vector is already reasonably rich, so 4.C matters less there.

---

## Appendix A — Neuroevolution (`train_3_evolve_moe.sh`)

Out of scope above, but the same root causes apply differently: evolution is
**inference-bound** over many genomes via the `moe_mps_server.py` sidecar.
Its levers are batching genome evaluations together, keeping models resident on
the GPU (already done), and CUDA graphs for the fixed-shape inference step.
Profile it separately before optimising.

---

## Appendix B — Data layout: what matters, what doesn't

Two things are easy to conflate. They are **independent**.

- **Total training data** — the total sample count the model learns from. More
  is better; it sets the quality ceiling. Keep generating as much as you want
  (you already have hundreds of GB per unit — more is welcome).
- **Shard (worker-file) size** — how that total is *chunked on disk*. Packaging
  only. It does **not** change what the model learns: `--num-files` walks every
  shard and warm-starts across them, so the model sees the whole dataset
  regardless of how it is split.

So shard size does not trade off against data amount.

### How the code actually loads data

It does **not** stream small chunks per epoch. The unit of loading is a whole
worker file:

1. `--num-files 8` loops over the 8 worker files for the unit type.
2. For each file, the **entire file** is read from disk **once** and
   materialised as one bf16 tensor in memory (`MovementDataset.__init__`).
3. **All 40 epochs** then run over that fully-resident file — every batch is
   sliced from the in-memory tensor; **no disk I/O during the epochs**.
4. The next file loads (warm-starting from the previous checkpoint), and so on.

Disk is read **once per shard** (8 reads per unit), not once per epoch. At any
moment only **one shard** is resident — never all 8 shards of a unit at once,
and never a streamed-in small "chunk". After Tier 2 that resident copy simply
lives on the GPU instead of CPU RAM; the one-shard-at-a-time pattern is
unchanged.

### Practical guidance

- **Do not shrink datasets or reorganise generation for performance.** Tiers 1–4
  live entirely in the training loop; data layout is irrelevant to them.
- **Shard size**: your shards are large by design — ~25–54 GB on disk, ~15–35 GB
  resident as a bf16 tensor. One shard fits comfortably in 128 GB alongside the
  model and activations, and loading a whole shard so PyTorch iterates it in
  memory is exactly right — it is what Tier 2 formalises. Keep doing this; do
  not shrink shards. You cannot hold several units co-resident, which is the
  real reason Tier 5 stays off the table.
- **The one layout choice that does touch quality**: training is shard-at-a-time
  (40 epochs on shard 0, *then* shard 1, …), so samples are shuffled only
  *within* a shard, never globally. For better mixing, run **fewer epochs per
  shard and cycle through all shards several times** (an outer loop over files)
  rather than 40-epochs-then-move-on. Larger shards also improve the in-shard
  shuffle — the real, if mild, basis for "bigger files are better". That is a
  quality lever, not a performance one.
