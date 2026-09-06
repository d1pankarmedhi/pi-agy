# Changelog

All notable changes to this project are documented in this file.

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