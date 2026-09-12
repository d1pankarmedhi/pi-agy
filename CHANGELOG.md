# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.4.0] - 2026-09-13

### Added

- **Choose the agy model and effort from the terminal.** `/agy-model [slug]
  [--session]` and `/agy-effort [low|medium|high] [--session]` open a picker
  (models come from `agy models`, with the current one marked) or accept an
  explicit value, apply immediately to every later agy run, and save `model` +
  `effort` to `~/.pi/agy.json` — pass `--session` to skip the save. `Tab`
  completes model slugs and effort levels. A gemini slug sets the effort it
  encodes (`gemini-3.8-flash-low` → `low`); non-gemini models leave effort
  alone. New CLI flags `--agy-model <slug>` and `--agy-effort <level>` set the
  session default at launch, above env vars and the config file. Saving the user
  config file is the only disk write the extension performs.

### Fixed

- **Model/effort precedence no longer inverts.** The two fields are resolved per
  precedence level: an explicit `effort` only wins when it comes from the same
  or a higher level than the winning model, otherwise the effort encoded in the
  gemini slug wins. Previously the default `effort=high` silently rewrote
  `AGY_MODEL=gemini-3.8-flash-low`, and a file-level `effort` could override an
  env-level `model`. `saveUserConfig` now writes through an existing symlink
  (dotfile setups keep their link), the tool descriptions no longer bake in the
  startup model, and the model/effort commands only report env or flag overrides
  when they actually apply.

## [0.3.1] - 2026-09-12

### Changed

- README install examples now point at the current release instead of the
  stale `0.2.1` pin.

## [0.3.0] - 2026-09-12

### Added

- **Open-source release infrastructure and npm packaging.** GitHub Actions now
  provide `CI` (typecheck + tests on Node 22/24/26, publishable-tarball check,
  advisory runtime audit), `Release` (tag-driven npm publish with a signed
  provenance attestation and a generated GitHub Release), and `CodeQL`; plus
  Dependabot, issue/PR templates, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and
  `RELEASING.md`. `package.json` gains `engines.node >= 22.18`, an `exports`
  entry, and the `test:watch`, `pack:check`, `release:verify`, `preversion`, and
  `prepublishOnly` scripts.
- **The npm package is published as `@dmpunk/pi-agy`** under the `dmpunk` npm
  scope, because the bare name `pi-agy` is already taken on npm by an unrelated
  project. The project, repository, and tool names are unchanged; install with
  `pi install npm:@dmpunk/pi-agy`.

- **Live TUI upgrade — animated, information-dense cards and fleet surfaces.**
  Every surface now mirrors pi-subagents' live TUI quality:
  - Animated 10-frame braille spinner, liveness/staleness labels (`active 3s ago`,
    `active but long-running · last activity 1m ago`, `no activity for 2m`), live
    token + step metrics, tree-branched steps (`├─`/`└─`) and a live output tail
    (`⎿`) in every card, repainting every 100 ms while a run is in flight.
  - Compact single-run FleetView block, a `main` + children roster with
    running → queued → finished grouping, exact-width rows,
    `+N more (a running, b queued, c finished)` overflow and token totals.
  - Inspector: animated roster and header, liveness line, live output-tail
    section, `↓ Nk tokens` totals, `Shift+J`/`Shift+K` line scroll and an
    `x`/`Ctrl+O` tool-detail toggle.
  - `src/ui.ts` primitives: ANSI-preserving `truncLine`/`fitLine`,
    `spinnerGlyph`/`frameAt`, `treeBranch`/`treeIndent`, `formatTokens`,
    `formatActivityAge`; `src/status.ts` liveness API (`activityState`,
    `activityAgeMs`, `activityFreshnessText`, `toolDurationMs`); the runner now
    streams `lastActivityAt`, `toolStartedAt`, `outputTail`, `tokens` and `turns`.

