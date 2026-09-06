# Changelog

All notable changes to this project are documented in this file.

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