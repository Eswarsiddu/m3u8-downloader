'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const { LANGS } = require('./parser');
const { parseHeaders } = require('./headers');

const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads'));
const TMP_ROOT = path.join(DOWNLOAD_DIR, '.tmp');
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || '1', 10) || 1);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const USER_AGENT =
  process.env.DOWNLOAD_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

fs.mkdirSync(TMP_ROOT, { recursive: true });

const running = new Map(); // id -> { proc, cancelled }

function safeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
  return cleaned || 'download';
}

// The headers the user copied from their browser, as [[name, value], ...].
function itemHeaders(item) {
  try {
    return parseHeaders(item.headers, item.referer);
  } catch {
    return [];
  }
}

function userAgentOf(list) {
  const ua = list.find(([n]) => n.toLowerCase() === 'user-agent');
  return ua ? ua[1] : USER_AGENT;
}

// ffmpeg options so that every playlist and segment request carries those headers.
function headerArgs(list) {
  const rest = list.filter(([n]) => n.toLowerCase() !== 'user-agent');
  const args = ['-user_agent', userAgentOf(list)];
  if (rest.length) args.push('-headers', rest.map(([n, v]) => `${n}: ${v}`).join('\r\n') + '\r\n');
  return args;
}

// Sum of #EXTINF durations of a media playlist, so we can show a real percentage.
async function playlistDuration(url, list) {
  try {
    const headers = Object.fromEntries(list.filter(([n]) => n.toLowerCase() !== 'user-agent'));
    headers['User-Agent'] = userAgentOf(list);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes('#EXT-X-STREAM-INF')) return null; // master, not a media playlist
    let total = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) total += parseFloat(m[1]);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Run ffmpeg. `onProgress({ seconds, size, speed })` is called as it goes.
 * Resolves on success, rejects with an Error (message = tail of stderr).
 */
function runFfmpeg(id, args, onProgress) {
  return new Promise((resolve, reject) => {
    const state = running.get(id);
    if (state && state.cancelled) return reject(new Error('Cancelled'));
    const proc = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-y', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (state) state.proc = proc;

    let buf = '';
    let cur = {};
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k === 'out_time_us') cur.seconds = parseInt(v, 10) / 1e6;
        else if (k === 'total_size') cur.size = parseInt(v, 10);
        else if (k === 'speed') cur.speed = v.trim();
        else if (k === 'progress') {
          if (onProgress && Number.isFinite(cur.seconds)) onProgress({ ...cur });
          cur = {};
        }
      }
    });

    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    proc.on('error', (e) => {
      reject(new Error(e.code === 'ENOENT' ? `ffmpeg not found (looked for "${FFMPEG}"). Install it: sudo apt install ffmpeg` : e.message));
    });
    proc.on('close', (code) => {
      if (state && state.cancelled) return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      const tail = err.trim().split('\n').slice(-6).join('\n');
      let msg = tail || `ffmpeg exited with code ${code}`;
      if (/403|401|410|404|Forbidden|Unauthorized|Not Found/i.test(err)) {
        msg += '\n(The host refused the request. Either the link expired, or it needs the same request headers your browser sends: ' +
          'use "Request headers" and paste "Copy as cURL" from DevTools for the .m3u8 request.)';
      }
      reject(new Error(msg));
    });
  });
}

