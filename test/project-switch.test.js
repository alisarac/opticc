'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('../hooks/project-switch');

process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-switch-'));
const prompt = (cwd, session_id = 's1') => ({ cwd, session_id, transcript_path: `/h/.claude/projects/-home-u-projects-fikirler/${session_id}.jsonl` });

test('same project or a subdir of it stays quiet', () => {
  assert.strictEqual(check(prompt('/home/u/projects/fikirler')), null);
  assert.strictEqual(check(prompt('/home/u/projects/fikirler/docs')), null);
  assert.strictEqual(check(prompt('/tmp/claude-1000/x')), null);
});

test('another project is flagged once per session', () => {
  assert.match(check(prompt('/home/u/projects/haritaci')).systemMessage, /new session/);
  assert.strictEqual(check(prompt('/home/u/projects/haritaci')), null);
  assert.ok(check(prompt('/home/u/projects/haritaci', 's2')), 'a different session is told again');
});
