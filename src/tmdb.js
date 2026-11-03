'use strict';

// Looks up a title from a TMDB URL like https://www.themoviedb.org/movie/603-the-matrix
// themoviedb.org blocks scripted page fetches, so we never read the page. Order of attempts:
//   1. TMDB API using TMDB_READ_KEY (v4 read access token, sent as a Bearer token)
//   2. TMDB API using TMDB_API_KEY  (v3 api key, sent as ?api_key=)
//   3. Wikidata by TMDB id - no key needed
//   4. Guess from the URL slug
// Credentials are read on each call, so they can be changed without code edits.

const readKey = () => (process.env.TMDB_READ_KEY || '').trim();
const apiKey = () => (process.env.TMDB_API_KEY || '').trim();

function parseTmdbUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error('Not a valid URL.');
  }
  if (!/^(www\.)?themoviedb\.org$/i.test(u.hostname)) throw new Error('Not a themoviedb.org link.');
  const m = /^\/(movie|tv)\/(\d+)(?:-([^/?#]*))?/i.exec(u.pathname);
  if (!m) throw new Error('Expected a link like themoviedb.org/movie/603-the-matrix or /tv/1399-game-of-thrones.');
  return { type: m[1].toLowerCase(), id: m[2], slug: m[3] ? decodeURIComponent(m[3]) : '' };
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function format(type, id, title, year, source) {
  return { type, id, title, year, name: year ? `${title} (${year})` : title, approximate: false, source };
}

// Credentials to try, in order. A v4 token (starts with "eyJ") put in TMDB_API_KEY still works.
function tmdbCredentials() {
  const creds = [];
  const add = (value, label) => {
    if (!value || creds.some((c) => c.value === value)) return;
    creds.push({ value, label, bearer: value.startsWith('eyJ') });
  };
  add(readKey(), 'TMDB_READ_KEY');
  add(apiKey(), 'TMDB_API_KEY');
  return creds;
}

// Returns { title, year } on success, null if this credential didn't work (reason is logged).
async function lookupTmdbApi(type, id, cred) {
  const headers = { Accept: 'application/json' };
  let url = `https://api.themoviedb.org/3/${type}/${id}`;
  if (cred.bearer) headers.Authorization = `Bearer ${cred.value}`;
  else url += `?api_key=${encodeURIComponent(cred.value)}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) {
      console.warn(`TMDB rejected ${cred.label} (401).`);
      return null;
    }
    if (!res.ok) {
      console.warn(`TMDB lookup via ${cred.label} failed (${res.status}).`);
      return { notFound: res.status === 404 };
    }
    const d = await res.json();
    const date = d.release_date || d.first_air_date || '';
    return { title: d.title || d.name || '', year: /^\d{4}/.test(date) ? date.slice(0, 4) : '' };
  } catch (e) {
    console.warn(`Could not reach TMDB via ${cred.label}: ${e.message}`);
    return null;
  }
}

// Keyless lookup: Wikidata stores TMDB ids (P4947 = movie, P4983 = tv) with English labels and dates.
// Coverage is good for well-known titles but not complete.
async function lookupWikidata(type, id) {
  const prop = type === 'movie' ? 'P4947' : 'P4983';
  const query = `SELECT ?l ?d WHERE { ?i wdt:${prop} "${id}". ?i rdfs:label ?l. FILTER(LANG(?l)="en")
    OPTIONAL { ?i wdt:P577 ?d } OPTIONAL { ?i wdt:P580 ?d } } LIMIT 20`; // id is digits only (see parseTmdbUrl)
  try {
    const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'stream-downloader/1.0 (personal tool)', Accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()).results.bindings;
    if (!rows.length) return null;
    const years = rows.map((r) => (r.d && /^\d{4}/.test(r.d.value) ? r.d.value.slice(0, 4) : '')).filter(Boolean).sort();
    return { title: rows[0].l.value, year: years[0] || '' };
  } catch {
    return null;
  }
}

async function lookup(url) {
  const { type, id, slug } = parseTmdbUrl(url);

  // 1 + 2: TMDB API with whichever credentials are configured
  for (const cred of tmdbCredentials()) {
    const r = await lookupTmdbApi(type, id, cred);
    if (r && r.title) return format(type, id, r.title, r.year, 'tmdb');
    if (r && r.notFound) break; // the id doesn't exist; the other key won't help
  }

  // 3: Wikidata
  const w = await lookupWikidata(type, id);
  if (w) return format(type, id, w.title, w.year, 'wikidata');

  // 4: slug guess
  const guess = titleFromSlug(slug);
  if (!guess) throw new Error('Could not find this title, and the link has no title in it. Type the name manually.');
  return { type, id, title: guess, year: '', name: guess, approximate: true, source: 'link' };
}

module.exports = { lookup, parseTmdbUrl, titleFromSlug, tmdbCredentials };
