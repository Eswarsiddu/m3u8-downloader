'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMaster } = require('../src/parser');

const H = 'https://cdn.example.com/hls2/x';
const SAMPLE = `#EXTM3U

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="हिन्दी",LANGUAGE="hi",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="2",URI="${H}/index-a1.m3u8?t=a&s=1"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",AUTOSELECT=NO,DEFAULT=NO,CHANNELS="2",URI="${H}/index-a2.m3u8?t=a&s=1"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Tamil",LANGUAGE="ta",AUTOSELECT=NO,DEFAULT=NO,CHANNELS="2",URI="${H}/index-a3.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="తెలుగు",LANGUAGE="te",AUTOSELECT=NO,DEFAULT=NO,CHANNELS="2",URI="${H}/index-a4.m3u8"

#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=351990,RESOLUTION=668x360,FRAME-RATE=60.000,CODECS="avc1.64001f,mp4a.40.2",VIDEO-RANGE=SDR,AUDIO="audio0"
${H}_l/index-v1-a1.m3u8?t=a
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=942203,RESOLUTION=1280x688,FRAME-RATE=60.000,CODECS="avc1.640020,mp4a.40.2",VIDEO-RANGE=SDR,AUDIO="audio0"
${H}_h/index-v1-a1.m3u8?t=a
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=526414,RESOLUTION=888x480,FRAME-RATE=60.000,CODECS="avc1.64001f,mp4a.40.2",VIDEO-RANGE=SDR,AUDIO="audio0"
${H}_n/index-v1-a1.m3u8?t=a

#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=49340,RESOLUTION=1920x1080,CODECS="avc1.640020",URI="${H}_h/iframes-v1-a1.m3u8",VIDEO-RANGE=SDR
`;

test('picks the highest-resolution variant (not the I-frame one, not file order)', () => {
  const r = parseMaster(SAMPLE);
  assert.strictEqual(r.video.resolution, '1280x688');
  assert.strictEqual(r.video.url, `${H}_h/index-v1-a1.m3u8?t=a`);
  assert.strictEqual(r.variantCount, 3);
});

test('keeps only Hindi, English and Telugu audio, in that order, and reports the rest', () => {
  const r = parseMaster(SAMPLE);
  assert.deepStrictEqual(r.audios.map((a) => a.lang), ['hi', 'en', 'te']);
  assert.strictEqual(r.audios[0].url, `${H}/index-a1.m3u8?t=a&s=1`); // query string kept intact
  assert.deepStrictEqual(r.ignored.map((i) => i.name), ['Tamil']);
});

test('rejects text that is not a playlist', () => {
  assert.throws(() => parseMaster('hello'), /EXTM3U/);
});

test('rejects a playlist with no video variants', () => {
  assert.throws(() => parseMaster('#EXTM3U\n#EXT-X-VERSION:3\n'), /No video variants/);
});

test('resolves relative URLs when a base URL is given', () => {
  const r = parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=100x100\nv/index.m3u8\n', 'https://a.com/x/master.m3u8');
  assert.strictEqual(r.video.url, 'https://a.com/x/v/index.m3u8');
});
