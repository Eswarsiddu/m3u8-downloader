'use strict';

// Only these audio languages are kept. Everything else in a master playlist is ignored.
const LANGS = {
  hi: { code: 'hi', iso3: 'hin', label: 'Hindi', order: 0 },
  en: { code: 'en', iso3: 'eng', label: 'English', order: 1 },
  te: { code: 'te', iso3: 'tel', label: 'Telugu', order: 2 },
  ja: { code: 'ja', iso3: 'jpn', label: 'Japanese', order: 3 },
};

const ALIASES = {
  hi: 'hi', hin: 'hi', hindi: 'hi', 'हिन्दी': 'hi', 'हिंदी': 'hi',
  en: 'en', eng: 'en', english: 'en',
  te: 'te', tel: 'te', telugu: 'te', 'తెలుగు': 'te',
  ja: 'ja', jpn: 'ja', jp: 'ja', japanese: 'ja', '日本語': 'ja',
};

function normalizeLang(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const key = String(c).trim().toLowerCase().split(/[-_]/)[0];
    if (ALIASES[key]) return ALIASES[key];
    const full = String(c).trim().toLowerCase();
    if (ALIASES[full]) return ALIASES[full];
  }
  return null;
}

// Parses `KEY=value,KEY2="quoted, value"` attribute lists.
function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function resolveUrl(u, baseUrl) {
  if (!u) return null;
  try {
    return new URL(u, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}

/**
 * Parse a pasted master.m3u8.
 * Returns { video, audios, ignored, variantCount }.
 *   video:  { url, resolution, bandwidth }  -> highest resolution variant
 *   audios: [{ lang, label, name, url }]    -> only hi / en / te, sorted hi, en, te
 *   ignored:[{ name, language }]            -> audio tracks that were skipped
 */
function parseMaster(text, baseUrl) {
  if (typeof text !== 'string' || !text.includes('#EXTM3U')) {
    throw new Error('This does not look like a master.m3u8 (missing #EXTM3U).');
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const variants = [];
  const audioByLang = new Map();
  const ignored = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if ((a.TYPE || '').toUpperCase() !== 'AUDIO') continue;
      const url = resolveUrl(a.URI, baseUrl);
      if (!url) continue; // muxed into the video variant, nothing separate to download
      const lang = normalizeLang(a.LANGUAGE, a.NAME);
      if (!lang) {
        ignored.push({ name: a.NAME || '', language: a.LANGUAGE || '' });
        continue;
      }
      if (!audioByLang.has(lang)) {
        audioByLang.set(lang, { lang, label: LANGS[lang].label, name: a.NAME || LANGS[lang].label, url });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      const url = resolveUrl(lines[j], baseUrl);
      if (!url) continue;
      const rm = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
      const width = rm ? parseInt(rm[1], 10) : 0;
      const height = rm ? parseInt(rm[2], 10) : 0;
      variants.push({
        url,
        resolution: a.RESOLUTION || '',
        pixels: width * height,
        bandwidth: parseInt(a.BANDWIDTH || '0', 10) || 0,
      });
      i = j;
    }
    // #EXT-X-I-FRAME-STREAM-INF (trick-play) is intentionally ignored.
  }

  if (!variants.length) {
    throw new Error('No video variants (#EXT-X-STREAM-INF) found. Relative URLs need a base URL.');
  }
  variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth);
  const best = variants[0];

  const audios = [...audioByLang.values()].sort((a, b) => LANGS[a.lang].order - LANGS[b.lang].order);

  return {
    video: { url: best.url, resolution: best.resolution, bandwidth: best.bandwidth },
    audios,
    ignored,
    variantCount: variants.length,
  };
}

module.exports = { parseMaster, LANGS, normalizeLang };
