import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import { type Genome, genomeToJSON, genomeFromJSON } from './genetics/genome.js';
import {
  initPopulation,
  nextGeneration,
  type PopulationConfig,
  type RankedAgent,
} from './genetics/population.js';
import { runTournament, type TournamentConfig } from './tournament.js';

// ── CLI argument parsing ─────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    pop: { type: 'string', default: '50' },
    gens: { type: 'string', default: '100' },
    workers: { type: 'string', default: String(Math.max(1, os.cpus().length - 1)) },
    games: { type: 'string', default: '4' },
    out: { type: 'string', default: 'champion.json' },
    resume: { type: 'string' },
    elite: { type: 'string', default: '5' },
    'mutation-rate': { type: 'string', default: '0.15' },
    'mutation-strength': { type: 'string', default: '0.3' },
    'map-width': { type: 'string', default: '30' },
    'map-height': { type: 'string', default: '20' },
    'max-turns': { type: 'string', default: '200' },
    parallel: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Strategic Conquest — AI Trainer

Usage:
  npx tsx packages/trainer/src/index.ts [options]

Options:
  --pop <n>               Population size (default: 50)
  --gens <n>              Number of generations (default: 100)
  --workers <n>           Worker threads for parallel eval (default: CPU count - 1)
  --games <n>             Games per agent per generation (default: 4)
  --out <path>            Output champion genome file (default: champion.json)
  --resume <path>         Resume from a checkpoint JSON file
  --elite <n>             Number of elite survivors per generation (default: 5)
  --mutation-rate <f>     Per-gene mutation probability (default: 0.15)
  --mutation-strength <f> Gaussian noise sigma (default: 0.3)
  --map-width <n>         Training map width (default: 30)
  --map-height <n>        Training map height (default: 20)
  --max-turns <n>         Max turns per game (default: 200)
  --parallel              Use worker threads for evaluation
  -h, --help              Show this help
`);
  process.exit(0);
}

// ── Configuration ────────────────────────────────────────────

const popSize = parseInt(args.pop!, 10);
const generations = parseInt(args.gens!, 10);
const gamesPerAgent = parseInt(args.games!, 10);
const eliteCount = parseInt(args.elite!, 10);
const mutationRate = parseFloat(args['mutation-rate']!);
const mutationStrength = parseFloat(args['mutation-strength']!);
const mapWidth = parseInt(args['map-width']!, 10);
const mapHeight = parseInt(args['map-height']!, 10);
const maxTurns = parseInt(args['max-turns']!, 10);
const outputPath = args.out!;
const useParallel = args.parallel!;

const popConfig: PopulationConfig = {
  size: popSize,
  eliteCount,
  mutationRate,
  mutationStrength,
};

const tournamentConfig: TournamentConfig = {
  gamesPerAgent,
  runnerOpts: { mapWidth, mapHeight, maxTurns },
  vsBaseline: true,
};

// ── Main training loop ───────────────────────────────────────

async function main() {
  console.log('=== Strategic Conquest AI Trainer ===');
  console.log(`Population: ${popSize}, Generations: ${generations}, Games/agent: ${gamesPerAgent}`);
  console.log(`Map: ${mapWidth}x${mapHeight}, Max turns: ${maxTurns}`);
  console.log(`Mutation rate: ${mutationRate}, strength: ${mutationStrength}`);
  console.log(`Elite count: ${eliteCount}`);
  console.log(`Mode: ${useParallel ? 'parallel workers' : 'sequential'}`);
  console.log('');

  // Initialize or resume population
  let population: Genome[];
  let startGen = 1;

  if (args.resume) {
    console.log(`Resuming from ${args.resume}...`);
    const checkpoint = JSON.parse(fs.readFileSync(args.resume, 'utf-8'));
    population = checkpoint.population.map((g: { weights: number[] }) =>
      genomeFromJSON(JSON.stringify(g)),
    );
    startGen = (checkpoint.generation ?? 0) + 1;
    console.log(`Loaded ${population.length} genomes, starting at generation ${startGen}`);
  } else {
    population = initPopulation(popConfig);
  }

  let bestEverFitness = -Infinity;
  let bestEverGenome: Genome | null = null;

  for (let gen = startGen; gen <= generations; gen++) {
    const genStart = Date.now();

    // Evaluate population
    let ranked: RankedAgent[];

    if (useParallel) {
      // Dynamic import for parallel evaluation (uses worker_threads)
      const { evaluateParallel } = await import('./parallel.js');
      ranked = await evaluateParallel(population, {
        workerCount: parseInt(args.workers!, 10),
        gamesPerAgent,
        runnerOpts: tournamentConfig.runnerOpts,
        vsBaseline: true,
      });
    } else {
      ranked = await runTournament(population, tournamentConfig);
    }

    const genTime = ((Date.now() - genStart) / 1000).toFixed(1);
    const best = ranked[0];
    const mean = ranked.reduce((s, r) => s + r.fitness, 0) / ranked.length;
    const worst = ranked[ranked.length - 1];

    console.log(
      `Gen ${String(gen).padStart(4)} | ` +
      `Best: ${best.fitness.toFixed(3).padStart(8)} | ` +
      `Mean: ${mean.toFixed(3).padStart(8)} | ` +
      `Worst: ${worst.fitness.toFixed(3).padStart(8)} | ` +
      `${genTime}s`,
    );

    // Track all-time best
    if (best.fitness > bestEverFitness) {
      bestEverFitness = best.fitness;
      bestEverGenome = best.genome;
    }

    // Save checkpoint every 25 generations
    if (gen % 25 === 0) {
      const checkpointPath = `checkpoint_gen_${gen}.json`;
      const checkpoint = {
        generation: gen,
        bestFitness: best.fitness,
        meanFitness: mean,
        population: population,
      };
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
      console.log(`  → Checkpoint saved: ${checkpointPath}`);
    }

    // Evolve next generation (unless this is the last)
    if (gen < generations) {
      population = nextGeneration(ranked, popConfig);
    }
  }

  // Save champion
  if (bestEverGenome) {
    fs.writeFileSync(outputPath, genomeToJSON(bestEverGenome));
    console.log('');
    console.log(`Champion saved to ${outputPath} (fitness: ${bestEverFitness.toFixed(3)})`);
  }

  console.log('Training complete.');
}

main().catch((err) => {
  console.error('Training failed:', err);
  process.exit(1);
});
