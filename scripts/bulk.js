// bulk: split selected JSON values into small chunk files for worker agents, then write their results back
// into the source without touching its layout.
//   node bulk.js chunk <src.json> <pattern> <workdir> [--to <key> | --into <other.json>] [--all]
//   node bulk.js merge <workdir> <src.json> [<other.json>]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { settings } = require('../hooks/common');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const empty = v => v === '' || v == null || (typeof v === 'object' && !Object.keys(v).length);
// Same structure, non-string leaves and {placeholders}; the rest of a string may differ: a translation keeps the shape.
const holders = s => (s.match(/\{\w+[,}]/g) || []).sort().join('');
const shape = v => JSON.stringify(v, (k, x) => (typeof x === 'string' ? holders(x) : x));

// [[path, value]] for every value whose dotted path matches pattern ('*' = any key or index except ARB's @metadata).
function select(doc, pattern) {
  const pat = pattern.split('.'), out = [];
  const walk = (v, i, p) => {
    if (i === pat.length) return out.push([p, v]);
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (pat[i] === '*' ? k.startsWith('@') : pat[i] !== k) continue;
      if (k.includes('.')) throw new Error(`keys containing "." are not supported: ${k}`);
      walk(v[k], i + 1, [...p, k]);
    }
  };
  walk(doc, 0, []);
  return out;
}

// Dotted path → {start, end, lead} of each value in the JSON text; lead is the whitespace before its key.
function spans(text) {
  const map = new Map();
  let i = 0;
  const ws = () => { while (/\s/.test(text[i])) i++; };
  const str = () => { const s = i++; while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; return JSON.parse(text.slice(s, i)); };
  const val = (p, lead) => {
    ws();
    const start = i, c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      for (let n = 0; ;) {
        const from = i;
        ws();
        if (text[i] === close) break;
        if (text[i] === ',') { i++; continue; }
        const at = i;
        let k = String(n++);
        if (c === '{') { k = str(); ws(); i++; } // past the ':'
        val([...p, k], text.slice(from, at));
      }
      i++;
    } else if (c === '"') str();
    else while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    map.set(p.join('.'), { start, end: i, lead });
  };
  val([], '');
  return map;
}

// srcText with its string values (not keys) replaced, in order, by value's strings.
function render(srcText, value) {
  const strings = [];
  JSON.stringify(value, (k, x) => { if (typeof x === 'string') strings.push(x); return x; });
  let n = 0;
  return srcText.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (m, key) => (key ? m : JSON.stringify(strings[n++])));
}

