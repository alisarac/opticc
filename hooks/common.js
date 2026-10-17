// Shared by the hooks: per-project settings and the private data dir.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// The `key` section of <cwd>/.opticc.json, or {} when absent or unreadable.
function settings(cwd, key) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.opticc.json'), 'utf8'))[key] || {}; } catch { return {}; }
}

// Owner-only <data>/<name>/, with files older than a week pruned.
function dataDir(name) {
  const dir = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'opticc'), name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const weekAgo = Date.now() - 7 * 864e5;
  for (const f of fs.readdirSync(dir)) {
    try { if (fs.statSync(path.join(dir, f)).mtimeMs < weekAgo) fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
  return dir;
}

// One line per opticc action for /opticc: {t, k: kind, n: tokens kept out or 1}.
function count(k, n = 1) {
  try {
    const file = path.join(dataDir('counts'), new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), k, n: Math.round(n) }) + '\n', { mode: 0o600 });
  } catch { /* counting must never break a hook */ }
}

module.exports = { settings, dataDir, count };
