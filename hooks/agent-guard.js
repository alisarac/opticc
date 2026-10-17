#!/usr/bin/env node
// PreToolUse(Agent): subagents were half of all usage. A fork re-sends the whole
// parent context on Opus every turn, so the first try is denied (the same call
// again within a minute goes through); costly-looking prompts get a warning.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { settings, dataDir, count } = require('./common');

const FORK_AGAIN_MS = 60e3;
const BIG_FILE_KB = 100;
// Data files an agent tends to read whole (the 306 KB cards.json case). Source it
// edits, binaries, logs and tool dirs (.folio/, build/) are left out: measured as noise.
const DATA_RE = /\.(json|csv|tsv|arb|ya?ml|xml|md|txt|sql)$/i;
const SKIP_RE = /(^|\/)(\.[^\/]+|build|node_modules)\//;
const DELIVERABLE_RE = /\b(return|report|summar|reply|respond|output|list|at most|under \d+|words|lines|bullets?)\b|≤|döndür|özet|rapor|satır|kelime|madde|en fazla|listele/i;

// Files over the size limit that the prompt names, as "path (N KB)".
function bigFiles(prompt, cwd, limitKB) {
  const found = new Set();
  for (const tok of (prompt.match(/[~\w.\/-]+\.\w+/g) || []).slice(0, 50)) {
    if (!DATA_RE.test(tok) || SKIP_RE.test(tok)) continue;
    const file = path.resolve(cwd, tok.replace(/^~(?=\/)/, require('os').homedir()));
    try {
      const kb = Math.round(fs.statSync(file).size / 1024);
      if (kb > limitKB) found.add(`${tok} (${kb} KB)`);
    } catch { /* not a file */ }
  }
  return [...found];
}

// Returns the hook's JSON output, or null to let the agent start silently.
function guard(input, now = Date.now()) {
  const t = input.tool_input;
  if (!t || typeof t.prompt !== 'string') return null;
  const cwd = input.cwd || process.cwd();
  const cfg = settings(cwd, 'agentGuard');
  if (cfg.off === true) return null;
  const out = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...reason } });

  if (t.subagent_type === 'fork') {
    const mark = path.join(dataDir('agents'), crypto.createHash('sha1').update(t.prompt).digest('hex').slice(0, 16));
    try { if (now - fs.statSync(mark).mtimeMs < FORK_AGAIN_MS) { fs.unlinkSync(mark); return null; } } catch { /* first try */ }
    fs.writeFileSync(mark, '', { mode: 0o600 });
    count('fork');
    return out({ permissionDecision: 'deny', permissionDecisionReason:
      '[opticc] Fork denied once: it re-sends this whole conversation on Opus every turn. Start a fresh agent (no subagent_type: fork) ' +
      'with a short self-contained brief instead. If the task truly needs this context, repeat the exact same call within a minute.' });
  }

  const warn = [];
  if (/opus/i.test(t.model || '')) warn.push('model is Opus: use Sonnet unless the task really needs Opus.');
  const big = bigFiles(t.prompt, cwd, cfg.bigFileKB || BIG_FILE_KB);
  if (big.length) warn.push(`prompt names large files ${big.join(', ')}: the agent re-sends whatever it reads every turn, so point it at the lines or section it needs.`);
  if (!DELIVERABLE_RE.test(t.prompt)) warn.push('prompt does not say what to return: ask for a short result (e.g. "reply in ≤10 lines"), since the report lands in this context.');
  if (warn.length) count('agentWarn');
  return warn.length ? out({ additionalContext: '[opticc] agent-guard: ' + warn.join(' ') }) : null;
}

if (require.main === module) {
  let data = '';
  process.stdin.on('data', d => { data += d; }).on('end', () => {
    try {
      const out = guard(JSON.parse(data));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open */ }
  });
}
module.exports = { guard, bigFiles };
