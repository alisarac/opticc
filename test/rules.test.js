'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inject, RULES } = require('../hooks/rules');

test('session and ordinary subagents get the rules', () => {
  assert.strictEqual(inject({ hook_event_name: 'SessionStart', cwd: '/nowhere' }).hookSpecificOutput.additionalContext, RULES);
  const sub = inject({ hook_event_name: 'SubagentStart', agent_type: 'general-purpose', cwd: '/nowhere' });
  assert.strictEqual(sub.hookSpecificOutput.hookEventName, 'SubagentStart');
});

test('the bulk worker, other events and opted-out projects get nothing', () => {
  assert.strictEqual(inject({ hook_event_name: 'SubagentStart', agent_type: 'opticc:worker' }), null);
  assert.strictEqual(inject({ hook_event_name: 'PreToolUse' }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-rules-'));
  fs.writeFileSync(path.join(dir, '.opticc.json'), '{"rules": {"off": true}}');
  assert.strictEqual(inject({ hook_event_name: 'SessionStart', cwd: dir }), null);
});

test('the always-loaded text stays small', () => {
  assert.ok(RULES.length / 4 < 250, `~${Math.round(RULES.length / 4)} tokens`);
});
