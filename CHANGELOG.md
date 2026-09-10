# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **New `agy_vision` tool — image and screenshot tasks.** pi-agy can now
  delegate image work to agy's multimodal agent:
  - Inspect screenshots, UI mockups, diagrams, charts, and scanned pages by
    passing `images: ["shot.png", …]`; the agent opens the actual pixels with
    its `view_file` tool (never guessing from the filename).
  - **Local paths anywhere on disk.** `images` accepts workspace-relative,
    absolute, `~/…`, Git-Bash (`/c/Users/…` on Windows), and `file://` paths.
    Files outside the workspace are copied into a per-run temp directory
    (registered with agy via the repeatable `--add-dir` flag, de-duplicated by
    name, removed when the run ends), so `allowNonWorkspaceAccess` is no longer
    required. Missing paths are reported in the result instead of being skipped
    silently, and a call whose images are all unreadable fails fast. New
    `stageLocalImages`/`isRemotePath`/`resolveLocalPath` helpers.
  - Pass `url` to have the agent capture a headless-Chrome/Edge screenshot of a
    running page first, then inspect the captured file. `url` implies
    `allowCommands=true` (explicit `allowCommands` still wins).
  - **Read-only by default** — no `--dangerously-skip-permissions`; the prompt
    carries a no-shell guard so the agent uses `view_file`/`list_dir`/
    `grep_search` instead of attempting (auto-denied) shell calls.
  - Pair with `jsonSchema` for structured extraction (UI review findings, OCR
    fields, chart→data).
  - New `src/vision.ts` (`buildVisionPrompt`, `normalizeImages`, `isImagePath`,
    `resolveVisionAllowCommands`) plus a `vision` TUI preset that shows the
    image count and screenshot URL in the call card.
  - Injected opt-in guidance now routes image/screenshot subtasks to
    `agy_vision`.

- **Rich, responsive TUI cards for every agy tool.** Instead of a single
  status line, each tool now renders a purpose-built card via `renderCall` /
  `renderResult`:
  - _Call card_: tool + mode badge, resolved model/effort/agent/timeout,
    workspace, and a wrapped prompt preview.
  - _Streaming card_: phase glyph, current step, the file/command being worked
    on, elapsed time, live metrics (steps · files · commands), the recent step
    trail, and a tail preview of the agent's response while it writes.
  - _Result card_: outcome, full metrics (steps · files · commands · turns ·
    tokens), duration, response, ⚠️ warnings, workspace-relative evidence
    lists (`files`, `ran`), and a capped **run log** — all expandable with
    `Ctrl+O`.
  - _Fleet board & result_: per-lane status table (id, state, step, activity,
    elapsed) and a per-lane outcome/evidence summary.
- New `src/ui.ts` width-safe card primitives (`View`, `trunc`, `row`,
  `fitParts`, `wrap`) and `src/render.ts` card builders + renderer factories.
- Semantic per-tool glyphs (`✎` write/edit, `▤` read, `⌕` search, `⌂` list,
  `$` command) in step trails and run logs.
- Streaming `details` now carry `recent` (recent steps), `preview` (response
  tail), and `meta` (preset/model/effort/workspace/flags); fleet streaming
  details carry per-lane task, elapsed time, and result evidence.

### Changed

- **The agy tools are now opt-in.** The system-prompt guidance injected on
  every agent start no longer tells pi to delegate proactively. Pi is now
  instructed **not to call any agy tool** (and not to invoke the Antigravity
  agent in any other way) unless the user explicitly asks for agy in the
  current request; incidental words like “delegate”, “parallelize”, “fan out”,
  or “explore” do not count, and permission does not carry over between turns.
  Each tool description also leads with the same opt-in constraint. The
  verification workflow is unchanged for runs the user did ask for.
- Result cards are a status **continuation** of the call card (no duplicated
  tool title/header).
- Footer status is now step-aware: `agy ⟳ step 12 · ✎ src/a.ts · 42s`, and the
  fleet footer includes elapsed time.
- `toDisplayPath` now strips the workspace prefix with mixed path separators
  (Windows workspaces configured with `/`).
- The fleet footer is cleared when a run ends.

### Fixed

- `~` paths resolved against the drive root on Windows (`~/dev/x` became
  `C:\dev\x`); `resolveLocalPath` now strips the separator before joining the
  home directory. The same path handling is shared by workspaces and vision
  images.
- Metric chips and subtitles drop at token boundaries (no mid-word `…`),
  and every card line is width-clamped so output never overflows the column.
