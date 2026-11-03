'use strict';
const test = require('node:test');
const assert = require('node:assert');
delete process.env.TMDB_API_KEY; // the first tests exercise the no-key fallback
delete process.env.TMDB_READ_KEY;
const { parseTmdbUrl, lookup } = require('../src/tmdb');

test('parses movie and tv links, with or without slug and extra path', () => {
  assert.deepStrictEqual(parseTmdbUrl('https://www.themoviedb.org/movie/603-the-matrix'), { type: 'movie', id: '603', slug: 'the-matrix' });
  assert.deepStrictEqual(parseTmdbUrl('https://themoviedb.org/tv/37854'), { type: 'tv', id: '37854', slug: '' });
  assert.strictEqual(parseTmdbUrl('https://www.themoviedb.org/tv/37854-one-piece/season/1?language=en-US').slug, 'one-piece');
});

test('rejects other hosts and unsupported paths', () => {
  assert.throws(() => parseTmdbUrl('https://evil.example.com/movie/603-x'), /themoviedb/);
  assert.throws(() => parseTmdbUrl('https://www.themoviedb.org/person/123'), /Expected/);
  assert.throws(() => parseTmdbUrl('nope'), /valid URL/);
});

const realFetch = global.fetch;
const wikidataReturns = (bindings) => {
  global.fetch = async () => ({ ok: true, json: async () => ({ results: { bindings } }) });
};

test('without an API key, uses Wikidata and takes the earliest year', async () => {
  wikidataReturns([
    { l: { value: 'The Matrix' }, d: { value: '1999-06-17T00:00:00Z' } },
    { l: { value: 'The Matrix' }, d: { value: '1999-03-31T00:00:00Z' } },
  ]);
  const r = await lookup('https://www.themoviedb.org/movie/603-the-matrix');
  assert.strictEqual(r.name, 'The Matrix (1999)');
  assert.strictEqual(r.source, 'wikidata');
});

test('if Wikidata has nothing, guesses the title from the slug', async () => {
  wikidataReturns([]);
  const r = await lookup('https://www.themoviedb.org/movie/603-the-matrix');
  assert.strictEqual(r.name, 'The Matrix');
  assert.strictEqual(r.approximate, true);
});

test('if Wikidata is unreachable and there is no slug, errors clearly', async () => {
  global.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(lookup('https://www.themoviedb.org/tv/37854'), /Type the name manually/);
});

test('uses TMDB_READ_KEY as a Bearer token first', async () => {
  process.env.TMDB_READ_KEY = 'eyJread';
  process.env.TMDB_API_KEY = 'v3key';
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ title: 'Wish Dragon', release_date: '2021-06-11' }) };
  };
  const r = await lookup('https://www.themoviedb.org/movie/550205-wish-dragon');
  assert.strictEqual(r.name, 'Wish Dragon (2021)');
  assert.strictEqual(r.source, 'tmdb');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].auth, 'Bearer eyJread');
  assert.ok(!calls[0].url.includes('api_key'));
});

test('falls back to TMDB_API_KEY (?api_key=) when the read token is rejected', async () => {
  process.env.TMDB_READ_KEY = 'eyJbad';
  process.env.TMDB_API_KEY = 'v3key';
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    if (opts.headers.Authorization) return { ok: false, status: 401 };
    return { ok: true, status: 200, json: async () => ({ name: 'One Piece', first_air_date: '1999-10-20' }) };
  };
  const r = await lookup('https://www.themoviedb.org/tv/37854');
  assert.strictEqual(r.name, 'One Piece (1999)');
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].url.includes('api_key=v3key'));
});

test('if both TMDB keys fail, still falls back to Wikidata', async () => {
  process.env.TMDB_READ_KEY = 'eyJbad';
  process.env.TMDB_API_KEY = 'bad';
  global.fetch = async (url) => {
    if (String(url).includes('api.themoviedb.org')) return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ results: { bindings: [{ l: { value: 'The Matrix' }, d: { value: '1999-03-31T00:00:00Z' } }] } }) };
  };
  const r = await lookup('https://www.themoviedb.org/movie/603');
  assert.strictEqual(r.source, 'wikidata');
});

test.after(() => { global.fetch = realFetch; });
