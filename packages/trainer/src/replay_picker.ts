/**
 * Interactive replay picker + standalone replay server.
 *
 * 1. Lists saved replays, lets you pick one.
 * 2. Starts a minimal HTTP server (port 4001) serving:
 *    - /api/replays          — list of replay metadata
 *    - /api/replays/:id      — full replay JSON
 *    - everything else       — built client static files
 * 3. Opens the browser to the selected replay.
 * 4. Stays alive until Ctrl+C.
 *
 * Usage:
 *   npm run replay
 *   REPLAY_PORT=4002 npm run replay
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { ReplayMeta } from './replayUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPLAY_DIR  = process.env.REPLAY_DIR  ?? '../../tmp';
const REPLAY_PORT = parseInt(process.env.REPLAY_PORT ?? '4001');

// Built client lives at packages/server/public/
const CLIENT_DIR = path.resolve(__dirname, '..', '..', 'server', 'public');

// ── Load metas ────────────────────────────────────────────────

function loadMetas(): ReplayMeta[] {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  const files = fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json'));
  const metas: ReplayMeta[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, f), 'utf-8'));
      if (raw.meta) metas.push(raw.meta);
    } catch { /* skip corrupt files */ }
  }
  return metas.sort((a, b) => (a.gameNum ?? 0) - (b.gameNum ?? 0));
}

const metas = loadMetas();
if (metas.length === 0) {
  console.log(`No replays found in ${REPLAY_DIR}.`);
  console.log('Run: npm run record');
  process.exit(0);
}

console.log(`\nAvailable replays (${metas.length}):`);
metas.forEach((m, i) => {
  const date = m.recordedAt.slice(0, 19).replace('T', ' ');
  const winner = m.winner ?? 'draw';
  const gameLabel = m.gameNum != null ? `game ${m.gameNum}` : m.id.slice(0, 8);
  console.log(`  ${i + 1}. [${gameLabel}] ${date}  turns=${m.turns}  winner=${winner}  p1=${m.p1Cities} p2=${m.p2Cities} neutral=${m.neutralCities}`);
});

// ── Interactive pick ──────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nEnter number to view (or q to quit): ', (answer) => {
  rl.close();
  if (answer.trim() === 'q' || answer.trim() === '') process.exit(0);

  const idx = parseInt(answer) - 1;
  if (isNaN(idx) || idx < 0 || idx >= metas.length) {
    console.log('Invalid selection.');
    process.exit(1);
  }

  const chosen = metas[idx];
  startServerAndOpen(chosen.id);
});

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
    const url = new URL(req.url ?? '/', `http://localhost:${REPLAY_PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');

    // GET /api/replays — list metas
    if (pathname === '/api/replays') {
      const freshMetas = loadMetas();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replays: freshMetas }));
      return;
    }

    // GET /api/replays/:id — serve replay file
    const replayMatch = pathname.match(/^\/api\/replays\/([\w-]{8,64})$/);
    if (replayMatch) {
      const id = replayMatch[1];
      const filepath = path.join(REPLAY_DIR, `${id}.json`);
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

  server.listen(REPLAY_PORT, () => {
    const url = `http://localhost:${REPLAY_PORT}/?replay=${replayId}`;
    console.log(`\nReplay server running at http://localhost:${REPLAY_PORT}`);
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
      console.error(`Port ${REPLAY_PORT} is in use. Try: REPLAY_PORT=4002 npm run replay`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
