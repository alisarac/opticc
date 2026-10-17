'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { filter, isNoisy, clean, DEFAULTS } = require('../hooks/bash-filter');

const HOOK = path.join(__dirname, '..', 'hooks', 'bash-filter.js');
const rows = n => Array.from({ length: n }, (_, i) => `row ${i}`).join('\n');
const input = (command, stdout, extra = {}) => ({
  cwd: os.tmpdir(), tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false, ...extra },
});

test('noisy commands are recognised, plain ones are not', () => {
  for (const c of ['./gradlew assembleDebug', 'cd app && flutter build apk', 'adb logcat -d', 'npm run build', 'cargo test'])
    assert.ok(isNoisy(c, DEFAULTS.patterns), c);
  for (const c of ['cat build.gradle', 'git diff', 'sed -n 1,200p lib/main.dart', 'flutter build apk # raw', 'echo makefile'])
    assert.ok(!isNoisy(c, DEFAULTS.patterns), c);
});

test('long noisy output is shortened to errors + tail, full text logged', () => {
  const lines = rows(500).split('\n');
  lines[120] = 'e: file.kt:12 Unresolved reference: foo';
  const out = filter(input('./gradlew build', lines.join('\n'), { stderr: 'FAILURE: Build failed' }));
  const s = out.hookSpecificOutput.updatedToolOutput;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(s.stdout, /Unresolved reference/);
  assert.match(s.stdout, /FAILURE: Build failed/);
  assert.doesNotMatch(s.stdout, /row 250/);
  assert.strictEqual(s.stderr, '');
  assert.strictEqual(s.interrupted, false);
  const log = s.stdout.match(/full log: (\S+)/)[1];
  assert.match(fs.readFileSync(log, 'utf8'), /row 250/);
  fs.unlinkSync(log);
});

test('short output, plain commands and odd input are left alone', () => {
  assert.strictEqual(filter(input('./gradlew build', rows(10))), null);
  assert.strictEqual(filter(input('cat big.txt', rows(500))), null);
  assert.strictEqual(filter({ tool_input: { command: 'make' } }), null);
  assert.strictEqual(filter(input('make', '', { isImage: true })), null);
});

test('project config can switch it off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-'));
  fs.writeFileSync(path.join(dir, '.opticc.json'), '{"bashFilter":{"off":true}}');
  assert.strictEqual(filter({ ...input('make', rows(500)), cwd: dir }), null);
  fs.rmSync(dir, { recursive: true });
});

test('ANSI codes and carriage-return progress are cleaned', () => {
  assert.strictEqual(clean('\x1b[32mok\x1b[0m\n10%\r50%\r100%'), 'ok\n100%');
});

test('as a process: bad stdin exits 0 with no output', () => {
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});
