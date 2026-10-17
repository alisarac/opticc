// /opticc: what the built-in /stats does not show, last 7 days vs the 7 before,
// read from the transcripts in ~/.claude/projects and the hooks' counters.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 864e5;
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : 0;
const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };
const short = project => project.replace(/^-home-[^-]+-(projects-)?/, '');

// Image tokens from the PNG header when there is one; JPEG etc. count as the cap.
function imageTokens(b64) {
  const buf = Buffer.from((b64 || '').slice(0, 64), 'base64');
  if (buf.slice(1, 4).toString() !== 'PNG') return 1600;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), s = Math.min(1, 1568 / Math.max(w, h));
  return Math.min(1600, w * h * s * s / 750);
}

function resultTokens(content) {
  if (typeof content === 'string') return content.length / 4;
  let n = 0;
  for (const c of content || []) n += c.type === 'image' ? imageTokens(c.source && c.source.data) : (c.text || '').length / 4;
  return n;
}

function emptyWindow() {
  return { total: 0, sub: 0, subModels: {}, subTypes: {}, turns: [], tools: {}, sessions: {}, projects: {} };
}

// One transcript file into the two windows. `sub` is the subagent's meta, or null for a main session.
function scanFile(file, w, seen, sub, session, project, now) {
  const tools = {};
  let turns = 0, win = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"') && !line.includes('"tool_result"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const age = now - Date.parse(j.timestamp);
    const wi = age < 7 * DAY ? w[0] : age < 14 * DAY ? w[1] : null;
    const m = j.message;
    if (!wi || !m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') tools[b.id] = b.name === 'Read' ? (/\.(png|jpe?g|gif|webp)$/i.test((b.input || {}).file_path || '') ? 'Read image' : 'Read text') : b.name;
      // what tool output a main session takes into its context
      if (b.type === 'tool_result' && !sub) add(wi.tools, tools[b.tool_use_id] || 'other', resultTokens(b.content));
    }
    const u = m.usage;
    if (!u || !m.id || seen.has(m.id)) continue;  // streamed messages repeat one usage per content block
    seen.add(m.id);
    const t = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    wi.total += t;
    add(wi.sessions, session, t);
    add(wi.projects, project, t);
    if (sub) {
      wi.sub += t;
      add(wi.subModels, (m.model || '?').replace(/^claude-/, ''), t);
      add(wi.subTypes, sub.isFork ? 'fork' : sub.agentType || '?', t);
      turns++;
      win = wi;
    }
  }
  if (win) win.turns.push(turns);
}

function collect(root, now = Date.now()) {
  const w = [emptyWindow(), emptyWindow()], seen = new Set();
  const fresh = f => { try { return now - fs.statSync(f).mtimeMs < 14 * DAY; } catch { return false; } };
  for (const project of fs.readdirSync(root)) {
    const pdir = path.join(root, project);
    let entries;
    try { entries = fs.readdirSync(pdir); } catch { continue; }
    for (const e of entries) {
      const p = path.join(pdir, e);
      if (e.endsWith('.jsonl')) { if (fresh(p)) scanFile(p, w, seen, null, short(project) + ' ' + e.slice(0, 8), short(project), now); continue; }
      const sdir = path.join(p, 'subagents');
      let subs;
      try { subs = fs.readdirSync(sdir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of subs) {
        const fp = path.join(sdir, f);
        if (!fresh(fp)) continue;
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(fp.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* old agents have none */ }
        scanFile(fp, w, seen, meta, short(project) + ' ' + e.slice(0, 8), short(project), now);
      }
    }
  }
  return w;
}

// Hook counters ({t, k, n} lines) from the last 7 days.
function readCounts(dir, now = Date.now()) {
  const c = {};
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return c; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      try {
        const j = JSON.parse(line);
        if (now - j.t < 7 * DAY) { c[j.k] = c[j.k] || { times: 0, n: 0 }; c[j.k].times++; c[j.k].n += j.n; }
      } catch { /* blank or torn line */ }
    }
  }
  return c;
}

function report([a, b], counts) {
  const rows = (o, total, n = 5) => Object.entries(o).filter(e => e[1] >= 1).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `  ${k.padEnd(26)} ${fmt(v).padStart(7)}  ${pct(v, total)}`);
  const two = (label, x, y) => `  ${label.padEnd(26)} ${x.padStart(7)}  ${y.padStart(7)}`;
  const toolsA = Object.values(a.tools).reduce((s, v) => s + v, 0), toolsB = Object.values(b.tools).reduce((s, v) => s + v, 0);
  const c = k => counts[k] || { times: 0, n: 0 };
  const out = [
    'opticc — last 7 days vs previous 7',
    two('', 'last 7', 'prev 7'),
    two('all tokens', fmt(a.total), fmt(b.total)),
    two('subagent share', pct(a.sub, a.total), pct(b.sub, b.total)),
    two('subagent median turns', String(median(a.turns)), String(median(b.turns))),
    two('subagents run', String(a.turns.length), String(b.turns.length)),
    two('tool output into context', fmt(toolsA), fmt(toolsB)),
    '', 'subagent tokens by model (last 7)', ...rows(a.subModels, a.sub),
    '', 'subagent tokens by type (last 7)', ...rows(a.subTypes, a.sub),
    '', 'tool output into main context by tool (last 7, ~tokens)', ...rows(a.tools, toolsA, 6),
    '', 'opticc effect (last 7)',
    `  bash output shortened      ${String(c('bash').times).padStart(4)}×  ~${fmt(c('bash').n)} tokens kept out`,
    `  images shrunk              ${String(c('image').times).padStart(4)}×  ~${fmt(c('image').n)} tokens kept out`,
    `  forks denied               ${String(c('fork').times).padStart(4)}×`,
    `  agent prompts warned       ${String(c('agentWarn').times).padStart(4)}×`,
    '', 'costliest sessions (last 7)', ...rows(a.sessions, a.total),
    '', 'costliest projects (last 7)', ...rows(a.projects, a.total),
  ];
  return out.join('\n');
}

if (require.main === module) {
  const data = process.env.CLAUDE_PLUGIN_DATA || [path.join(os.homedir(), '.claude', 'plugins', 'data', 'opticc-opticc'), path.join(os.homedir(), '.cache', 'opticc')].find(fs.existsSync) || '';
  console.log(report(collect(path.join(os.homedir(), '.claude', 'projects')), readCounts(path.join(data, 'counts'))));
}
module.exports = { collect, readCounts, report, imageTokens };
