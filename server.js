'use strict';

// Load settings from a .env file next to this script, if there is one (needs Node 20.12+; otherwise skipped).
// Real environment variables (shell, pm2) take precedence over the file.
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(require('path').join(__dirname, '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`Could not read .env: ${e.message}`);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./src/db');
const downloader = require('./src/downloader');
const { parseMaster, LANGS } = require('./src/parser');
const tmdb = require('./src/tmdb');
const { normalizeHeaders } = require('./src/headers');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const APP_USER = process.env.APP_USER || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const app = express();
app.disable('x-powered-by');

// Optional HTTP basic auth. Set APP_PASSWORD (and optionally APP_USER) to enable it.
if (APP_PASSWORD) {
  const safeEq = (a, b) => {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  };
  app.use((req, res, next) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (m) {
      const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
      const p = rest.join(':');
      if (safeEq(u, APP_USER || 'admin') && safeEq(p, APP_PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Downloader"').status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- validation ----------

function cleanUrl(v, field, { required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (required) throw new Error(`${field} is required.`);
    return null;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${field} is not a valid URL.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${field} must start with http:// or https://`);
  }
  return s;
}

function validateItem(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('Name is required.');
  if (name.length > 200) throw new Error('Name is too long (max 200 characters).');

  const video_url = cleanUrl(body.video_url, 'Video URL', { required: true });
  const tmdb_url = cleanUrl(body.tmdb_url, 'TMDB link');
  const imdb_url = cleanUrl(body.imdb_url, 'IMDb link');
  const referer = cleanUrl(body.referer, 'Referer');

  const audios = [];
  const seen = new Set();
  for (const a of Array.isArray(body.audios) ? body.audios : []) {
    const lang = String(a.lang || '').toLowerCase();
    if (!LANGS[lang]) throw new Error('Audio language must be Hindi, English or Telugu.');
    const url = cleanUrl(a.url, `${LANGS[lang].label} audio URL`);
    if (!url) continue; // empty row, skip
    if (seen.has(lang)) throw new Error(`${LANGS[lang].label} audio was added twice.`);
    seen.add(lang);
    audios.push({ lang, url });
  }

  const resolution = typeof body.resolution === 'string' && /^\d{2,5}x\d{2,5}$/.test(body.resolution)
    ? body.resolution : null;

  const headers = normalizeHeaders(body.headers, referer);

  return { name, video_url, tmdb_url, imdb_url, referer: null, headers, audios, resolution };
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// ---------- API ----------

app.get('/api/config', (req, res) => {
  res.json({ downloadDir: downloader.DOWNLOAD_DIR, maxConcurrent: downloader.MAX_CONCURRENT });
});

// Look up a movie/show name from a TMDB link.
app.get('/api/tmdb', async (req, res) => {
  try {
    res.json(await tmdb.lookup(req.query.url));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/items', (req, res) => {
  res.json(db.listItems());
});

// Paste a whole master.m3u8, get back the best video + hi/en/te audio URLs.
app.post('/api/parse', wrap((req, res) => {
  res.json(parseMaster(req.body.text, req.body.baseUrl));
}));

app.post('/api/items', wrap((req, res) => {
  const data = validateItem(req.body);
  const start = req.body.start !== false;
  const item = db.createItem({ ...data, status: 'saved' });
  if (start) downloader.enqueue(item.id);
  res.status(201).json(db.getItem(item.id));
}));

function withItem(fn) {
  return wrap((req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = db.getItem(id);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    fn(item, req, res);
  });
}

// Start a saved item, or retry a failed/cancelled one.
app.post('/api/items/:id/start', withItem((item, req, res) => {
  if (['downloading', 'muxing', 'queued'].includes(item.status)) {
    return res.status(409).json({ error: 'Already queued or running.' });
  }
  // Optionally replace the request headers first (used when a download was refused with 403).
  if (typeof req.body?.headers === 'string') {
    db.updateItem(item.id, { headers: normalizeHeaders(req.body.headers, item.referer) });
  }
  downloader.enqueue(item.id);
  res.json(db.getItem(item.id));
}));

app.post('/api/items/:id/cancel', withItem((item, req, res) => {
  if (!downloader.cancel(item.id)) return res.status(409).json({ error: 'Nothing to cancel.' });
  res.json({ ok: true });
}));

app.delete('/api/items/:id', withItem((item, req, res) => {
  if (downloader.isRunning(item.id)) downloader.cancel(item.id);
  if (req.query.files === '1' && item.output_file) {
    const target = path.resolve(downloader.DOWNLOAD_DIR, item.output_file);
    // never delete outside the download dir
    if (path.dirname(target) === downloader.DOWNLOAD_DIR) fs.rmSync(target, { force: true });
  }
  db.deleteItem(item.id);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Downloader listening on http://${HOST}:${PORT}`);
  console.log(`Saving files to ${downloader.DOWNLOAD_DIR} (max ${downloader.MAX_CONCURRENT} at a time)`);
  if (!APP_PASSWORD) console.warn('WARNING: APP_PASSWORD is not set - anyone who can reach this port can use the app.');
  downloader.start();
});
