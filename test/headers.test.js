'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseHeaders, normalizeHeaders } = require('../src/headers');

const asObj = (list) => Object.fromEntries(list.map(([n, v]) => [n.toLowerCase(), v]));

test('parses plain "Name: value" lines and keeps colons inside values', () => {
  const h = asObj(parseHeaders('Referer: https://a.com/x\nOrigin: https://a.com\n\n'));
  assert.strictEqual(h.referer, 'https://a.com/x');
  assert.strictEqual(h.origin, 'https://a.com');
});

test('parses a Chrome "Copy as cURL (bash)" command', () => {
  const curl = `curl 'https://cdn.example.com/index.m3u8?t=a&s=1' \\
  -H 'accept: */*' \\
  -H 'accept-encoding: gzip, deflate, br' \\
  -H 'origin: https://embed.example.com' \\
  -H 'referer: https://embed.example.com/e/abc' \\
  -H 'user-agent: Mozilla/5.0 Test' \\
  -b 'sid=1; x=2'`;
  const h = asObj(parseHeaders(curl));
  assert.strictEqual(h.referer, 'https://embed.example.com/e/abc');
  assert.strictEqual(h.origin, 'https://embed.example.com');
  assert.strictEqual(h['user-agent'], 'Mozilla/5.0 Test');
  assert.strictEqual(h.cookie, 'sid=1; x=2');
  assert.strictEqual(h.accept, '*/*');
  assert.ok(!('accept-encoding' in h), 'accept-encoding must be dropped (ffmpeg cannot decompress)');
});

test('parses a Windows "Copy as cURL (cmd)" command', () => {
  const curl = 'curl "https://cdn.example.com/i.m3u8" ^\r\n  -H "referer: https://e.com/" ^\r\n  -H "sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"124^\\^""';
  const h = asObj(parseHeaders(curl));
  assert.strictEqual(h.referer, 'https://e.com/');
});

test('drops Host and ignores HTTP/2 pseudo-headers', () => {
  const h = asObj(parseHeaders(':authority: x.com\nHost: x.com\nReferer: https://a.com/'));
  assert.deepStrictEqual(Object.keys(h), ['referer']);
});

test('old single Referer field is used only when no Referer header is given', () => {
  assert.strictEqual(asObj(parseHeaders('', 'https://old/')).referer, 'https://old/');
  assert.strictEqual(asObj(parseHeaders('Referer: https://new/', 'https://old/')).referer, 'https://new/');
});

test('rejects malformed lines and empty input gives null', () => {
  assert.throws(() => parseHeaders('just some text'), /Name: value/);
  assert.throws(() => parseHeaders('bad name: x'), /not a valid header name/);
  assert.strictEqual(normalizeHeaders('   '), null);
});