function chunk(src, pattern, dir, { to, into, all, kb = 8 } = {}) {
  const text = fs.readFileSync(src, 'utf8'), doc = JSON.parse(text);
  let items = select(doc, pattern), intoText;
  if (to && into) throw new Error('use --to or --into, not both');
  if (into) {
    intoText = fs.readFileSync(into, 'utf8');
    const target = JSON.parse(intoText);
    if (!all) items = items.filter(([p]) => empty(p.reduce((o, k) => o?.[k], target)));
  }
  if (to) {
    const parent = p => p.slice(0, -1).reduce((o, k) => o[k], doc);
    for (const [p] of items) if (Array.isArray(parent(p))) throw new Error(`--to needs object parents: ${p.join('.')}`);
    if (!all) items = items.filter(([p]) => empty(parent(p)[to]));
  }
  fs.mkdirSync(dir, { recursive: true });
  const chunks = [];
  let cur = {}, size = 0;
  const flush = () => {
    if (!size) return;
    const n = String(chunks.length + 1).padStart(3, '0');
    fs.writeFileSync(path.join(dir, `chunk-${n}.json`), JSON.stringify(cur, null, 1));
    chunks.push({ in: `chunk-${n}.json`, out: `out-${n}.json`, n: Object.keys(cur).length });
    cur = {}; size = 0;
  };
  for (const [p, v] of items) {
    const len = JSON.stringify(v).length + p.join('.').length + 8;
    if (size && size + len > kb * 1024) flush();
    cur[p.join('.')] = v; size += len;
  }
  flush();
  const manifest = { src: path.resolve(src), hash: sha(text), pattern, to: to || null,
    into: into ? path.resolve(into) : null, intoHash: into ? sha(intoText) : null, total: items.length, chunks };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Edit that sets id in another file: replace its value, or append it after its parent's last entry.
function place(map, id, body) {
  const t = map.get(id);
  if (t) return { at: t.start, end: t.end, body };
  const cut = id.lastIndexOf('.'), parent = cut < 0 ? '' : id.slice(0, cut), pre = parent ? parent + '.' : '';
  let last;
  for (const [k, s] of map) if (k && k.startsWith(pre) && !k.slice(pre.length).includes('.') && (!last || s.end > last.end)) last = s;
  // shortcut: a missing or empty parent object in the target is reported as bad, add it by hand
  return last && { at: last.end, end: last.end, body: `,${last.lead}${JSON.stringify(id.slice(cut + 1))}: ${body}` };
}

// Workers can write into dir, so the manifest is not trusted to name the files merge writes or reads.
function merge(dir, src, into) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (path.resolve(src) !== m.src || (into ? path.resolve(into) : null) !== m.into) throw new Error('files given to merge differ from the ones chunked');
  if (!m.chunks.every(c => /^chunk-\d{3}\.json$/.test(c.in) && c.out === c.in.replace('chunk', 'out'))) throw new Error('manifest has unexpected chunk names');
  const text = fs.readFileSync(m.src, 'utf8');
  if (sha(text) !== m.hash) throw new Error(`${m.src} changed since chunking: chunk again`);
  const dest = m.into || m.src, dtext = m.into ? fs.readFileSync(dest, 'utf8') : text;
  if (m.into && sha(dtext) !== m.intoHash) throw new Error(`${dest} changed since chunking: chunk again`);
  const map = spans(text), dmap = m.into ? spans(dtext) : map, edits = [], bad = [], retry = [];
  for (const c of m.chunks) {
    const input = JSON.parse(fs.readFileSync(path.join(dir, c.in), 'utf8'));
    let out;
    try { out = JSON.parse(fs.readFileSync(path.join(dir, c.out), 'utf8')); } catch { retry.push(c.in); continue; }
    let failed = 0;
    for (const [id, v] of Object.entries(input)) {
      const r = out[id];
      if (empty(r) || shape(r) !== shape(v)) { bad.push(id); failed++; continue; }
      const s = map.get(id), body = render(text.slice(s.start, s.end), r);
      const t = m.to && map.get(id.replace(/[^.]+$/, m.to));
      if (m.into) {
        const e = place(dmap, id, body);
        if (e) edits.push(e); else { bad.push(id); failed++; }
      } else if (!m.to || t) edits.push({ at: (t || s).start, end: (t || s).end, body });
      else edits.push({ at: s.end, end: s.end, body: `,${s.lead}${JSON.stringify(m.to)}: ${body}` });
    }
    if (failed) retry.push(c.in);
  }
  let res = dtext;
  // Back to front so offsets stay valid; same-spot appends last-first so they keep source order.
  for (const e of edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.at - a.at || b.i - a.i)) res = res.slice(0, e.at) + e.body + res.slice(e.end);
  JSON.parse(res); // never write a broken file
  fs.writeFileSync(dest, res);
  // What is left to retry: re-run its workers, then merge again.
  const left = m.chunks.filter(c => retry.includes(c.in));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, [m.into ? 'intoHash' : 'hash']: sha(res), total: left.reduce((a, c) => a + c.n, 0), chunks: left }, null, 2));
  return { merged: edits.length, total: m.total, bad, retry };
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, name === '--all' ? 1 : 2)[1] ?? true; };
  try {
    if (cmd === 'chunk') {
      const to = flag('--to'), into = flag('--into'), all = !!flag('--all'), cfg = settings(process.cwd(), 'bulk');
      const [src, pattern, dir] = args;
      const m = chunk(src, pattern, dir, { to, into, all, kb: cfg.chunkKB || 8 });
      console.log(`${m.total} values in ${m.chunks.length} chunks → ${path.resolve(dir)}`);
      console.log(`style: ${cfg.style ? path.resolve(cfg.style) : 'none (set bulk.style in .opticc.json)'}`);
      for (const c of m.chunks) console.log(`${c.in} → ${c.out} (${c.n})`);
    } else if (cmd === 'merge') {
      const r = merge(...args);
      console.log(`merged ${r.merged}/${r.total}` + (r.bad.length ? `; bad or missing: ${r.bad.slice(0, 10).join(', ')}${r.bad.length > 10 ? ' …' : ''}` : '') +
        (r.retry.length ? `; retry: ${r.retry.join(' ')}` : ''));
    } else {
      console.log('usage: bulk.js chunk <src.json> <pattern> <workdir> [--to <key> | --into <other.json>] [--all] | bulk.js merge <workdir> <src.json> [<other.json>]');
      process.exitCode = 2;
    }
  } catch (e) { console.error('bulk: ' + e.message); process.exitCode = 1; }
}
module.exports = { select, spans, render, chunk, merge };
