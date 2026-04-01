/**
 * Test replay picker + standalone test replay server.
 *
 * 1. Runs all test_*.ts files to generate test data
 * 2. Lists generated test replays, lets you pick one.
 * 3. Starts a minimal HTTP server (port 4002) serving:
 *    - /api/test-replays       — list of test replay metadata
 *    - /api/test-replays/:id   — full test replay JSON
 *    - everything else         — built client static files
 * 4. Opens the browser to the selected test replay.
 * 5. Stays alive until Ctrl+C.
 *
 * Usage:
 *   npm run test_replay
 *   TEST_REPLAY_PORT=4003 npm run test_replay
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_REPLAY_DIR  = process.env.TEST_REPLAY_DIR ?? path.resolve(__dirname, '..', '..', '..', 'tmp');
const TEST_REPLAY_PORT = parseInt(process.env.TEST_REPLAY_PORT ?? '4002');

// Built client lives at packages/server/public/
const CLIENT_DIR = path.resolve(__dirname, '..', '..', 'server', 'public');

// Test files are at packages/shared/src/
const SHARED_SRC_DIR = path.resolve(__dirname, '..', '..', 'shared', 'src');

// ── Load test replays ─────────────────────────────────────────

interface TestReplayMeta {
  id: string;
  testName?: string;
  recordedAt: string;
  turns: number;
  winner: string | null;
  p1Cities: number;
  p2Cities: number;
  neutralCities: number;
  mapWidth: number;
  mapHeight: number;
  frames: number;
  p1Agent?: string;
  p2Agent?: string;
}

function loadTestReplayMetas(): TestReplayMeta[] {
  const replayDir = path.isAbsolute(TEST_REPLAY_DIR) ? TEST_REPLAY_DIR : path.resolve(__dirname, TEST_REPLAY_DIR);
  if (!fs.existsSync(replayDir)) return [];
  const files = fs.readdirSync(replayDir).filter((f) => f.startsWith('test-') && f.endsWith('.json'));
  const metas: TestReplayMeta[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(replayDir, f), 'utf-8'));
      if (raw.meta) metas.push(raw.meta);
    } catch { /* skip corrupt files */ }
  }
  return metas.sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
}

// ── Clean old test replays ────────────────────────────────────

const replayDir = path.isAbsolute(TEST_REPLAY_DIR) ? TEST_REPLAY_DIR : path.resolve(__dirname, TEST_REPLAY_DIR);
if (fs.existsSync(replayDir)) {
  const oldTestReplays = fs.readdirSync(replayDir).filter((f) => f.startsWith('test-') && f.endsWith('.json'));
  for (const f of oldTestReplays) {
    fs.unlinkSync(path.join(replayDir, f));
  }
}

console.log('Running test generators...\n');
const testFiles = [
  'test_armyMoveToCoastAndBoardTransport.ts',
  'test_armyMoveToCoastAndBoardTransport_2.ts',
  'test_battleshipPriorities.ts',
  'test_bomberDecision.ts',
  'test_destroyerChasingTransport.ts',
  'test_exploreAndExpand_3.ts',
  'test_transportEarlyDeparture.ts',
  'test_transportsInCombatPhase.ts',
];

for (const testFile of testFiles) {
  const testPath = path.join(SHARED_SRC_DIR, testFile);
  console.log(`Running: ${testFile}`);
  try {
    execSync(`npx tsx "${testPath}"`, { stdio: 'inherit' });
    console.log(`✓ ${testFile} completed\n`);
  } catch (err: any) {
    console.log(`✗ ${testFile} failed: ${err.message || err}\n`);
  }
}
console.log('\nAll tests completed.\n');

const metas = loadTestReplayMetas();
if (metas.length === 0) {
  console.log(`No test replays found in ${TEST_REPLAY_DIR}.`);
  console.log('Run: npx tsx packages/shared/src/test_armyMoveToCoastAndBoardTransport.ts');
  process.exit(0);
}

// Auto-select the first (most recent) replay
const chosen = metas[0];
startServerAndOpen(chosen.id);

// ── Minimal HTTP server ───────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
};

function serveFile(res: http.ServerResponse, filepath: string) {
  if (!fs.existsSync(filepath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(filepath);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filepath).pipe(res);
}

function startServerAndOpen(replayId: string) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${TEST_REPLAY_PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');

    // GET /api/replays — list metas
    if (pathname === '/api/replays') {
      const freshMetas = loadTestReplayMetas();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replays: freshMetas }));
      return;
    }

    // GET /api/replays/:id — serve replay file (with or without .json)
    const replayMatch = pathname.match(/^\/api\/replays\/(.+?)(\.json)?$/);
    if (replayMatch) {
      const id = replayMatch[1];
      const filepath = path.join(TEST_REPLAY_DIR, `${id}.json`);
      serveFile(res, filepath);
      return;
    }

    // Static client files — serve index.html for SPA routes
    let filePath = path.join(CLIENT_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(CLIENT_DIR, 'index.html');
    }
    serveFile(res, filePath);
  });

  server.listen(TEST_REPLAY_PORT, () => {
    const url = `http://localhost:${TEST_REPLAY_PORT}/?testReplay=${replayId}`;
    console.log(`\nTest replay server running at http://localhost:${TEST_REPLAY_PORT}`);
    console.log(`Opening: ${url}`);
    console.log('Press Ctrl+C to quit.\n');
    try {
      execSync(`open "${url}"`);
    } catch {
      console.log('(Could not open browser automatically — paste the URL above)');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${TEST_REPLAY_PORT} is in use. Try: TEST_REPLAY_PORT=4003 npm run test_replay`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