- **Specialist roles (`agy_role`), modelled on pi-subagents' named agents.** A
  role bundles a shaped output contract with an access policy, because the same
  Gemini model produces much better work when it is told the exact shape to
  return — and because a review must not be able to quietly edit your code:
  - New `src/roles.ts` with five built-ins adapted from pi-subagents'
    scout/worker/reviewer/evidence-auditor/oracle: `scout` (read-only recon →
    `# Code Context` brief), `implementer` (edits + validation summary),
    `reviewer` (findings graded P0/P1/P2 with `file:line` evidence, or exactly
    `No issues found.`), `verifier` (audits claims as SUPPORTED /
    PARTIALLY SUPPORTED / UNSUPPORTED) and `oracle` (challenges the plan,
    never edits).
  - `applyRole` enforces the policy: read-only roles force
    `allowCommands: false` and a caller cannot raise it; the caller may still
    override model, effort and JSON schema.
  - New `agy_role` tool (renders as a `role` preset card showing the
    specialist). An unknown role fails fast with the list of known roles.
  - `agy_fleet` lanes accept `role`, so "run N specialists" works — the killer
    use case being a parallel `reviewer`/`verifier` panel. Roles are resolved
    up front, so an unknown lane role fails the whole call before any agent is
    spawned.
  - User roles or overrides live in `~/.pi/agy.json` under `roles`; a matching
    id merges over the built-in (prompt preserved), and a custom role that does
    not ask for write access is read-only by default.
- **`/agy-doctor` health check**, mirroring pi-subagents' `/subagents-doctor`.
  New `src/doctor.ts` reports the agy CLI and its version, whether the user
  config file parses (a malformed one is silently ignored at load time), the
  workspace, the permission mode (including the write-denial trap), available
  roles, whether the configured model exists in `agy models`, and the fallback
  chain. Every I/O dependency is injected, so the whole report is unit-tested.
- **Model fallback.** `AGY_FALLBACK_MODELS` (or `fallbackModels` in the config
  file) retries a failed run with the next model; an abort is never retried,
  the result reports the chain, and `meta.model` reports the model that
  actually ran.

- **Session fleet surface: a persistent FleetView widget and the `/agy-fleet`
  inspector.** pi-agy now keeps every agy run in one session-wide registry, so
  all parallel work is visible in one place instead of being scattered across
  individual tool cards:
  - New `src/registry.ts` (`FleetRegistry`) tracks each single
    `agy`/`agy_code`/`agy_vision`/`agy_role` call and every `agy_fleet` lane
    with its live activity, recent steps, metrics, and terminal evidence.
    Change notifications are debounced; finished runs are retained (newest 25)
    for the inspector and trimmed automatically. `agyFleetRegistry` is the
    module singleton the executors write to.
  - New `src/fleetview.ts` (`AgyFleetView`) registers a persistent widget below
    the editor while runs are active — collapsed it reads
    `3 active agents · 42 steps · 6 files · ↓/← to inspect`; pressing `↓`/`←` on
    an empty editor expands a selectable roster (`↑`/`↓`/`j`/`k`, `Esc` to
    collapse, `Enter` to inspect). The widget removes itself once every run has
    finished, leaving no residual surface.
  - New `src/inspector.ts` (`/agy-fleet`) opens a keyboard-driven overlay with
    a roster of live and recently finished runs beside the selected run's
    detail: status, live step/file/command, metrics
    (steps · files · commands · turns · tokens), evidence (files written,
    commands run), warnings, response, and recent steps. `↑`/`↓` select,
    `PgUp`/`PgDn` scroll, `g`/`G` jump, `r` refresh, `Esc` close. Without a TUI
    it degrades to a plain-text summary.
  - `executeAgy` and `executeFleet` now register their runs and stream live
    activity/steps/finish evidence into the registry; the pre-existing per-call
    cards, footer status, and board are unchanged.

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

### Removed

- **`agy_explore` — exploration now goes through `agy_role` and read-only
  `agy_fleet` lanes.** The dedicated tool was a second, weaker copy of the same
  prompt contract: it hard-coded a `list_dir`/`view_file`/`grep_search` guide and
  duplicated the read-only policy that roles already enforce.
  - Use `agy_role({ role: "scout", prompt })` for a single read-only recon pass
    (`# Code Context` brief), and read-only `agy_fleet` lanes (`role: "scout"`)
    when several areas need mapping in parallel.
  - The injected guidance now routes exploration to the `scout` role, and the
    `explore` preset was dropped from `AgyPreset`/`PRESETS`/`PRESET_LABEL` along
    with the tool. `agy_vision` and `agy_role` remain read-only by design.
  - Breaking for anyone calling `agy_explore` directly: the tool is no longer
    registered (a call fails as an unknown tool rather than silently doing
    something else).

