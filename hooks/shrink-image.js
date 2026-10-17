#!/usr/bin/env node
// PreToolUse(Read): point Read at a half-size copy of a large image, so the
// screenshot costs about a quarter of the tokens. Reading the same unchanged
// image again within 10 minutes gets the original. Fails open.
'use strict';
const fs = require('fs');
const path = require('path');
const { settings, dataDir, count } = require('./common');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// extension -> ImageMagick coder, forced so a disguised file (SVG/MVG/text) is never sniffed
const CODERS = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif', bmp: 'bmp' };
const MIN_SIDE = 800;           // never shrink the long side below this
const FULL_AGAIN_MS = 10 * 60e3;

function config(cwd) {
  const c = settings(cwd, 'shrinkImages');
  return { off: c.off === true, minSide: c.minSide || MIN_SIDE };
}

// Percentage to resize to, or null when the image is already small enough.
function scalePercent(w, h, minSide) {
  const long = Math.max(w, h);
  const pct = Math.round(100 * Math.max(long / 2, minSide) / long);
  return pct < 100 ? pct : null;
}

// Rough tokens Claude bills for an image: downscaled to a 1568 px long side, ~750 px² per token, capped.
function imageTokens(w, h) {
  const s = Math.min(1, 1568 / Math.max(w, h));
  return Math.min(1600, w * h * s * s / 750);
}

// Only where Read needs no permission prompt anyway: the project and this
// session's scratchpad. Elsewhere the rewrite would skip the user's prompt.
function allowed(file, cwd) {
  const scratch = path.join('/tmp', `claude-${process.getuid()}`, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  return [cwd, scratch].some(root => file.startsWith(root + path.sep));
}

// Returns the hook's JSON output, or null to let Read see the original file.
function shrink(input, now = Date.now()) {
  const file = input.tool_input && input.tool_input.file_path;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const coder = CODERS[path.extname(file).slice(1).toLowerCase()];
  const cwd = input.cwd || process.cwd();
  if (!coder || !allowed(fs.realpathSync(file), cwd)) return null;
  const cfg = config(cwd);
  if (cfg.off) return null;
  const st = fs.statSync(file);
  const dir = dataDir('images');
  const key = crypto.createHash('sha1').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 16);
  const copy = path.join(dir, key + path.extname(file).toLowerCase());
  const seen = path.join(dir, key + '.seen');
  // a second look at the same image means the small one was not enough
  try { if (now - fs.statSync(seen).mtimeMs < FULL_AGAIN_MS) { fs.unlinkSync(seen); return null; } } catch { /* first look */ }
  const [w, h] = execFileSync('identify', ['-format', '%w %h', `${coder}:${file}[0]`], { timeout: 3000 }).toString().split(' ').map(Number);
  const pct = scalePercent(w, h, cfg.minSide);
  if (!pct) return null;
  if (!fs.existsSync(copy)) {
    execFileSync('convert', [`${coder}:${file}[0]`, '-resize', pct + '%', `${coder}:${copy}`], { timeout: 4000 });
    fs.chmodSync(copy, 0o600);
  }
  fs.writeFileSync(seen, '', { mode: 0o600 });
  count('image', imageTokens(w, h) - imageTokens(w * pct / 100, h * pct / 100));
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
module.exports = { shrink, scalePercent, imageTokens };
