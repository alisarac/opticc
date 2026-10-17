'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { shrink, scalePercent } = require('../hooks/shrink-image');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-img-')));
process.env.CLAUDE_PLUGIN_DATA = tmp;
const png = (name, size) => {
  const f = path.join(tmp, name);
  execFileSync('convert', ['-size', size, 'xc:red', f]);
  return f;
};
const dims = f => execFileSync('identify', ['-format', '%w %h', f]).toString();
const read = file_path => ({ cwd: tmp, tool_input: { file_path } });

test('scale halves, but keeps the long side at least minSide', () => {
  assert.strictEqual(scalePercent(2000, 1000, 800), 50);
  assert.strictEqual(scalePercent(1000, 1200, 800), 67);
  assert.strictEqual(scalePercent(540, 800, 800), null);
});

test('large image is swapped for a half-size copy; second look gets the original', () => {
  const f = png('shot.png', '1600x2400');
  const out = shrink(read(f)).hookSpecificOutput;
  assert.strictEqual(out.hookEventName, 'PreToolUse');
  assert.strictEqual(dims(out.updatedInput.file_path), '800 1200');
  assert.match(out.additionalContext, /full resolution/);
  assert.strictEqual(shrink(read(f)), null);
  assert.ok(shrink(read(f)), 'third look shrinks again');
});

test('small images, other files and opt-out are left alone', () => {
  assert.strictEqual(shrink(read(png('icon.png', '512x512'))), null);
  assert.strictEqual(shrink(read(path.join(tmp, 'notes.md'))), null);
  fs.writeFileSync(path.join(tmp, '.opticc.json'), '{"shrinkImages":{"off":true}}');
  assert.strictEqual(shrink(read(png('big.png', '3000x3000'))), null);
  fs.unlinkSync(path.join(tmp, '.opticc.json'));
});

test('paths outside the project, relative paths and disguised files are refused', () => {
  const big = png('outside.png', '2000x2000');
  assert.strictEqual(shrink({ cwd: path.join(tmp, 'sub'), tool_input: { file_path: big } }), null);
  assert.strictEqual(shrink({ cwd: tmp, tool_input: { file_path: 'outside.png' } }), null);
  const link = path.join(tmp, 'link.png');
  fs.symlinkSync(png('../' + path.basename(tmp) + '-escape.png', '2000x2000'), link);
  assert.strictEqual(shrink(read(link)), null, 'symlink leading out of the project');
  const fake = path.join(tmp, 'fake.png');
  fs.writeFileSync(fake, 'push graphic-context\nviewbox 0 0 2000 2000\npop graphic-context\n');
  assert.throws(() => shrink(read(fake)), 'MVG content is not decoded as PNG');
});
