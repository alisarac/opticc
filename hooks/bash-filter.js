#!/usr/bin/env node
// PostToolUse(Bash): when a noisy build/test/log command prints a lot, keep the
// full output in a log file and hand Claude only the error lines, the tail and
// the log path. Any failure leaves the output untouched (fail open).
'use strict';
const fs = require('fs');
const path = require('path');
const { settings, dataDir, count } = require('./common');

const DEFAULTS = {
  minLines: 60,
  maxLines: 300,  // any other command: only the first maxLines reach Claude
  patterns: [
    'gradlew?', 'flutter\\s+(build|run|test|pub|analyze|doctor|drive)', 'dart\\s+(pub|analyze|test)',
    'adb\\s+(logcat|install)', '(npm|pnpm|yarn|bun)\\s+(install|ci|i|test|run\\s+(build|test|lint))',
    'cargo\\s+(build|test|check|clippy)', 'go\\s+(build|test)', 'pytest', 'pip3?\\s+install',
    'make\\b', 'docker\\s+(build|compose)', 'tsc\\b', 'next\\s+build', 'xcodebuild', 'pod\\s+install',
  ],
};
const MAX_ERRORS = 20;
const TAIL = 15;
const ERROR_RE = /\b(error|exception|failed|failure|fatal|panic|traceback)\b|^(E\/|e: )|✗|FAILURE:/i;

function config(cwd) {
  const c = settings(cwd, 'bashFilter');
  return { off: c.off === true, minLines: c.minLines || DEFAULTS.minLines, maxLines: c.maxLines || DEFAULTS.maxLines, patterns: DEFAULTS.patterns.concat(c.patterns || []) };
}

function isNoisy(command, patterns) {
  if (/#\s*raw\b/.test(command)) return false;  // escape hatch: append "# raw" to get the full output
  return patterns.some(p => new RegExp(`(^|[\\s;&|(/])${p}`).test(command));
}

function clean(text) {
  // drop ANSI colours; keep only the last frame of \r-redrawn progress lines
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n').map(l => l.slice(l.lastIndexOf('\r') + 1)).join('\n');
}

function summarize(lines, logPath) {
  const errors = [...new Set(lines.filter(l => ERROR_RE.test(l)).map(l => l.trim().slice(0, 200)))];
  const out = [`[opticc] ${lines.length} lines shortened · full log: ${logPath} (grep it, or rerun with "# raw")`];
  if (errors.length) out.push(`-- error lines (${Math.min(errors.length, MAX_ERRORS)} of ${errors.length}):`, ...errors.slice(0, MAX_ERRORS));
  out.push(`-- last ${TAIL} lines:`, ...lines.slice(-TAIL));
  return out.join('\n');
}

function writeLog(command, text) {
  const dir = dataDir('logs');  // owner-only: build logs can hold tokens and env values
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = command.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
  const file = path.join(dir, `${stamp}-${slug}-${require('crypto').randomBytes(4).toString('hex')}.log`);
  fs.writeFileSync(file, `$ ${command}\n${text}`, { flag: 'wx', mode: 0o600 });
  return file;
}

// Returns the hook's JSON output, or null to leave the tool output as it is.
function filter(input) {
  const command = input.tool_input && input.tool_input.command;
  const res = input.tool_response;
  if (typeof command !== 'string' || !res || typeof res.stdout !== 'string' || res.isImage) return null;
  const cfg = config(input.cwd || process.cwd());
  if (cfg.off || /#\s*raw\b/.test(command)) return null;
  const noisy = isNoisy(command, cfg.patterns);
  const text = clean([res.stdout, res.stderr].filter(Boolean).join('\n')).replace(/\n+$/, '');
  const lines = text.split('\n');
  if (lines.length < (noisy ? cfg.minLines : cfg.maxLines + 1)) return null;
  // a big file dump (cat/sed/grep…) was wanted, so keep its start rather than an error summary
  const summary = noisy ? summarize(lines, writeLog(command, text)) : lines.slice(0, cfg.maxLines).concat(
    `[opticc] ${lines.length - cfg.maxLines} more lines cut (${lines.length} in all) · full output: ${writeLog(command, text)} ` +
    '(read the range you need from it, or rerun with "# raw")').join('\n');
  count('bash', (text.length - summary.length) / 4);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...res, stdout: summary, stderr: '' } } };
}

if (require.main === module) {
  let data = '';
  process.stdin.on('data', d => { data += d; }).on('end', () => {
    try {
      const out = filter(JSON.parse(data));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open */ }
  });
}
module.exports = { filter, isNoisy, clean, DEFAULTS };
