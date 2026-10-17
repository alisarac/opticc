#!/usr/bin/env node
// UserPromptSubmit: the costliest session of a week began as brainstorming in one
// project and went on for days building another. When the working directory has
// left the project the session started in, tell the user once that a fresh session
// there would start small. Shown to the user only (systemMessage), so it costs no tokens.
'use strict';
const fs = require('fs');
const path = require('path');
const { settings, dataDir, count } = require('./common');

// Claude Code names a session's transcript dir after its starting cwd this way.
const slug = dir => dir.replace(/[^A-Za-z0-9]/g, '-');

// Returns the hook's JSON output, or null when the session is still at home.
function check(input) {
  const cwd = input.cwd, transcript = input.transcript_path;
  if (typeof cwd !== 'string' || typeof transcript !== 'string' || !input.session_id) return null;
  const home = path.basename(path.dirname(transcript));
  const here = slug(cwd);
  if (here === home || here.startsWith(home + '-') || cwd.startsWith('/tmp/')) return null;
  if (settings(cwd, 'projectSwitch').off === true) return null;
  const mark = path.join(dataDir('switch'), `${input.session_id}-${here}`.slice(0, 200));
  if (fs.existsSync(mark)) return null;  // once per session and project
  fs.writeFileSync(mark, '', { mode: 0o600 });
  count('switch');
  return { systemMessage: `[opticc] This session started elsewhere and is now working in ${cwd}. ` +
    'A new session opened there (with a short handoff) starts small instead of carrying this whole history.' };
}

if (require.main === module) {
  let data = '';
  process.stdin.on('data', d => { data += d; }).on('end', () => {
    try {
      const out = check(JSON.parse(data));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open */ }
  });
}
module.exports = { check };
