#!/usr/bin/env node
// PreToolUse(Read): point Read at a half-size copy of a large image, so the
// screenshot costs about a quarter of the tokens. Reading the same unchanged
// image again within 10 minutes gets the original. Fails open.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MIN_SIDE = 800;           // never shrink the long side below this
const FULL_AGAIN_MS = 10 * 60e3;

function config(cwd) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(cwd, '.opticc.json'), 'utf8')).shrinkImages || {};
    return { off: c.off === true, minSide: c.minSide || MIN_SIDE };
  } catch { return { off: false, minSide: MIN_SIDE }; }
}

// Percentage to resize to, or null when the image is already small enough.
function scalePercent(w, h, minSide) {
  const long = Math.max(w, h);
  const pct = Math.round(100 * Math.max(long / 2, minSide) / long);
  return pct < 100 ? pct : null;
}

function cacheDir() {
  const dir = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'opticc'), 'images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const weekAgo = Date.now() - 7 * 864e5;
  for (const f of fs.readdirSync(dir)) {
    try { if (fs.statSync(path.join(dir, f)).mtimeMs < weekAgo) fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
  return dir;
}

// Returns the hook's JSON output, or null to let Read see the original file.
function shrink(input, now = Date.now()) {
  const file = input.tool_input && input.tool_input.file_path;
  if (typeof file !== 'string' || !EXT_RE.test(file)) return null;
  const cfg = config(input.cwd || process.cwd());
  if (cfg.off) return null;
  const st = fs.statSync(file);
  const dir = cacheDir();
  if (file.startsWith(dir + path.sep)) return null;
  const key = crypto.createHash('sha1').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16);
  const copy = path.join(dir, key + path.extname(file).toLowerCase());
  const seen = path.join(dir, key + '.seen');
  // a second look at the same image means the small one was not enough
  try { if (now - fs.statSync(seen).mtimeMs < FULL_AGAIN_MS) { fs.unlinkSync(seen); return null; } } catch { /* first look */ }
  const [w, h] = execFileSync('identify', ['-format', '%w %h', file + '[0]'], { timeout: 3000 }).toString().split(' ').map(Number);
  const pct = scalePercent(w, h, cfg.minSide);
  if (!pct) return null;
  if (!fs.existsSync(copy)) {
    execFileSync('convert', [file + '[0]', '-resize', pct + '%', copy], { timeout: 4000 });
    fs.chmodSync(copy, 0o600);
  }
  fs.writeFileSync(seen, '', { mode: 0o600 });
  const note = `[opticc] ${path.basename(file)} shown at ${pct}% (${w}x${h} → ~${Math.round(w * pct / 100)}x${Math.round(h * pct / 100)}). Read the same path again for full resolution.`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, file_path: copy }, additionalContext: note } };
}

if (require.main === module) {
  let data = '';
  process.stdin.on('data', d => { data += d; }).on('end', () => {
    try {
      const out = shrink(JSON.parse(data));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open: no ImageMagick, unreadable file, bad input */ }
  });
}
module.exports = { shrink, scalePercent };
