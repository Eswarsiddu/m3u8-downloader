'use strict';

const $ = (id) => document.getElementById(id);
const LANGS = { hi: 'Hindi', en: 'English', te: 'Telugu', ja: 'Japanese' };

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- audio rows ----------

function addAudioRow(lang = '', url = '') {
  const used = new Set([...document.querySelectorAll('#audios select')].map((s) => s.value));
  if (!lang) lang = Object.keys(LANGS).find((l) => !used.has(l)) || 'hi';

  const select = h('select', {}, Object.entries(LANGS).map(([code, label]) => h('option', { value: code }, label)));
  select.value = lang;
  const input = h('input', { type: 'url', placeholder: 'https://.../index-a1.m3u8?...', value: url });
  const row = h('div', { class: 'audio-row' }, select, input,
    h('button', { type: 'button', class: 'ghost', title: 'Remove', onclick: () => row.remove() }, '✕'));
  $('audios').append(row);
}

function readAudios() {
  return [...document.querySelectorAll('#audios .audio-row')].map((r) => ({
    lang: r.querySelector('select').value,
    url: r.querySelector('input').value.trim(),
  })).filter((a) => a.url);
}

$('addAudio').addEventListener('click', () => addAudioRow());

// ---------- master.m3u8 detection ----------

let detectedRes = '';

function showDetect(kind, text) {
  const box = $('detect');
  box.hidden = !text;
  box.className = 'detect ' + kind;
  box.textContent = text || '';
}

function setResTag(res) {
  detectedRes = res || '';
  $('resTag').hidden = !detectedRes;
  $('resTag').textContent = detectedRes;
}

async function detect() {
  const text = $('master').value.trim();
  if (!text) { showDetect('', ''); return; }
  try {
    const r = await api('POST', '/api/parse', { text });
    $('video').value = r.video.url;
    setResTag(r.video.resolution);
    $('audios').replaceChildren();
    r.audios.forEach((a) => addAudioRow(a.lang, a.url));
    const parts = [
      `Video: ${r.video.resolution || 'highest'} (best of ${r.variantCount})`,
      `Audio: ${r.audios.length ? r.audios.map((a) => a.label).join(', ') : 'none separate'}`,
    ];
    if (r.ignored.length) parts.push(`Ignored: ${r.ignored.map((i) => i.name || i.language).join(', ')}`);
    showDetect('ok', parts.join('  ·  '));
  } catch (e) {
    showDetect('bad', e.message);
  }
}

let detectTimer;
$('master').addEventListener('input', () => {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(detect, 250);
});

// Editing the video URL by hand invalidates the detected resolution tag.
$('video').addEventListener('input', () => setResTag(''));

// ---------- TMDB name lookup ----------

let nameAutoFilled = false;
$('name').addEventListener('input', () => { nameAutoFilled = false; });

function setTmdbHint(text, bad) {
  const el = $('tmdbHint');
  el.hidden = !text;
  el.textContent = text || '';
  el.style.color = bad ? 'var(--bad)' : '';
}

let tmdbSeq = 0;
async function lookupTmdb() {
  const url = $('tmdb').value.trim();
  const seq = ++tmdbSeq;
  if (!url) { setTmdbHint(''); return; }
  setTmdbHint('Looking up name…');
  try {
    const r = await api('GET', `/api/tmdb?url=${encodeURIComponent(url)}`);
    if (seq !== tmdbSeq) return; // a newer lookup superseded this one
    const nameEl = $('name');
    if (!nameEl.value.trim() || nameAutoFilled) {
      nameEl.value = r.name;
      nameAutoFilled = true;
      setTmdbHint(r.approximate
        ? `Not found in the database; name guessed from the link text. Please check it.`
        : `Found: ${r.name}`);
    } else {
      setTmdbHint(`TMDB: ${r.name} (name left as you typed it)`);
    }
  } catch (e) {
    if (seq === tmdbSeq) setTmdbHint(e.message, true);
  }
}

let tmdbTimer;
$('tmdb').addEventListener('input', () => {
  clearTimeout(tmdbTimer);
  tmdbTimer = setTimeout(lookupTmdb, 400);
});

// ---------- submit ----------

async function submit(start) {
  $('formError').hidden = true;
  try {
    await api('POST', '/api/items', {
      name: $('name').value,
      tmdb_url: $('tmdb').value,
      imdb_url: $('imdb').value,
      video_url: $('video').value,
      resolution: detectedRes,
      audios: readAudios(),
      headers: $('headers').value,
      start,
    });
    try { localStorage.setItem('headers', $('headers').value); } catch { /* storage unavailable */ }
    resetForm();
    refresh();
  } catch (e) {
    $('formError').textContent = e.message;
    $('formError').hidden = false;
  }
}

function loadSavedHeaders() {
  try {
    const saved = localStorage.getItem('headers');
    if (saved) { $('headers').value = saved; $('advanced').open = true; }
  } catch { /* storage unavailable */ }
}

