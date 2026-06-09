import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function stockfishPath() {
  for (const p of [process.env.STOCKFISH_PATH, '/usr/games/stockfish', '/usr/bin/stockfish', 'stockfish'].filter(Boolean)) {
    if (p === 'stockfish') return p;
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'stockfish';
}

function parseInfo(line, map) {
  if (!line.startsWith('info ')) return;
  const mp = Number((line.match(/\bmultipv\s+(\d+)/) || [])[1] || 1);
  const item = map.get(mp) || { multipv: mp };
  const depth = (line.match(/\bdepth\s+(\d+)/) || [])[1];
  const cp = (line.match(/\bscore\s+cp\s+(-?\d+)/) || [])[1];
  const mate = (line.match(/\bscore\s+mate\s+(-?\d+)/) || [])[1];
  const pv = (line.match(/\bpv\s+(.+)$/) || [])[1];
  if (depth) item.depth = Number(depth);
  if (cp) item.score = { type: 'cp', value: Number(cp) };
  if (mate) item.score = { type: 'mate', value: Number(mate) };
  if (pv) item.pv = pv.trim().split(/\s+/);
  map.set(mp, item);
}

function runStockfish({ fen, movetime = 3000, multipv = 3 }) {
  return new Promise((resolve, reject) => {
    if (!fen || typeof fen !== 'string') return reject(new Error('FEN is required'));
    movetime = Math.max(300, Math.min(Number(movetime) || 3000, 15000));
    multipv = Math.max(1, Math.min(Number(multipv) || 3, 5));

    const engine = spawn(stockfishPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = new Map();
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { engine.kill('SIGKILL'); } catch {}
      reject(new Error('Stockfish timeout'));
    }, movetime + 9000);

    const send = cmd => { if (!engine.killed) engine.stdin.write(cmd + '\n'); };

    engine.stdout.on('data', chunk => {
      for (const raw of chunk.toString().split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;

        parseInfo(line, lines);

        if (line === 'uciok') {
          send('setoption name Threads value 1');
          send('setoption name Hash value 128');
          send(`setoption name MultiPV value ${multipv}`);
          send('isready');
        }

        if (line === 'readyok') {
          send('ucinewgame');
          send(`position fen ${fen}`);
          send(`go movetime ${movetime}`);
        }

        if (line.startsWith('bestmove ')) {
          done = true;
          clearTimeout(timer);
          try { engine.kill(); } catch {}
          resolve({
            ok: true,
            engine: 'Server Stockfish',
            bestmove: line.split(/\s+/)[1],
            movetime,
            multipv,
            lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv).filter(x => x.pv?.length)
          });
        }
      }
    });

    engine.stderr.on('data', () => {});
    engine.on('error', err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('Stockfish start error: ' + err.message));
    });
    engine.on('exit', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('Stockfish exited early: ' + code));
    });

    send('uci');
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: 'server-stockfish', path: stockfishPath() });
});

app.post('/api/bestmove', async (req, res) => {
  try { res.json(await runStockfish(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Chess Helper v9 server on port ' + PORT));