- Failed runs no longer render as green `✓ done`: renderers read pi's
  `context.isError` and show the error text (`✗ failed`) instead of a fake
  success card. Applies to `agy`/`agy_code`/`agy_explore` and `agy_fleet`.
- `files_written` evidence now only counts **mutating** tools (`write`/`edit`/
  `replace`/…); read-only exploration reads (`view_file`, `grep_search`, …) no
  longer appear as files the agent wrote. Live step trails still show reads
  (with a `▤` glyph).
- Live streaming metrics now include the command count, so the running card
  shows `steps · files · commands` as they happen; fleet failed lanes show
  their elapsed duration in the final card.
- Commands containing raw newlines are flattened before rendering (one entry
  per line array element), and `View` sanitizes stray newlines defensively.
- Metric/right-align budgets fixed (off-by-one) so trailing chips are dropped
  whole instead of clipped; long lane ids are truncated instead of overflowing;
  `step 0` is displayed (was treated as falsy); `fitParts` returns nothing for
  a zero-width budget; renderer guards against unknown presets and missing
  fields.

## [0.2.1] - 2026-09-06

### Changed

- Codebase modularized: `index.ts` (1251 lines) split into an entry point that
  only wires the extension plus focused `src/` modules with one-directional
  dependencies — `config.ts`, `model.ts`, `paths.ts`, `status.ts` (live
  activity lines), `fleet.ts` (fan-out board), `runner.ts` (agy stream
  parsing), `results.ts` (tool result assembly), `executors.ts` (shared tool
  execution), `tools.ts` (tool definitions). Public API unchanged; dead code
  (`WRITE_TOOLS`, unused imports) removed.

## [0.2.0] - 2026-09-06

### Added

- **Live status, subagent-style**: every agy run now streams a compact status
  line into the conversation while it works — `> step 4 · ✎ src/main.ts`
  while the agent is editing a file, `> step 5 · $ npm test` while it runs a
  command, `… thinking` / `… writing response` otherwise. A footer status
  (`agy ⟳ …`, `agy_fleet 2/4 done …`) mirrors the same state when a UI is
  present, and partial `details` carry structured `{ step, tool, file,
  command, filesTouched, elapsedMs }` for RPC/UI consumers.
- **`agy_fleet` tool**: fan out multiple agy agents on a list of tasks with
  bounded concurrency (default 3, max 8, `AGY_FLEET_CONCURRENCY` / `fleetConcurrency`
  config). Publishes a live per-lane board (like pi-subagents cards) with each
  lane's step/file/command, then returns per-lane status, response, files,
  commands, duration, and error for orchestrator verification.
- **Run log** in results: `Run log (N steps)` lists every tool step the agent
  performed, so you can see exactly what happened even after the run ends.
- Workspace-relative file paths in status lines (`src/main.ts` instead of the
  absolute path) for readability.

### Changed

- Accurate step accounting: tool steps are counted once per step index (agy
  emits both an `ACTIVE` and a `DONE` event per step), so `tool_steps` and the
  run log reflect real step counts.
- Orchestration guidance now covers `agy_fleet` (verify each lane's evidence).

## [0.1.1] - 2025

### Changed

- Orchestration + verification guidance is now injected **automatically** on
  every agent start. The `orchestrateAndVerify` config knob (env var / config
  file key) was removed — installation alone activates it; no manual system
  prompt edits or user configuration are needed.

## [0.1.0] - 2025

### Added

- `agy`, `agy_code`, and `agy_explore` tools delegating to Google Antigravity's
  headless CLI (`agy -p ... --output-format stream-json`).
- Streaming progress (text deltas forwarded live via tool updates).
- Verification metadata: `files_written` and `commands_run` parsed from the
  agent's tool stream, surfaced as `Evidence — …` in results and in `details`.
- Orchestrator mode (`orchestrateAndVerify`): appends pi system-prompt guidance
  to delegate to agy and verify outcomes (files exist, tests pass) before
  reporting success.
- Conversation continuity per workspace (`continueConv` / `conversation`).
- Headless permission-trap detection: `SUCCESS` + empty response + denied tool
  calls → actionable ⚠️ warning.
- Workspace path normalization (Git-Bash `~`/`/tmp` forms on Windows) and
  `--add-dir` registration so files land in the workspace.
- Model/effort consistency: gemini slugs auto-matched to the requested effort.
- `/agy` and `/agy-models` commands.
- Configuration via `AGY_*` env vars and optional `~/.pi/agy.json` user file —
  no files written by the extension, clean `pi remove`.