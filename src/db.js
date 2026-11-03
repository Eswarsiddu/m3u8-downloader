'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'downloads.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  tmdb_url    TEXT,
  imdb_url    TEXT,
  video_url   TEXT NOT NULL,
  resolution  TEXT,
  audios      TEXT NOT NULL DEFAULT '[]',   -- JSON: [{lang, url}]
  referer     TEXT,
  status      TEXT NOT NULL DEFAULT 'saved', -- saved|queued|downloading|muxing|done|failed|cancelled
  stage       TEXT,
  progress    REAL NOT NULL DEFAULT 0,       -- 0..1
  info        TEXT,
  error       TEXT,
  output_file TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
`);

// Migration for databases created before per-item request headers existed.
if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'headers')) {
  db.exec('ALTER TABLE items ADD COLUMN headers TEXT');
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, audios: JSON.parse(row.audios || '[]') };
}

const stmts = {
  list: db.prepare('SELECT * FROM items ORDER BY id DESC'),
  get: db.prepare('SELECT * FROM items WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO items (name, tmdb_url, imdb_url, video_url, resolution, audios, referer, headers, status, created_at)
    VALUES (@name, @tmdb_url, @imdb_url, @video_url, @resolution, @audios, @referer, @headers, @status, @created_at)`),
  remove: db.prepare('DELETE FROM items WHERE id = ?'),
  nextQueued: db.prepare("SELECT * FROM items WHERE status = 'queued' ORDER BY id ASC LIMIT ?"),
  resetRunning: db.prepare(
    "UPDATE items SET status = 'queued', stage = NULL, progress = 0, info = NULL WHERE status IN ('downloading','muxing')"
  ),
};

function listItems() {
  return stmts.list.all().map(hydrate);
}

function getItem(id) {
  return hydrate(stmts.get.get(id));
}

function createItem(data) {
  const info = stmts.insert.run({
    name: data.name,
    tmdb_url: data.tmdb_url || null,
    imdb_url: data.imdb_url || null,
    video_url: data.video_url,
    resolution: data.resolution || null,
    audios: JSON.stringify(data.audios || []),
    referer: data.referer || null,
    headers: data.headers || null,
    status: data.status || 'saved',
    created_at: Date.now(),
  });
  return getItem(info.lastInsertRowid);
}

const UPDATABLE = new Set([
  'status', 'stage', 'progress', 'info', 'error', 'output_file', 'started_at', 'finished_at', 'headers',
]);

function updateItem(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return;
  const sql = `UPDATE items SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`;
  db.prepare(sql).run({ ...fields, id });
}

function deleteItem(id) {
  stmts.remove.run(id);
}

function nextQueued(limit) {
  return stmts.nextQueued.all(limit).map(hydrate);
}

function resetRunning() {
  stmts.resetRunning.run();
}

module.exports = { listItems, getItem, createItem, updateItem, deleteItem, nextQueued, resetRunning, DATA_DIR };
