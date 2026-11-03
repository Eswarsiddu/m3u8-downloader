'use strict';

// Request headers the user copies from their browser (DevTools -> Network -> the .m3u8 request).
// Accepts either plain "Name: value" lines, or a whole "Copy as cURL" command.

// Headers that would break ffmpeg (it doesn't decompress) or are set by the HTTP layer itself.
const DROP = new Set(['host', 'accept-encoding', 'content-length', 'connection', 'range', 'if-none-match', 'if-modified-since', 'te']);

// Pull the arguments out of a pasted curl command: -H '...', --header "...", -b, -A, -e.
function headerLinesFromCurl(text) {
  const out = [];
  const flags = new Map([
    ['-H', null], ['--header', null],
    ['-b', 'Cookie'], ['--cookie', 'Cookie'],
    ['-A', 'User-Agent'], ['--user-agent', 'User-Agent'],
    ['-e', 'Referer'], ['--referer', 'Referer'],
  ]);
  const joined = text.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' '); // line continuations (bash and cmd)
  const re = /(?:^|\s)(-H|--header|-b|--cookie|-A|--user-agent|-e|--referer)(?:\s+|=)(?:\$?'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m;
  while ((m = re.exec(joined))) {
    const flag = m[1];
    const val = (m[2] ?? m[3] ?? m[4] ?? '').replace(/\\(["'\\])/g, '$1').replace(/\^"/g, '"');
    const fixed = flags.get(flag);
    out.push(fixed ? `${fixed}: ${val}` : val);
  }
  return out;
}

/**
 * Returns [[name, value], ...] ready to send. Throws on garbage.
 * `legacyReferer` (the old single Referer field) is added if no Referer header is present.
 */
function parseHeaders(text, legacyReferer) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const lines = /(^|\s)curl\s/i.test(raw) ? headerLinesFromCurl(raw) : raw.split(/\r?\n/);

  const map = new Map(); // lowercase name -> [name, value]; later duplicates replace earlier
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith(':')) continue; // blank or HTTP/2 pseudo-header like ":authority: x"
    const i = line.indexOf(':');
    if (i <= 0) throw new Error(`Header "${line.slice(0, 40)}" must look like "Name: value".`);
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`"${name.slice(0, 40)}" is not a valid header name.`);
    if (/[\r\n\0]/.test(value)) throw new Error(`Header "${name}" has an invalid value.`);
    if (DROP.has(name.toLowerCase())) continue;
    map.set(name.toLowerCase(), [name, value]);
  }
  if (legacyReferer && !map.has('referer')) map.set('referer', ['Referer', legacyReferer]);
  if (map.size > 40) throw new Error('Too many headers (max 40).');
  return [...map.values()];
}

// Stored form: normalised "Name: value" lines (or null when empty).
function normalizeHeaders(text, legacyReferer) {
  const list = parseHeaders(text, legacyReferer);
  return list.length ? list.map(([n, v]) => `${n}: ${v}`).join('\n') : null;
}

module.exports = { parseHeaders, normalizeHeaders };
