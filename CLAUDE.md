# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`opticc` — Ali's personal Claude Code plugin for spending fewer tokens per correct change. `plugin-brief.md` (Turkish) is the spec; **its §0 (17 Oct 2026 revision, based on measured usage) overrides the rest**. Measured facts that drive priorities: ~98 % of usage is cache reads (context re-billed every request), subagents were 51 %, and Bash output is ~81 % of tool output entering context.

v0.1 order: Bash output filter ✅ → screenshot shrinking ✅ → `agent-guard` → `/stats`. `bulk`/`worker` and rule injection are v0.2. The context-size warning already lives outside the plugin (`~/.claude/hooks/context-budget.py`) — don't duplicate it.

## Hard constraints

- Subscription only: never `claude -p`, the Anthropic API or Batch API.
- Hooks fail open (any error → exit 0, no output), timeouts ≤ 5 s, Node stdlib only, no npm deps, no network, no telemetry.
- Per-project settings: optional `.opticc.json` at the project root (e.g. `{"bashFilter": {"off": true, "minLines": 60, "patterns": ["…"]}}`); defaults when absent.
- Ponytail is reference only: never copy its code or use its name.

## Layout

- `.claude-plugin/plugin.json` + `marketplace.json` — the repo is both the plugin and its own local marketplace (`source: "./"`).
- `hooks/hooks.json` — hook registrations, commands use `node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js"`.
- `hooks/bash-filter.js` — PostToolUse(Bash): for commands matching noisy patterns (gradle, flutter, adb logcat, npm/cargo build…) with ≥ 60 lines, writes the full output (mode 600, pruned after 7 days) to `$CLAUDE_PLUGIN_DATA/logs/` (fallback `~/.cache/opticc/logs/`) and replaces what Claude sees via `updatedToolOutput` with error lines + last 15 lines + log path. `# raw` in the command opts out.
- `hooks/shrink-image.js` — PreToolUse(Read): for image files, ImageMagick (`identify`/`convert`) makes a copy at 50 % (long side never below 800 px) in `…/images/`, and `updatedInput` points Read at it. Reading the same unchanged file again within 10 min gets the original. `.opticc.json` `{"shrinkImages": {"off": true, "minSide": 800}}`. Each hook exports its pure logic for tests and only reads stdin under `require.main === module`.

## Commands

```bash
node --test                          # all tests (not `node --test test/` — Node 22 treats that as a module)
node --test test/bash-filter.test.js # one file
claude plugin update opticc@opticc   # installed copy is cached in ~/.claude/plugins/cache — edits need this (bump version in plugin.json), then /reload-plugins
```
