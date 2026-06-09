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

class StableStockfish {
  constructor() {
    this.engine = null;
    this.buffer = '';
    this.ready = false;
    this.queue = Promise.resolve();
    this.current = null;
    this.restartCount = 0;
    this.start();
  }

  start() {
    this.kill();

    this.engine = spawn(stockfishPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    this.ready = false;
    this.current = null;
    this.restartCount += 1;

    this.engine.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      const parts = this.buffer.split(/\r?\n/);
      this.buffer = parts.pop() || '';
      for (const raw of parts) this.handleLine(raw.trim());
    });

    this.engine.stderr.on('data', chunk => {
      console.error('[stockfish stderr]', chunk.toString());
    });

    this.engine.on('error', err => {
      console.error('[stockfish error]', err);
      this.failCurrent(new Error('Stockfish process error'));
      setTimeout(() => this.start(), 500);
    });

    this.engine.on('exit', code => {
      console.error('[stockfish exit]', code);
      this.ready = false;
      this.failCurrent(new Error('Stockfish exited'));
      setTimeout(() => this.start(), 800);
    });

    this.send('uci');
  }

  kill() {
    if (this.engine) {
      try { this.engine.kill('SIGKILL'); } catch {}
    }
    this.engine = null;
  }

  send(cmd) {
    if (!this.engine || this.engine.killed) return;
    this.engine.stdin.write(cmd + '\n');
  }

  handleLine(line) {
    if (!line) return;

    if (line === 'uciok') {
      this.send('setoption name Threads value 1');
      this.send('setoption name Hash value 16');
      this.send('isready');
      return;
    }

    if (line === 'readyok') {
      this.ready = true;
      return;
    }

    if (!this.current) return;

    this.parseInfo(line);

    if (line.startsWith('bestmove ')) {
      const bestmove = line.split(/\s+/)[1];
      const current = this.current;
      this.current = null;
      clearTimeout(current.timer);

      current.resolve({
        ok: true,
        engine: 'Stable Server Stockfish',
        bestmove,
        movetime: current.movetime,
        multipv: current.multipv,
        lines: [...current.lines.values()]
          .sort((a, b) => a.multipv - b.multipv)
          .filter(x => Array.isArray(x.pv) && x.pv.length > 0),
        restartCount: this.restartCount,
      });
    }
  }

  parseInfo(line) {
    if (!line.startsWith('info ') || !this.current) return;

    const mp = Number((line.match(/\bmultipv\s+(\d+)/) || [])[1] || 1);
    const item = this.current.lines.get(mp) || { multipv: mp };
    const depth = (line.match(/\bdepth\s+(\d+)/) || [])[1];
    const cp = (line.match(/\bscore\s+cp\s+(-?\d+)/) || [])[1];
    const mate = (line.match(/\bscore\s+mate\s+(-?\d+)/) || [])[1];
    const pv = (line.match(/\bpv\s+(.+)$/) || [])[1];

    if (depth) item.depth = Number(depth);
    if (cp) item.score = { type: 'cp', value: Number(cp) };
    if (mate) item.score = { type: 'mate', value: Number(mate) };
    if (pv) item.pv = pv.trim().split(/\s+/);

    this.current.lines.set(mp, item);
  }

  failCurrent(err) {
    if (!this.current) return;
    const c = this.current;
    this.current = null;
    clearTimeout(c.timer);
    c.reject(err);
  }

  analyse({ fen, movetime = 1000, multipv = 1 }) {
    this.queue = this.queue.then(() => this._analyse({ fen, movetime, multipv })).catch(err => {
      console.error('[queue error]', err);
      throw err;
    });
    return this.queue;
  }

  _analyse({ fen, movetime, multipv }) {
    return new Promise((resolve, reject) => {
      if (!fen || typeof fen !== 'string') {
        reject(new Error('FEN is required'));
        return;
      }

      // Render Free is weak. These caps are intentional for stability.
      movetime = Math.max(300, Math.min(Number(movetime) || 1000, 5000));
      multipv = Math.max(1, Math.min(Number(multipv) || 1, 3));

      if (!this.engine || this.engine.killed) this.start();

      const waitUntilReady = () => {
        if (this.ready) {
          this.current = {
            resolve,
            reject,
            fen,
            movetime,
            multipv,
            lines: new Map(),
            timer: null,
          };

          this.current.timer = setTimeout(() => {
            const msg = `Stockfish timeout after ${movetime} ms`;
            console.error(msg);
            this.failCurrent(new Error(msg));
            this.start();
          }, movetime + 6000);

          this.send('stop');
          this.send('isready');
          setTimeout(() => {
            this.send(`setoption name MultiPV value ${multipv}`);
            this.send('ucinewgame');
            this.send(`position fen ${fen}`);
            this.send(`go movetime ${movetime}`);
          }, 70);

          return;
        }

        setTimeout(waitUntilReady, 100);
      };

      waitUntilReady();
    });
  }
}

const engine = new StableStockfish();

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: 'stable-server-stockfish',
    path: stockfishPath(),
    ready: engine.ready,
    restartCount: engine.restartCount,
  });
});

app.post('/api/bestmove', async (req, res) => {
  try {
    const result = await engine.analyse({
      fen: req.body?.fen,
      movetime: req.body?.movetime || 1000,
      multipv: req.body?.multipv || 1,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Chess Helper v10 stable server on port ' + PORT));