async function processItem(item) {
  const id = item.id;
  const tmpDir = path.join(TMP_ROOT, String(id));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const audios = [...item.audios].sort(
    (a, b) => (LANGS[a.lang]?.order ?? 99) - (LANGS[b.lang]?.order ?? 99)
  );

  // Streams to fetch, in order. Video first, then each audio track.
  const streams = [
    {
      kind: 'video',
      label: 'video',
      url: item.video_url,
      file: path.join(tmpDir, 'video.mkv'),
      // With separate audio tracks, take only video from the variant; otherwise keep its embedded audio.
      map: audios.length ? ['-map', '0:v:0'] : ['-map', '0:v:0', '-map', '0:a?'],
    },
    ...audios.map((a) => ({
      kind: 'audio',
      label: `${LANGS[a.lang]?.label || a.lang} audio`,
      lang: a.lang,
      url: a.url,
      file: path.join(tmpDir, `audio-${a.lang}.mka`),
      map: ['-map', '0:a:0'],
    })),
  ];

  const reqHeaders = itemHeaders(item);
  const total = streams.length;
  const MUX_SHARE = 0.03; // reserve a sliver of the bar for the final mux
  let lastWrite = 0;

  const write = (fields, force) => {
    const now = Date.now();
    if (!force && now - lastWrite < 800) return;
    lastWrite = now;
    db.updateItem(id, fields);
  };

  for (let i = 0; i < total; i++) {
    const s = streams[i];
    if (running.get(id)?.cancelled) throw new Error('Cancelled');
    write({ stage: `Downloading ${s.label} (${i + 1}/${total})`, info: null }, true);

    const duration = await playlistDuration(s.url, reqHeaders);
    if (running.get(id)?.cancelled) throw new Error('Cancelled');
    await runFfmpeg(
      id,
      [
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...headerArgs(reqHeaders),
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', s.url,
        ...s.map,
        '-c', 'copy',
        s.file,
      ],
      ({ seconds, size, speed }) => {
        const frac = duration ? Math.min(1, seconds / duration) : 0;
        const overall = ((i + frac) / total) * (1 - MUX_SHARE);
        const bits = [];
        if (duration) bits.push(`${Math.round(frac * 100)}% of ${s.label}`);
        if (size) bits.push(fmtBytes(size));
        if (speed && speed !== 'N/A') bits.push(speed);
        write({ progress: duration ? overall : (i / total) * (1 - MUX_SHARE), info: bits.join(' · ') });
      }
    );
  }

  // Mux everything into one MKV with labelled audio tracks.
  if (running.get(id)?.cancelled) throw new Error('Cancelled');
  write({ status: 'muxing', stage: 'Combining video and audio', progress: 1 - MUX_SHARE, info: null }, true);

  let outName = `${safeFileName(item.name)}.mkv`;
  if (fs.existsSync(path.join(DOWNLOAD_DIR, outName))) {
    outName = `${safeFileName(item.name)} (${id}).mkv`;
  }
  const outPath = path.join(DOWNLOAD_DIR, outName);
  const partPath = outPath + '.part';

  const muxArgs = [];
  streams.forEach((s) => muxArgs.push('-i', s.file));
  muxArgs.push('-map', '0:v:0');
  const audioStreams = streams.filter((s) => s.kind === 'audio');
  if (audioStreams.length) {
    audioStreams.forEach((s) => {
      const idx = streams.indexOf(s);
      muxArgs.push('-map', `${idx}:a:0`);
    });
  } else {
    muxArgs.push('-map', '0:a?');
  }
  muxArgs.push('-c', 'copy', '-metadata', `title=${item.name}`);
  audioStreams.forEach((s, n) => {
    const l = LANGS[s.lang];
    muxArgs.push(`-metadata:s:a:${n}`, `language=${l.iso3}`, `-metadata:s:a:${n}`, `title=${l.label}`);
    muxArgs.push(`-disposition:a:${n}`, n === 0 ? 'default' : '0');
  });
  muxArgs.push('-f', 'matroska', partPath);

  await runFfmpeg(id, muxArgs, null);
  fs.renameSync(partPath, outPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return outName;
}

async function runJob(item) {
  const id = item.id;
  running.set(id, { proc: null, cancelled: false });
  db.updateItem(id, {
    status: 'downloading',
    stage: 'Starting',
    progress: 0,
    info: null,
    error: null,
    output_file: null,
    started_at: Date.now(),
    finished_at: null,
  });
  try {
    const outName = await processItem(item);
    db.updateItem(id, {
      status: 'done', stage: 'Finished', progress: 1, info: null, output_file: outName, finished_at: Date.now(),
    });
  } catch (e) {
    const cancelled = running.get(id)?.cancelled;
    db.updateItem(id, {
      status: cancelled ? 'cancelled' : 'failed',
      stage: null,
      info: null,
      error: cancelled ? null : e.message,
      finished_at: Date.now(),
    });
    fs.rmSync(path.join(TMP_ROOT, String(id)), { recursive: true, force: true });
  } finally {
    running.delete(id);
    setImmediate(tick);
  }
}

function tick() {
  const free = MAX_CONCURRENT - running.size;
  if (free <= 0) return;
  for (const item of db.nextQueued(free)) {
    if (running.size >= MAX_CONCURRENT) break;
    runJob(item);
  }
}

function enqueue(id) {
  db.updateItem(id, { status: 'queued', stage: 'Waiting in queue', progress: 0, info: null, error: null });
  tick();
}

function cancel(id) {
  const r = running.get(id);
  if (r) {
    r.cancelled = true;
    if (r.proc) r.proc.kill('SIGTERM');
    return true;
  }
  const item = db.getItem(id);
  if (item && item.status === 'queued') {
    db.updateItem(id, { status: 'cancelled', stage: null });
    return true;
  }
  return false;
}

function isRunning(id) {
  return running.has(id);
}

function start() {
  db.resetRunning(); // anything that was mid-download when the process died goes back in the queue
  // Remove leftovers from interrupted runs; queued items re-download from scratch.
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  tick();
}

module.exports = { start, enqueue, cancel, isRunning, DOWNLOAD_DIR, MAX_CONCURRENT, safeFileName };
