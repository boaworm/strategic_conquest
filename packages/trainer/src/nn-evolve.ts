/**
 * Neuroevolution for NN weights using Evolution Strategies.
 *
 * Hybrid approach:
 * - Python exports perturbed models to ONNX (one-time per genome)
 * - JavaScript runs games directly with NnAgent (no socket overhead)
 *
 * Fast because:
 * 1. No subprocess spawning per game
 * 2. No Unix domain socket IPC
 * 3. All game logic runs in-process with ONNX Runtime
 *
 * Usage:
 *   npm run nn-evolve -- --base ./ai/checkpoints/best_model.pt --pop 30 --gens 50
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { spawn, execSync } from 'child_process';
import { isMainThread } from 'worker_threads';
import * as ort from 'onnxruntime-node';
import { createGameState, applyAction, getPlayerView } from '@sc/shared';
import type { AgentAction } from '@sc/shared';
import { BasicAgent } from '@sc/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ───────────────────────────────────────────────────────────────────

interface LayerPerturbation {
  [layerName: string]: { data: number[]; shape: number[] };
}

interface Genome {
  id: string;
  perturbations: LayerPerturbation;
  fitness: number;
  generation?: number;
}

interface EvolutionConfig {
  baseCheckpoint: string;
  populationSize: number;
  generations: number;
  gamesPerAgent: number;
  workers: number;
  elitism: number;
  scale: number;
  mutationRate: number;
  mutationStrength: number;
  outputDir: string;
  mapWidth: number;
  mapHeight: number;
  maxTurns: number;
}

// ── NnAgent for evolution (inline, no socket) ───────────────────────────────

class EvolutionNnAgent {
  private session: ort.InferenceSession | null = null;
  private playerId: string = '';
  private mapWidth: number = 0;
  private mapHeight: number = 0;

  async init(modelPath: string, config: { playerId: string; mapWidth: number; mapHeight: number }): Promise<void> {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.session = await ort.InferenceSession.create(modelPath);
  }

  async act(observation: any): Promise<AgentAction> {
    if (!this.session) throw new Error('Not initialized');

    const view = observation;
    const tensor = this.playerViewToTensor(view);
    const inputTensor = new ort.Tensor('float32', tensor, [1, 14, this.mapHeight + 2, this.mapWidth]);
    const results = await this.session.run({ input: inputTensor });

    const actionTypeIdx = this.argmax(results.action_type.data as Float32Array);
    const targetTileIdx = this.argmax(results.target_tile.data as Float32Array);
    const prodTypeIdx = this.argmax(results.prod_type.data as Float32Array);

    const ACTION_TYPES = ['END_TURN', 'SET_PRODUCTION', 'MOVE', 'LOAD', 'UNLOAD', 'SLEEP', 'WAKE', 'SKIP', 'DISBAND'] as const;
    const UNIT_TYPES = ['army', 'fighter', 'bomber', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship'] as const;

    const actionType = ACTION_TYPES[actionTypeIdx];

    if (actionType === 'MOVE') {
      const x = targetTileIdx % this.mapWidth;
      const y = Math.floor(targetTileIdx / this.mapWidth);
      return { type: 'MOVE', unitId: this.selectMoveableUnit(observation), to: { x, y } };
    }

    if (actionType === 'SET_PRODUCTION') {
      const unitType = UNIT_TYPES[prodTypeIdx] as any;
      return { type: 'SET_PRODUCTION', cityId: this.selectCity(observation), unitType };
    }

    return { type: 'END_TURN' };
  }

  private playerViewToTensor(view: any): Float32Array {
    // Simplified tensor conversion - matches playerViewToTensor from @sc/shared
    const { mapWidth, mapHeight } = this;
    const channels = 14;
    const size = channels * (mapHeight + 2) * mapWidth;
    const tensor = new Float32Array(size);

    // Channel 10: terrain (1 = ocean, 0 = land)
    for (const tile of view.tiles) {
      const idx = (tile.y + 2) * mapWidth + tile.x;
      tensor[10 * (mapHeight + 2) * mapWidth + idx] = tile.terrain === 'ocean' ? 1 : 0;
    }

    // Channel 11: my cities
    for (const city of view.myCities || []) {
      const idx = (city.y + 2) * mapWidth + city.x;
      tensor[11 * (mapHeight + 2) * mapWidth + idx] = 1;
    }

    // Channel 12: enemy cities
    for (const city of (view as any).enemyCities || []) {
      const idx = (city.y + 2) * mapWidth + city.x;
      tensor[12 * (mapHeight + 2) * mapWidth + idx] = 1;
    }

    // Channels 0-8: friendly units by type
    for (const unit of view.myUnits || []) {
      let channel = 0;
      if (unit.type === 'fighter') channel = 1;
      else if (unit.type === 'bomber') channel = 2;
      else if (unit.type === 'transport') channel = 3;
      else if (unit.type === 'destroyer') channel = 4;
      else if (unit.type === 'submarine') channel = 5;
      else if (unit.type === 'carrier') channel = 6;
      else if (unit.type === 'battleship') channel = 7;
      const idx = (unit.y + 2) * mapWidth + unit.x;
      tensor[channel * (mapHeight + 2) * mapWidth + idx] = 1;
    }

    // Channel 8: all friendly units
    for (const unit of view.myUnits || []) {
      const idx = (unit.y + 2) * mapWidth + unit.x;
      tensor[8 * (mapHeight + 2) * mapWidth + idx] = 1;
    }

    // Channel 9: enemy units
    for (const unit of (view as any).visibleEnemyUnits || []) {
      const idx = (unit.y + 2) * mapWidth + unit.x;
      tensor[9 * (mapHeight + 2) * mapWidth + idx] = 1;
    }

    return tensor;
  }

  private argmax(arr: Float32Array): number {
    let maxIdx = 0;
    let maxValue = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > maxValue) { maxValue = arr[i]; maxIdx = i; }
    }
    return maxIdx;
  }

  private selectMoveableUnit(obs: any): string {
    const unit = obs.myUnits?.find((u: any) => u.movesLeft > 0 && !u.sleeping && !u.carriedBy);
    return unit?.id ?? obs.myUnits?.[0]?.id ?? 'unit_0';
  }

  private selectCity(obs: any): string {
    return obs.myCities?.[0]?.id ?? 'city_0';
  }
}

// ── Helper functions ────────────────────────────────────────────────────────

function tournamentSelect(population: Genome[], k = 3): Genome {
  const candidates = population.slice(0, Math.min(k, population.length));
  return candidates.reduce((best, g) => g.fitness > best.fitness ? g : best);
}

function crossover(p1: LayerPerturbation, p2: LayerPerturbation): LayerPerturbation {
  const child: LayerPerturbation = {};
  for (const name in p1) {
    const flat1 = p1[name].data;
    const flat2 = p2[name].data;
    const cut = Math.floor(Math.random() * flat1.length);
    child[name] = { data: [...flat1.slice(0, cut), ...flat2.slice(cut)], shape: p1[name].shape };
  }
  return child;
}

function mutate(perturbations: LayerPerturbation, rate: number, strength: number): LayerPerturbation {
  const mutated: LayerPerturbation = {};
  for (const name in perturbations) {
    const arr = [...perturbations[name].data];
    for (let i = 0; i < arr.length; i++) {
      if (Math.random() < rate) arr[i] += (Math.random() * 2 - 1) * strength;
    }
    mutated[name] = { data: arr, shape: perturbations[name].shape };
  }
  return mutated;
}

function clonePerturbations(perturbations: LayerPerturbation): LayerPerturbation {
  const cloned: LayerPerturbation = {};
  for (const name in perturbations) {
    cloned[name] = { data: [...perturbations[name].data], shape: [...perturbations[name].shape] };
  }
  return cloned;
}

// ── Game evaluation ─────────────────────────────────────────────────────────

async function evaluateGenome(
  modelPath: string,
  gamesPerAgent: number,
  mapWidth: number,
  mapHeight: number,
  maxTurns: number,
): Promise<{ wins: number; draws: number; losses: number }> {
  const nnAgent = new EvolutionNnAgent();
  const basicAgent = new BasicAgent();

  let wins = 0;
  let draws = 0;
  let losses = 0;

  await nnAgent.init(modelPath, { playerId: 'player1', mapWidth, mapHeight });
  basicAgent.init({ playerId: 'player2', mapWidth, mapHeight });

  for (let g = 0; g < gamesPerAgent; g++) {
    const state = createGameState({ width: mapWidth, height: mapHeight });
    let turn = 0;

    while (state.winner === null && turn < maxTurns) {
      turn++;

      if (state.currentPlayer === 'player1') {
        const view = getPlayerView(state, 'player1');
        const action = await nnAgent.act({ ...view, myPlayerId: 'player1' });
        const res = applyAction(state, action, 'player1');
        if (!res.success) applyAction(state, { type: 'END_TURN' }, 'player1');
      } else {
        const view = getPlayerView(state, 'player2');
        const action = basicAgent.act({ ...view, myPlayerId: 'player2' });
        const res = applyAction(state, action, 'player2');
        if (!res.success) applyAction(state, { type: 'END_TURN' }, 'player2');
      }
    }

    if (state.winner === 'player1') wins++;
    else if (state.winner === 'player2') losses++;
    else draws++;
  }

  return { wins, draws, losses };
}

// ── Export perturbed model to ONNX ──────────────────────────────────────────

async function exportPerturbedModel(
  checkpointPath: string,
  perturbations: LayerPerturbation,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', [
      'ai/evolve_export.py',
      '--checkpoint', checkpointPath,
      '--output', outputPath,
      '--perturbations', JSON.stringify(perturbations),
    ], { cwd: path.dirname(__dirname) });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Export failed: ${stderr}`)));
  });
}

// ── Main evolution loop ─────────────────────────────────────────────────────

async function runEvolution(config: EvolutionConfig): Promise<void> {
  console.log(`Loading base checkpoint: ${config.baseCheckpoint}`);

  if (!fs.existsSync(config.baseCheckpoint)) {
    console.error(`ERROR: Checkpoint not found: ${config.baseCheckpoint}`);
    process.exit(1);
  }

  fs.mkdirSync(config.outputDir, { recursive: true });
  const tempDir = path.join(tmpdir(), 'nn_evolution');
  fs.mkdirSync(tempDir, { recursive: true });

  // Load checkpoint to get layer structure for perturbations
  console.log('Loading checkpoint metadata...');
  const metaJson = execSync(
    `python -c "import torch; ckpt=torch.load('${config.baseCheckpoint}', weights_only=False); print(json.dumps({k: list(v.shape) for k,v in ckpt['model_state'].items()}))"`,
    { cwd: path.dirname(__dirname), encoding: 'utf8' }
  );
  const layerShapes = JSON.parse(metaJson.trim());

  // Initialize population
  console.log(`Initializing population of ${config.populationSize}...`);
  const population: Genome[] = [];

  for (let i = 0; i < config.populationSize; i++) {
    const perturbations: LayerPerturbation = {};
    for (const [name, shape] of Object.entries(layerShapes)) {
      const size = (shape as number[]).reduce((a, b) => a * b, 1);
      perturbations[name] = {
        data: new Array(size).fill(0).map(() => (Math.random() * 2 - 1) * config.scale),
        shape: shape as number[],
      };
    }
    population.push({ id: randomUUID().slice(0, 8), perturbations, fitness: 0 });
  }

  console.log(`Starting evolution: ${config.generations} generations...`);
  console.log(`  Games per agent: ${config.gamesPerAgent}, Workers: ${config.workers}`);

  for (let gen = 0; gen < config.generations; gen++) {
    console.log(`\nGeneration ${gen + 1}/${config.generations}`);

    // Export all genomes to ONNX
    console.log('  Exporting models to ONNX...');
    const onnxPaths: { genomeId: number; path: string }[] = [];

    for (let i = 0; i < population.length; i++) {
      const onnxPath = path.join(tempDir, `gen${gen}_genome${i}.onnx`);
      onnxPaths.push({ genomeId: i, path: onnxPath });
      await exportPerturbedModel(config.baseCheckpoint, population[i].perturbations, onnxPath);
    }

    // Evaluate all genomes
    console.log('  Evaluating genomes...');
    const results = await Promise.all(
      onnxPaths.map(({ genomeId, path }) =>
        evaluateGenome(path, config.gamesPerAgent, config.mapWidth, config.mapHeight, config.maxTurns)
          .then(({ wins, draws, losses }) => ({ genomeId, wins, draws, losses }))
      )
    );

    // Update fitness
    for (const result of results) {
      const genome = population[result.genomeId];
      const total = result.wins + result.draws + result.losses;
      genome.fitness = (result.wins + 0.5 * result.draws) / total;
      console.log(`  Genome ${result.genomeId}: ${result.wins}W-${result.draws}D-${result.losses}L (fitness: ${genome.fitness.toFixed(4)})`);
    }

    // Report best
    const best = population.reduce((a, b) => a.fitness > b.fitness ? a : b);
    const meanFitness = population.reduce((sum, g) => sum + g.fitness, 0) / population.length;
    console.log(`  Best: ${best.fitness.toFixed(4)}, Mean: ${meanFitness.toFixed(4)}`);

    // Save checkpoint
    if (best.fitness > 0.5) {
      const checkpointPath = path.join(config.outputDir, `checkpoint_gen${gen}.json`);
      fs.writeFileSync(checkpointPath, JSON.stringify({
        genomeId: best.id, generation: gen, fitness: best.fitness,
        perturbations: clonePerturbations(best.perturbations),
      }, null, 2));
      console.log(`  Saved checkpoint: ${checkpointPath}`);
    }

    // Cleanup
    for (const { path } of onnxPaths) { if (fs.existsSync(path)) fs.unlinkSync(path); }

    // Next generation
    population.sort((a, b) => b.fitness - a.fitness);
    const newPopulation: Genome[] = population.slice(0, config.elitism).map(g => ({
      ...g, perturbations: clonePerturbations(g.perturbations), generation: gen + 1,
    }));

    while (newPopulation.length < config.populationSize) {
      const parent1 = tournamentSelect(population);
      const parent2 = tournamentSelect(population);
      const childPerturbations = crossover(parent1.perturbations, parent2.perturbations);
      const mutatedPerturbations = mutate(childPerturbations, config.mutationRate, config.mutationStrength);
      newPopulation.push({ id: randomUUID().slice(0, 8), perturbations: mutatedPerturbations, fitness: 0, generation: gen + 1 });
    }

    population.length = 0;
    population.push(...newPopulation);
  }

  // Save champion
  const champion = population.reduce((a, b) => a.fitness > b.fitness ? a : b);
  const championPath = path.join(config.outputDir, 'champion.json');
  fs.writeFileSync(championPath, JSON.stringify({
    genomeId: champion.id, generation: config.generations, fitness: champion.fitness,
    perturbations: clonePerturbations(champion.perturbations),
  }, null, 2));

  console.log(`\nEvolution complete. Champion: ${championPath} (fitness: ${champion.fitness.toFixed(4)})`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(): EvolutionConfig {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = process.argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      }
    }
  }
  return {
    baseCheckpoint: args.base!,
    populationSize: parseInt(args.pop ?? '30'),
    generations: parseInt(args.gens ?? '50'),
    gamesPerAgent: parseInt(args.gamesPerAgent ?? '5'),
    workers: parseInt(args.workers ?? '8'),
    elitism: parseInt(args.elitism ?? '2'),
    scale: parseFloat(args.scale ?? '0.1'),
    mutationRate: parseFloat(args.mutationRate ?? '0.05'),
    mutationStrength: parseFloat(args.mutationStrength ?? '0.1'),
    outputDir: args.output ?? './ai/evolved',
    mapWidth: parseInt(args.mapWidth ?? '50'),
    mapHeight: parseInt(args.mapHeight ?? '20'),
    maxTurns: parseInt(args.maxTurns ?? '300'),
  };
}

if (isMainThread) {
  const config = parseArgs();
  runEvolution(config).catch(err => { console.error(err); process.exit(1); });
}

export { runEvolution };
