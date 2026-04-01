/**
 * Performance profiler for data collection
 * Runs games and generates CPU profile for bottleneck analysis
 */

import { performance } from 'node:perf_hooks';
import { BasicAgent } from '@sc/shared';
import { runGame } from '@sc/testing';
import fs from 'fs';
import path from 'path';

const NUM_GAMES = parseInt(process.env.NUM_GAMES ?? '1');
const MAX_TURNS = parseInt(process.env.MAX_TURNS ?? '300');
const DATA_DIR = process.env.DATA_DIR ?? './data';
const PROFILE_OUTPUT = path.join(DATA_DIR, 'profile.json');

interface TimingStats {
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

interface PhaseTimings {
  init: number;
  turnLoop: number;
  getPlayerView: number;
  applyAction: number;
  agentAct: number;
}

function profileGameCollection(): void {
  const timings: number[] = [];
  const perGameStats: { game: number; turns: number; ms: number; phases: PhaseTimings }[] = [];

  console.log(`Profiling ${NUM_GAMES} game(s), max ${MAX_TURNS} turns each...`);
  const totalStart = performance.now();

  for (let g = 0; g < NUM_GAMES; g++) {
    const phaseAccumulator: PhaseTimings = { init: 0, turnLoop: 0, getPlayerView: 0, applyAction: 0, agentAct: 0 };
    const initStart = performance.now();
    const agent1 = new BasicAgent();
    const agent2 = new BasicAgent();
    phaseAccumulator.init += performance.now() - initStart;

    const gameStart = performance.now();
    const result = runGame(agent1, agent2, { maxTurns: MAX_TURNS, profilePhases: phaseAccumulator });
    const gameEnd = performance.now();

    const elapsed = gameEnd - gameStart;
    timings.push(elapsed);

    perGameStats.push({
      game: g + 1,
      turns: result.turns,
      ms: elapsed,
      phases: phaseAccumulator,
    });

    const turns = result.turns;
    console.log(`  Game ${g + 1}: ${turns} turns in ${elapsed.toFixed(2)}ms (${(elapsed/turns).toFixed(2)}ms/turn)`);
  }

  const totalElapsed = performance.now() - totalStart;

  // Calculate stats
  const sorted = [...timings].sort((a, b) => a - b);
  const stats: TimingStats = {
    totalMs: totalElapsed,
    avgMs: timings.reduce((a, b) => a + b, 0) / timings.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };

  const totalTurns = perGameStats.reduce((a, b) => a + b.turns, 0);

  console.log('\n=== Performance Summary ===');
  console.log(`Total time: ${stats.totalMs.toFixed(2)}ms`);
  console.log(`Games/second: ${(NUM_GAMES / (stats.totalMs / 1000)).toFixed(2)}`);
  console.log(`Per game: avg=${stats.avgMs.toFixed(2)}ms, min=${stats.minMs.toFixed(2)}ms, max=${stats.maxMs.toFixed(2)}ms`);
  console.log(`Per turn: avg=${(stats.avgMs / (totalTurns / NUM_GAMES)).toFixed(2)}ms`);

  // Aggregate phase timings across all games
  const totalPhases: PhaseTimings = { init: 0, turnLoop: 0, getPlayerView: 0, applyAction: 0, agentAct: 0 };
  for (const gs of perGameStats) {
    totalPhases.init += gs.phases.init;
    totalPhases.turnLoop += gs.phases.turnLoop;
    totalPhases.getPlayerView += gs.phases.getPlayerView;
    totalPhases.applyAction += gs.phases.applyAction;
    totalPhases.agentAct += gs.phases.agentAct;
  }

  if (totalPhases.init > 0) {
    console.log('\n=== Phase Breakdown (per turn avg) ===');
    const turns = totalTurns / NUM_GAMES;
    console.log(`  getPlayerView: ${(totalPhases.getPlayerView / turns).toFixed(2)}ms`);
    console.log(`  applyAction:   ${(totalPhases.applyAction / turns).toFixed(2)}ms`);
    console.log(`  agent.act():   ${(totalPhases.agentAct / turns).toFixed(2)}ms`);
    console.log(`  turn loop overhead: ${(totalPhases.turnLoop / turns).toFixed(2)}ms`);
  }

  // Save detailed stats
  const output = {
    numGames: NUM_GAMES,
    maxTurns: MAX_TURNS,
    stats,
    perGame: perGameStats.map(({ phases, ...rest }) => ({
      ...rest,
      phases: {
        getPlayerView: phases.getPlayerView,
        applyAction: phases.applyAction,
        agentAct: phases.agentAct,
        turnLoopOverhead: phases.turnLoop,
      },
    })),
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const statsFile = path.join(DATA_DIR, 'profile_stats.json');
  fs.writeFileSync(statsFile, JSON.stringify(output, null, 2));
  console.log(`\nDetailed stats saved to ${statsFile}`);
}

async function main(): Promise<void> {
  profileGameCollection();
}

main().catch(console.error);
