'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { guard } = require('../hooks/agent-guard');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-agent-'));
process.env.CLAUDE_PLUGIN_DATA = tmp;
const call = (tool_input, cwd = tmp) => ({ cwd, tool_name: 'Agent', tool_input });
const BRIEF = 'Fix the null check in lib/a.dart. Reply in ≤5 lines.';

test('fork is denied once, the same fork again within a minute goes through', () => {
  const fork = call({ subagent_type: 'fork', prompt: 'translate everything', description: 'x' });
  const first = guard(fork).hookSpecificOutput;
  assert.strictEqual(first.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /fresh agent/);
  assert.strictEqual(guard(fork), null);
  assert.strictEqual(guard(fork, Date.now() + 2 * 60e3).hookSpecificOutput.permissionDecision, 'deny', 'a later fork is denied again');
});

test('a focused brief starts silently', () => {
  assert.strictEqual(guard(call({ subagent_type: 'general-purpose', prompt: BRIEF })), null);
});

test('Opus, large files and open-ended prompts get a warning, not a block', () => {
  fs.writeFileSync(path.join(tmp, 'cards.json'), 'x'.repeat(300 * 1024));
  fs.writeFileSync(path.join(tmp, 'big.dart'), 'x'.repeat(300 * 1024));
  fs.mkdirSync(path.join(tmp, 'build'));
  fs.writeFileSync(path.join(tmp, 'build', 'out.json'), 'x'.repeat(300 * 1024));
  const w = guard(call({ model: 'opus', prompt: 'Translate cards.json, fix big.dart, see build/out.json' })).hookSpecificOutput;
  assert.strictEqual(w.permissionDecision, undefined);
  assert.match(w.additionalContext, /Opus/);
  assert.match(w.additionalContext, /cards\.json \(300 KB\)/);
  assert.doesNotMatch(w.additionalContext, /big\.dart|out\.json/);
  assert.match(w.additionalContext, /what to return/);
});

test('opt-out and odd input', () => {
  fs.writeFileSync(path.join(tmp, '.opticc.json'), '{"agentGuard":{"off":true}}');
  assert.strictEqual(guard(call({ subagent_type: 'fork', prompt: 'x' })), null);
  fs.unlinkSync(path.join(tmp, '.opticc.json'));
  assert.strictEqual(guard({ tool_input: {} }), null);
  assert.strictEqual(guard({}), null);
});
