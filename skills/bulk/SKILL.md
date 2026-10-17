---
name: bulk
description: Bulk transform of many values in a JSON file (translate a language, rewrite or fix all texts, fill missing keys) via small chunks and cheap worker agents. Use for "çevir", "translate all", "hepsini …", "bu dosyadaki tüm metinler", repeated edits over a big JSON/ARB file.
---
Never read the big source file yourself and never give an agent the whole file. Only run the script and dispatch workers.

1. **Scope.** Settle the file, the values (a dotted pattern, `*` = any key or index, e.g. `*.*.*.en`) and the task (e.g. "translate en → de"). Peek at the structure with `node -e` or `head -c 800`, not Read.
2. **Chunk.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/bulk.js" chunk <src.json> '<pattern>' <workdir> [--to <sibling key>] [--all]`. The workdir goes in the session scratchpad. `--to de` writes the result next to the matched value under key `de`; `--into app_de.arb` writes it to the same path in another file (ARB: pattern `*`, `@` metadata keys are skipped, missing keys are appended). Both only pick values whose target is missing or empty (`--all` redoes all). With neither, values change in place. For several locales run one chunk/merge per locale, each in its own workdir. It prints the chunk → out pairs and the style file (`bulk.style` in `.opticc.json`, `bulk.chunkKB` = chunk size, default 8).
3. **Dispatch.** One `opticc:worker` agent per chunk, prompt only: `input: <workdir>/chunk-001.json  output: <workdir>/out-001.json  task: <task>  style: <file or none>`. Without a style file, put tone and form of address (e.g. German "du") in the task. Start the first one alone and wait, so the shared prefix gets cached, then the rest in parallel batches of `bulk.maxParallel` (default 4).
4. **Merge.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/bulk.js" merge <workdir> <src.json> [<other.json>]` (the same source, plus the `--into` file if used: workers can write the workdir, so merge won't take paths from it). It refuses when the source or target changed since chunking, skips missing, empty or reshaped answers (including lost `{placeholders}`) and keeps the file's layout and key order.
5. **Retry** once: re-run the workers for the chunks it lists, then merge again (the manifest now holds only those).
6. **Report** in one short line: merged N/total, failures, chunks left. Then run the project's own check (tests or validator) if it has one.
