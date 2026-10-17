#!/usr/bin/env node
// SessionStart + SubagentStart: a short set of working rules that make each change
// cost less (less code, narrower reads, shorter replies). Subagents get them too,
// except the bulk worker, whose own prompt is already minimal.
'use strict';
const { settings } = require('./common');

const RULES = `[opticc rules]
Smallest complete change. Before adding code ask, in order: is it needed at all; does this codebase already have it; does the standard library or platform; an installed dependency; can it be one clear line. Only then write the minimum that works, but finish every caller, test and fixture the change touches.
Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything the user asked for.
Branching, loops, parsers, money or security logic get one small test. A deliberate shortcut gets a comment: \`shortcut: <its limit>, <when to upgrade>\`.
Reading: grep first, then read only the line range you need; never re-read a file you just edited.
Replies: short and plain; say what you did not check.`;

// Returns the hook's JSON output, or null when nothing should be added.
function inject(input) {
  const event = input.hook_event_name;
  if (event !== 'SessionStart' && event !== 'SubagentStart') return null;
  if (event === 'SubagentStart' && /(^|:)worker$/.test(input.agent_type || '')) return null;
  if (typeof input.cwd === 'string' && settings(input.cwd, 'rules').off === true) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: RULES } };
}

if (require.main === module) {
  let data = '';
  process.stdin.on('data', d => { data += d; }).on('end', () => {
    try {
      const out = inject(JSON.parse(data));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open */ }
  });
}
module.exports = { inject, RULES };
