'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, readCounts, report } = require('../scripts/stats');
const { count } = require('../hooks/common');

const now = Date.parse('2026-10-17T12:00:00Z');
const at = days => new Date(now - days * 864e5).toISOString();
const turn = (id, days, tokens, model = 'claude-opus-5-5', content = []) =>
  JSON.stringify({ timestamp: at(days), message: { id, model, content, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens } } });
const result = (days, toolId, text) => JSON.stringify({ timestamp: at(days), message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] } });

test('splits tokens into windows, counts subagents once, attributes tool output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-stats-'));
  const proj = path.join(root, '-home-u-projects-demo');
  fs.mkdirSync(path.join(proj, 'abcdef12-x', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'abcdef12-x.jsonl'), [
    turn('m1', 1, 600, 'claude-opus-5-5', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    turn('m1', 1, 600),  // same message streamed twice
    result(1, 't1', 'x'.repeat(400)),
    turn('m2', 10, 50),  // previous window
  ].join('\n'));
  fs.writeFileSync(path.join(proj, 'abcdef12-x', 'subagents', 'agent-a.jsonl'), [turn('s1', 1, 300, 'claude-sonnet-5-5'), turn('s2', 1, 100, 'claude-sonnet-5-5')].join('\n'));
  fs.writeFileSync(path.join(proj, 'abcdef12-x', 'subagents', 'agent-a.meta.json'), '{"agentType":"Explore"}');

  const [a, b] = collect(root, now);
  assert.strictEqual(a.total, 1000);
  assert.strictEqual(b.total, 50);
  assert.strictEqual(a.sub, 400);
  assert.deepStrictEqual(a.subModels, { 'sonnet-5-5': 400 });
  assert.deepStrictEqual(a.subTypes, { Explore: 400 });
  assert.deepStrictEqual(a.turns, [2]);
  assert.deepStrictEqual(a.tools, { Bash: 100 });
  assert.deepStrictEqual(a.projects, { demo: 1000 });
  assert.match(report([a, b], {}), /subagent share\s+40%/);
});

test('hook counters land in the report', () => {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-counts-'));
  count('bash', 1200);
  count('fork');
  const c = readCounts(path.join(process.env.CLAUDE_PLUGIN_DATA, 'counts'));
  assert.deepStrictEqual(c.bash, { times: 1, n: 1200 });
  assert.match(report(collect(fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-empty-'))), c), /forks denied\s+1×/);
});