### Fixed

- Truncated styled lines no longer reset SGR mid-line: `trunc`/`pad`/`row` and
  the card `View` now use an ANSI-style-preserving, grapheme-safe `truncLine`
  instead of pi-tui's `truncateToWidth`, so the tool background cannot bleed
  past an ellipsis.
- `~` paths resolved against the drive root on Windows (`~/dev/x` became
  `C:\dev\x`); `resolveLocalPath` now strips the separator before joining the
  home directory. The same path handling is shared by workspaces and vision
  images.
- Metric chips and subtitles drop at token boundaries (no mid-word `…`),
  and every card line is width-clamped so output never overflows the column.
- Failed runs no longer render as green `✓ done`: renderers read pi's
  `context.isError` and show the error text (`✗ failed`) instead of a fake
  success card. Applies to `agy`/`agy_code`/`agy_vision`/`agy_role` and `agy_fleet`.
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
- **`files_written` evidence is now verified against the filesystem, and denied
  actions are surfaced.** Reproduced against the real CLI: a permission-denied
  `write_to_file` is reported by agy with step state `DONE`, overall
  `status: SUCCESS`, and no error text — the denial appears only as
  `denied_actions` on the final result, *after* the step events have already
  been counted. pi-agy therefore listed the path in `files_written` and printed
  `✓ step N · ✎ <file>` for a file that was never created, which defeats the
  whole "evidence the orchestrator verifies" workflow. Now:
  - New `splitExistingFiles(files, workspace, exists?)` in `src/runner.ts`
    resolves every claimed path against the workspace and keeps only those that
    exist; phantom paths are dropped from `files_written` and reported as a
    warning ("N files the agent reported writing do not exist on disk").
  - Only a step whose state is exactly `DONE` counts as success; `ERROR`-state
    steps (e.g. a write into a missing directory) no longer contribute evidence.
  - `StepRecord.state` gains `"failed"`; the run log renders `✗` for failed
    steps and the card header shows `· N failed`.
  - Any `denied_actions` and any failed step now emit an explicit warning, so a
    lane that silently did nothing can no longer look like a clean success.
- **`agy_fleet` results are readable by the orchestrator.** Per-lane responses
  were hard-truncated to 600 characters and newlines flattened, so a lane's
  actual output was largely lost; an empty response rendered as a blank line
  (`??` never falls back for `""`) and per-lane warnings were dropped entirely.
  Lane responses now preserve line structure with a generous 4,000-character
  cap and an explicit truncation marker, empty responses render as
  `(no response)`, and each lane's warnings are printed.
- **An aborted fleet returns its partial results.** `executeFleet` threw
  `agy_fleet aborted` and discarded every lane result; it now returns the board
  with per-lane evidence it collected before the stop and marks the run as
  stopped early.
- **Registry listener isolation and defensive copies.** A throwing FleetView
  subscriber could skip the remaining listeners in `emitNow()` and crash the
  event loop from the `emitSoon()` timer; listeners are now invoked through a
  `try/catch`. `patch()`/`finish()` also clone array fields
  (`recent`, `filesWritten`, `commandsRun`, `filesTouched`) so a caller mutating
  its own array cannot corrupt stored state or defeat change detection.
- **FleetView/Inspector hardening.** `j`/`k` navigation now uses `matchesKey` so
  it works under the Kitty keyboard protocol; the roster windows around the
  selection instead of letting the marker scroll off past six runs; the 500 ms
  refresh timer is armed only while runs are active instead of ticking through
  idle sessions; width is sanitized before layout; the editor-focus probe is
  wrapped in `try/catch`; and the inspector re-clamps its selection against a
  shrinking registry, pads the title row so the frame stays rectangular, and
  guards its timer with a `disposed` flag.

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