function resetForm() {
  $('form').reset();
  loadSavedHeaders(); // keep the headers: they're the same for every item from the same site
  $('master').value = '';
  $('audios').replaceChildren();
  setResTag('');
  showDetect('', '');
  setTmdbHint('');
  nameAutoFilled = false;
  $('formError').hidden = true;
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  submit(true);
});
$('submitSave').addEventListener('click', () => {
  if ($('form').reportValidity()) submit(false);
});
$('clearBtn').addEventListener('click', resetForm);

// ---------- list ----------

const STATUS_LABEL = {
  saved: 'Saved', queued: 'Queued', downloading: 'Downloading', muxing: 'Combining',
  done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

function renderItem(it) {
  const active = it.status === 'downloading' || it.status === 'muxing';
  const links = [];
  if (it.tmdb_url) links.push(h('a', { href: it.tmdb_url, target: '_blank', rel: 'noopener noreferrer' }, 'TMDB'));
  if (it.imdb_url) links.push(h('a', { href: it.imdb_url, target: '_blank', rel: 'noopener noreferrer' }, 'IMDb'));

  const langs = it.audios.map((a) => LANGS[a.lang] || a.lang).join(', ');
  const btns = [];
  if (it.status === 'saved') btns.push(h('button', { onclick: () => act('start', it.id) }, 'Start'));
  if (it.status === 'failed' || it.status === 'cancelled') {
    btns.push(h('button', { onclick: () => act('start', it.id) }, 'Retry'));
    btns.push(h('button', { onclick: () => toggleHeaderEdit(it) }, 'Edit headers'));
  }
  if (active || it.status === 'queued') btns.push(h('button', { onclick: () => act('cancel', it.id) }, 'Cancel'));
  btns.push(h('button', { class: 'danger', onclick: () => remove(it) }, 'Delete'));

  return h('article', { class: 'item' },
    h('div', { class: 'head' },
      h('div', {},
        h('h3', {}, it.name),
        h('div', { class: 'meta' },
          it.resolution && h('span', {}, it.resolution),
          h('span', {}, langs ? `Audio: ${langs}` : 'Audio: from video'),
          links,
          h('span', {}, new Date(it.created_at).toLocaleString())
        )
      ),
      h('span', { class: `badge s-${it.status}` }, STATUS_LABEL[it.status] || it.status)
    ),
    (active || it.status === 'queued') && h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(it.progress * 100)}%` })),
    (active || it.status === 'queued') && h('div', { class: 'status-line' },
      [it.stage, it.info].filter(Boolean).join(' — ') +
        (active ? `  (${Math.round(it.progress * 100)}%)` : '')),
    it.status === 'done' && it.output_file && h('div', { class: 'out' }, 'Saved as ', h('code', {}, it.output_file)),
    it.status === 'failed' && it.error && h('div', { class: 'err' }, it.error),
    editing.has(it.id) && headerEditor(it),
    h('div', { class: 'btns' }, btns)
  );
}

// Headers being edited on a failed item. Kept outside the DOM so the 2s refresh doesn't wipe what you typed.
const editing = new Map();

function toggleHeaderEdit(it) {
  if (editing.has(it.id)) editing.delete(it.id);
  else editing.set(it.id, it.headers || '');
  lastSnapshot = '';
  refresh();
}

function headerEditor(it) {
  const ta = h('textarea', { rows: 4, spellcheck: 'false',
    placeholder: 'Paste "Copy as cURL" from DevTools for the .m3u8 request, or lines like "Referer: https://..."',
    oninput: () => editing.set(it.id, ta.value) });
  ta.value = editing.get(it.id);
  return h('div', { class: 'hdr-edit' }, ta,
    h('button', { class: 'primary', onclick: async () => {
      const text = editing.get(it.id);
      try {
        await api('POST', `/api/items/${it.id}/start`, { headers: text });
        try { localStorage.setItem('headers', text); } catch { /* storage unavailable */ }
        editing.delete(it.id);
      } catch (e) { alert(e.message); }
      lastSnapshot = '';
      refresh();
    } }, 'Save headers & retry'));
}

let lastSnapshot = '';
async function refresh() {
  try {
    const items = await api('GET', '/api/items');
    const snap = JSON.stringify(items);
    if (snap === lastSnapshot) return;
    lastSnapshot = snap;
    $('list').replaceChildren(...items.map(renderItem));
    $('empty').hidden = items.length > 0;
  } catch { /* transient network error; try again on next poll */ }
}

async function act(what, id) {
  try {
    await api('POST', `/api/items/${id}/${what}`);
  } catch (e) {
    alert(e.message);
  }
  refresh();
}

async function remove(it) {
  if (!confirm(`Delete "${it.name}" from the list?`)) return;
  let files = false;
  if (it.status === 'done' && it.output_file) {
    files = confirm(`Also delete the downloaded file?\n${it.output_file}`);
  }
  try {
    await api('DELETE', `/api/items/${it.id}${files ? '?files=1' : ''}`);
  } catch (e) {
    alert(e.message);
  }
  refresh();
}

api('GET', '/api/config').then((c) => {
  $('cfg').textContent = `Saving to ${c.downloadDir} · ${c.maxConcurrent} at a time`;
}).catch(() => {});

loadSavedHeaders();
addAudioRow();
refresh();
setInterval(refresh, 2000);
