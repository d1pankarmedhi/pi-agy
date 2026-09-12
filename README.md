# pi-agy

[![CI](https://github.com/d1pankarmedhi/pi-agy/actions/workflows/ci.yml/badge.svg)](https://github.com/d1pankarmedhi/pi-agy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-agy-cli.svg)](https://www.npmjs.com/package/pi-agy-cli)
[![npm downloads](https://img.shields.io/npm/dm/pi-agy-cli.svg)](https://www.npmjs.com/package/pi-agy-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-blue.svg)](package.json)

Delegate low-level tasks — writing code, exploring a codebase, research passes,
inspecting screenshots and images — to Google Antigravity's
[agy CLI](https://antigravity.google/docs/cli/headless/) running a Gemini agent.
Pi stays the **orchestrator**: once you ask for it, it farms out subtasks to agy
(`agy`, `agy_code`, `agy_vision`, `agy_role`, `agy_fleet` tools), then
**verifies** the agent's work itself before reporting success.

> **Opt-in.** pi-agy never delegates on its own. Pi only calls the agy tools when
you explicitly ask for agy in that request (e.g. “use agy”, “delegate this to
agy”, “run agy_fleet”, “use Antigravity”). Otherwise pi does the work with its
normal tools. See [Orchestration pattern](#orchestration-pattern-pi--orchestrator-agy--subagent--opt-in).

Unlike a black box, every run is observable: a live, responsive card in the
conversation shows what the agent is doing in real time — the current step and
the file it is writing/editing or command it is running, plus running metrics
(steps, files, commands, turns, tokens) and a recent step trail. When the run
finishes the card shows the outcome, the agent's response, the evidence an
orchestrator verifies against (files written, commands run), and a full **run
log** of every tool step. `agy_fleet` fans out multiple agy agents on a list of
tasks with bounded concurrency and a live per-lane board.

Install / uninstall through pi like any other package (`pi-web-access`,
`pi-mcp-adapter`, …). The extension never writes to disk, so uninstalling
leaves **zero residue**.

## Requirements

- `agy` CLI installed and authenticated once (`agy -p "hi"` works in a terminal).
- Headless mode uses your cached credentials; no interactive login needed.

## Install

```bash
# from npm (recommended; pin a version for reproducibility)
pi install npm:pi-agy-cli
pi install npm:pi-agy-cli@0.2.1

# from GitHub at a release tag
pi install git:github.com/d1pankarmedhi/pi-agy@v0.2.1

# from a local checkout (development)
pi install /absolute/path/to/pi-agy
```

Uninstall:

```bash
pi list       # shows the installed source string, e.g. npm:pi-agy-cli
pi remove <source>
```

No residue: `pi remove` deletes the package install; pi-agy itself never
creates files anywhere.

> **Note on the npm name.** The package is published as **`pi-agy-cli`**
> because the bare name `pi-agy` is already taken on npm by an unrelated
> project. The project, GitHub repository, and tool names remain `pi-agy` /
> `agy`.

## Tools

| Tool          | Purpose                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `agy`         | General worker. Full control: workspace, model, effort, agent, `allowCommands`, `continueConv`, `conversation`, JSON schema, timeout. |
| `agy_code`    | Implementation tasks. Writes/edits files in the workspace; commands enabled by default.            |
| `agy_vision`  | **Images & screenshots.** Read-only by default: inspects image files with the multimodal agent (screenshots, mockups, diagrams, charts, scanned pages). `images` accepts workspace-relative, absolute, `~/…`, Git-Bash, and `file://` paths — files outside the workspace are staged into a temp dir for the run. Pass a `url` and it captures a headless-Chrome screenshot first (implies `allowCommands`). |
| `agy_role`    | **Specialist roles.** Delegate to a named specialist (`scout`, `implementer`, `reviewer`, `verifier`, `oracle`, plus your own) that bundles a shaped output contract with an enforced access policy. Read-only roles cannot be widened. See [Specialist roles](#specialist-roles). |
| `agy_fleet`   | **Fan-out**: run 2–24 independent subtasks as parallel agy agents (bounded concurrency, default 3) with a live per-lane board and per-lane evidence. Each lane may name a `role`. |

Exploration has no dedicated tool: use `agy_role` with the read-only `scout`
role for a single recon pass, or read-only `agy_fleet` lanes (`role: "scout"`)
when several areas need mapping at once. One prompt contract and one enforced
access policy covers exploration, instead of a second copy that could drift.

All tools stream a live status card and return the agent's response plus
metadata: `conversation_id`, `num_turns`, `usage`, duration, `warnings`,
verification **evidence** (files written, commands run), and a **run log** of
every tool step. Every run is also tracked in the session fleet registry, which
powers the persistent FleetView widget and the `/agy-fleet` inspector (see
[Fleet view & inspector](#fleet-view--inspector-all-live-agy-work-in-one-place)).

### Evidence you can actually verify

agy can finish with `status: SUCCESS` while a tool call was silently denied — a
permission-denied `write_to_file` still reports the step as `DONE` and only
appears in `denied_actions` on the final result. pi-agy therefore does not take
`files_written` at face value: every claimed path is resolved against the
workspace and **checked on disk**, and anything that does not exist is dropped
from the evidence and reported as a warning ("N files the agent reported
writing do not exist on disk"). Only a step whose state is exactly `DONE` counts
as success (`ERROR` steps, e.g. a write into a missing directory, do not), the
run log marks failed steps with `✗`, and any denied action or failed step raises
an explicit warning. A run that did nothing can no longer look like a clean
success.

## Live status (what is the agent doing right now?)

Every tool renders a **premium, responsive card** in the TUI instead of a bare
text blob. The call card states the request; the result card is a live status
continuation that updates per step and expands with `Ctrl+O`.

**Call card** — what was asked, and with which configuration:

```text
◆ agy_role · scout · specialist
  gemini-3.8-flash-high  ·  high effort  ·  timeout 10m  ·  E:/dev/SAAS/secondbrain
  Map the modules in src/ and explain how they connect to the worker pipeline
```

**While running** — current step and target, live metrics, and the recent trail:

```text
▸ step 50 · ✎ worker/src/lib/contradiction.ts                 1m 39s
  ⠹ active 3s ago · steps 49 · files 6 · commands 3 · ↓ 4.2k tokens
  ├─ ✓ 47  ▤ worker/src/lib/schema.ts
  ├─ ✓ 48  $ npm run typecheck
  └─ ▸ 49  ✎ worker/src/lib/contradiction.ts
  ⎿  Writing the contradiction scorer… 3.4s
```

**When done** — outcome, stats, response, evidence, and a capped run log:

```text
✓ done · steps 50 · files 2 · commands 2 · turns 12 · tokens 48k     2m 14s
────────────────────────────────────────────────────────────────────────
<the agent's response>
────────────────────────────────────────────────────────────────────────
  files  worker/src/lib/contradiction.ts
         worker/src/lib/schema.ts
  ran    npm run typecheck
         npm test -- worker
────────────────────────────────────────────────────────────────────────
  run log  8 of 50 steps  ·  Ctrl+O to expand
  … 42 earlier steps
  48  ✓ $ npm test -- worker/48
  49  ✓ ✎ worker/src/lib/m49.ts
```

Cards adapt cleanly to the terminal width with strict **ANSI-safe width handling**:
lines are measured by visible width and truncated or padded using
style-preserving primitives (`truncLine` / `fitLine`). SGR style escapes are
never cut mid-sequence and strings are segmented on grapheme cluster boundaries
(via `Intl.Segmenter`), eliminating terminal background color bleed and line
wrapping. Metric chips and subtitles drop at token boundaries, long values
ellipsize, and the layout never overflows the column. Tool glyphs are semantic —
`✎` write/edit, `▤` read, `⌕` search, `⌂` list, `$` command — with recent
steps connected by tree branches (`├─`, `└─`) and the live tool output tail
highlighted with `⎿`.

The live card animates every 100 ms with a 10-frame braille spinner (`⠹`) and a
freshness chip (`active 3s ago`, `active but long-running`, or `no activity for 2m`).
The same state is mirrored into the footer status bar
(`agy ⟳ step 12 · ✎ src/a.ts · 42s`) and into structured streaming `details`
(`step`, `tool`, `file`, `command`, `filesTouched`, `recent`, `preview`,
`elapsedMs`, plus the live fields `lastActivityAt`, `toolStartedAt`,
`outputTail`, `tokens`, and `turns`) for RPC/UI consumers. The tool result still
carries the full run log in plain text for the orchestrator.

## Specialist roles

Borrowed from pi-subagents' named agents: a **role** is a shaped output contract
plus an access policy. The same Gemini model produces far better results when it
is told *"return compressed recon context in exactly this shape"* than when it
is handed a bare question, and the policy is what keeps a review from quietly
editing your code.

| Role | Access | Use it for |
| --- | --- | --- |
| `scout` | read-only | Fast codebase recon: files, entry points, data flow, and where to start. Returns a `# Code Context` brief. |
| `implementer` | writes + shell | Implementation work: the smallest correct change, validated with your own checks. |
| `reviewer` | read-only | Review of a diff, plan, or proposal. Findings graded P0/P1/P2 with `file:line` evidence, or exactly `No issues found.` |
| `verifier` | read-only | Independently audits claimed evidence and marks each claim `SUPPORTED` / `PARTIALLY SUPPORTED` / `UNSUPPORTED`. |
| `oracle` | read-only | A second opinion before acting. Attacks the plan instead of approving it. |

```text
agy_role({ role: "scout",    prompt: "Map the auth flow before we plan." })
agy_role({ role: "reviewer", prompt: "Review this diff for correctness." })
agy_role({ role: "verifier", prompt: "Claim: the cache is invalidated on write. Verify it." })
```

Read-only roles are **enforced**: `allowCommands` is forced off and a caller
cannot raise it. A role also carries default model/effort and prompt, which the
caller may override (`model`, `effort`) — but never the access policy.

Inside a fan-out, give each lane a role:

```text
agy_fleet({ tasks: [
  { id: "correctness", role: "reviewer", task: "Review src/auth.ts for correctness." },
  { id: "tests",       role: "reviewer", task: "Review the tests in tests/auth.test.ts." },
  { id: "claims",      role: "verifier", task: "Verify the PR description's claims." },
] })
```

An unknown role fails the whole call before any agent is spawned.

### Custom roles

Add or override roles in `~/.pi/agy.json`. A matching id overrides only the
fields you set, so the built-in prompt survives:

```json
{
  "roles": {
    "reviewer": { "effort": "low" },
    "migrator": {
      "description": "Schema migrations only",
      "guidance": "You migrate database schemas. Never touch application logic.",
      "allowCommands": true,
      "effort": "high"
    }
  }
}
```

A role that omits `allowCommands` is read-only: silence never grants write
access.

### Model fallback

Set `AGY_FALLBACK_MODELS=gemini-3.1-pro-high` (or `fallbackModels: ["…"]` in the
config file) to retry a failed run with the next model. An abort is never
retried. The result reports the chain and the model that actually ran.

## Fleet view & inspector (all live agy work in one place)

Every agy run — a single `agy`/`agy_code`/`agy_vision`/`agy_role` call and
every `agy_fleet` lane — reports into one session-wide registry. That registry
feeds a persistent **FleetView** widget under the editor, so you can see all
parallel work without opening each card.

The widget updates live (every 500 ms) with an animated braille spinner and
`fitLine`-padded rows so rendering never jitters, bleeds background styling, or
overflows the terminal width.

**Collapsed while multiple agents run** — live spinner, step/file totals, and token metrics:

```text
  ⠹ 3 active agents · 42 steps · 6 files · ↓ 4.2k tokens · ↓/← to inspect
```

**Collapsed with a single active run** — compact block with live output tail and task:

```text
  ⠹ agy_code · running · 12 steps · ↓ 4.2k tokens        1m 12s
    ⎿  ✎ src/fleetview.ts  3.4s
    task: Refactor the fleet widget rows
```

Press `↓` (or `←`) on an empty editor to expand the roster, `↑`/`↓` or `j`/`k`
to select, and `Esc` to collapse again. The expanded roster groups running agents
first, then queued summaries, then finished runs, with an overflow line:

```text
  ↑↓/jk select · enter inspect · esc back

    > main
    ⠹ agy_code · running · ✎ src/fleetview.ts      38s · 12 steps · 4.2k
    ⠹ agy_fleet · t2 · running · $ npm test        12s · 4 steps · 1.1k
    ○ agy_fleet · t3 · waiting                          — · queued
    +2 more (1 running, 1 finished)
```

`Enter` on a run opens the **`/agy-fleet` inspector**: a bordered overlay with
a roster of tracked runs (live and recently finished) beside the selected run's
full detail:

```text
╭─────────────────────────────────────────────────────────────────────────────╮
│ agy fleet · 2 active · 4 tracked · ↓ 5.3k tokens    ⠹ agy_code · running    │
├─────────────────────────────┬───────────────────────────────────────────────┤
│ › ⠹ agy_code            38s │ ◆ agy_code · running                          │
│   ⠹ agy_fleet · t2      12s │   gemini-3.8-flash-high · 38s                 │
│   ○ agy_fleet · t3        — │   task  Refactor the fleet widget rows        │
│   ✓ agy_role            45s │   cwd   E:/dev/pi-agy                         │
│                             │ ───────────────────────────────────────────── │
│                             │   step 12 · ✎ src/a.ts · active 3s ago    38s │
│                             │   steps 12 · files 2 · ↓ 4.2k tokens          │
│                             │ ───────────────────────────────────────────── │
│                             │   output                                      │
│                             │   ⎿  export function fleetRosterLines(        │
│                             │   ⎿  rebuilding roster layout for live TUI…   │
│                             │ ───────────────────────────────────────────── │
│                             │   recent steps                                │
│                             │   ├─ ✓ 10  ▤ src/ui.ts                        │
│                             │   ├─ ✓ 11  $ npm test                         │
│                             │   └─ ▸ 12  ✎ src/a.ts                         │
├─────────────────────────────┴───────────────────────────────────────────────┤
│ ↑/↓ select · Shift+J/K line · PgUp/PgDn page · x tools · g/G · r refresh ·  │
│ Esc close · 1/4                                                             │
╰─────────────────────────────────────────────────────────────────────────────╯
```

The inspector shows animated spinners in the header totals
(`N active · M tracked · ↓ Xk tokens`) and roster rows, an exact liveness line
(`step 12 · ✎ src/a.ts · active 3s ago` with right-aligned elapsed time), live
metrics with tokens (`↓ 4.2k tokens`), a live output-tail section (`output`
header with `⎿`-prefixed lines), and a tree-branched recent-steps trail (`├─`,
`└─`).

**Inspector keys:**
- `↑`/`↓` or `j`/`k` — select run in roster
- `Shift+J` / `Shift+K` — scroll detail one line at a time
- `PgUp` / `PgDn` — scroll detail by page
- `x` or `Ctrl+O` — toggle tool steps and evidence sections on/off
- `g` / `G` — jump to top / bottom of detail
- `r` — refresh view
- `Esc` — close inspector

On narrow terminals the optional key hints trim from the middle; `Esc close` and
the `position/total` indicator are always kept.

The widget only exists while agy work is running and removes itself once every
run finishes, so a completed session leaves no residual surface. In print/RPC
modes `/agy-fleet` degrades to a plain-text summary.

## Fan-out with agy_fleet

Parallelize independent subtasks by handing the orchestrator a list of lanes:

```
agy_fleet(tasks=[
  { id: "edit-a", task: "Refactor function X in src/a.ts", workspace: "." },
  { id: "edit-b", task: "Refactor function Y in src/b.ts" },
  { id: "probe",  task: "Write a quick perf probe script and run it", allowCommands: true },
], concurrency: 2)
```

While the fleet runs, the card shows a live per-lane board:

```text
▸ 4 lanes · 2 active · 1 done · 1 failed                            2m 10s
────────────────────────────────────────────────────────────────────────
▸ ingest   running   step 12  ✎ worker/src/ingest.ts                   42s
✓ extract  done      —       2 files · 1 cmd                          38s
✗ schema   failed    —       agy ERROR: print timeout exceeded        12s
○ docs     waiting   —       waiting                                    —
```

The final result reports per-lane outcome, response, duration, and evidence,
so the orchestrator can verify each lane:

```text
◐ 1/2 lanes · 1 failed · concurrency 3                              2m 10s
────────────────────────────────────────────────────────────────────────
  ✓ ingest  1 file · 1 command · 42s
     Refactored the ingest stage to stream batches with backpressure.
  ✗ schema  agy ERROR: print timeout exceeded
     task: Migrate the graph tables to v2
────────────────────────────────────────────────────────────────────────
  evidence
    [ingest] files: worker/src/ingest.ts
    [ingest] ran: npm test
```

Lanes default to your current working directory unless they declare their own
`workspace`; give concurrent lanes distinct workspaces or distinct files to
avoid conflicting edits. Per-lane `model`, `effort`, `agent`, `allowCommands`,
`continueConv`, `jsonSchema`, and `timeout` override the call-level defaults.

## Configuration

Sensible defaults are baked in: `gemini-3.8-flash-high`, `effort=high`,
10m timeout, commands allowed, and opt-in delegation with verification guidance
on. Override with environment variables (highest precedence) or an optional user
config file.

| Env var             | Default                 | Meaning                                    |
| ------------------- | ----------------------- | ------------------------------------------ |
| `AGY_BIN`           | `agy`                   | agy binary path or name                    |
| `AGY_MODEL`         | `gemini-3.8-flash-high` | default model slug (`agy models` to list)  |
| `AGY_EFFORT`        | `high`                  | reasoning effort (`low`\|`medium`\|`high`) |
| `AGY_AGENT`         | —                       | agy agent name (`agy agents` to list)      |
| `AGY_TIMEOUT`       | `10m`                   | max wait per run (`--print-timeout`)       |
| `AGY_ALLOW_CMDS`    | `true`                  | pass `--dangerously-skip-permissions` by default |
| `AGY_FLEET_CONCURRENCY` | `3`                 | max parallel lanes for `agy_fleet` (1–8)   |
| `AGY_FALLBACK_MODELS` | —                     | comma-separated models to retry with when a run fails outright |
| `AGY_CONFIG`        | `~/.pi/agy.json`        | path to the optional user config file      |

Optional user config file `~/.pi/agy.json` (env vars win over it, per-call
tool params win over both):

```json
{
  "bin": "agy",
  "model": "gemini-3.8-flash-high",
  "effort": "high",
  "timeout": "10m",
  "defaultAllowCommands": true,
  "fleetConcurrency": 3
}
```

> `model` + `effort` must stay consistent: gemini slugs encode the effort
> (`gemini-3.8-flash-high`), and agy rejects mismatches like
> `gemini-3.8-flash-medium` + `--effort high`. The extension auto-fixes gemini
> slugs to match the requested effort (see `matchEffort`).

## Images and screenshots (`agy_vision`)

`agy_vision` delegates image work to agy's multimodal agent. The agent opens the
actual pixels with its `view_file` tool — it does not guess from the filename.

**Key constraint:** pi-agy passes agy *text only* (the agy CLI has no image
flag and pi cannot attach images inline), so images are delegated **by path**.
Paths may be workspace-relative, absolute, `~/…`, Git-Bash (`/c/Users/…` on
Windows), or `file://` URLs. Files that live **outside the workspace** are
copied into a per-run temp directory that pi-agy registers with agy via
`--add-dir` (the copy is removed when the run ends), so no
`allowNonWorkspaceAccess` setting is required. A path that does not exist is
reported in the result instead of being silently skipped.

### Inspect an existing image (read-only)

```
agy_vision({
  images: ["screenshots/home.png", "screenshots/pricing.png"],
  prompt: "List every visual regression versus a standard SaaS pricing page: spacing, alignment, contrast, hierarchy.",
  jsonSchema: '{"type":"object","properties":{"issues":{"type":"array","items":{"type":"string"}}}}',
})
```

Local paths work from anywhere on disk, not just the workspace:

```
agy_vision({
  images: ["~/Desktop/mock.png", "C:/Users/me/Downloads/bug-report.png"],
  prompt: "Compare the two: which control is misaligned?",
})
```

Read-only is the default: no `--dangerously-skip-permissions`, and the prompt
carries a guard telling the agent that shell commands are denied so it sticks to
`view_file`/`list_dir`/`grep_search`. `jsonSchema` is the recommended way to get
structured findings back (UI review lists, OCR field extraction, chart→data).

### Screenshot a page, then review it

```
agy_vision({ url: "http://localhost:3000", prompt: "Check the hero section for overflow and contrast issues." })
```

The agent drives headless Chrome/Edge (`--headless=new --screenshot=…
--window-size=1280,800`), saves the PNG in the workspace, and inspects the
captured file — the returned run log shows the exact command it used.
Supplying `url` implies `allowCommands=true` (the capture needs a shell); pass
`allowCommands: false` explicitly to override.

### Generate or edit images

Generation needs a shell, so use `agy_code` (or `agy`) with
`allowCommands=true`. On a machine without ImageMagick/PIL the agent still
succeeds by writing a small Node PNG encoder or by rendering HTML/SVG through
headless Chrome. `ffmpeg` is the fallback for format conversion and video
frames.

### Caveats

- **Verify image outputs yourself.** `files_written` is parsed from agy's
  write-tool calls, so a PNG produced by a *shell command* (headless Chrome,
  a Node script) does **not** appear in the evidence list. Check the file
  exists and is a valid PNG (`read`, `ls`, or a signature/size check) before
  reporting success.
- **Use a `gemini-*` model slug** (`gemini-3.8-flash-high` by default). The
  claude/gpt-oss entries in `agy models` are not the vision path.
- Image reads appear in the run log as `▤`/file steps; a pure read never shows
  up in `files_written`.
- Vision runs need a few steps to locate and open the file: expect ~10–40s and
  a few thousand tokens per image question.

## Orchestration pattern (pi = orchestrator, agy = subagent) — opt-in

pi-agy injects delegation + verification guidance into pi's system prompt on
every agent start (`before_agent_start`). No manual system prompt edits and no
configuration are needed — but the guidance is **opt-in**: pi is told
**not to call any agy tool** unless you explicitly ask for agy in the current
request. Incidental words such as “delegate”, “parallelize”, “fan out”, or
“explore” do **not** count, and a request from an earlier turn does not carry
over. When you have not asked for agy, pi does the work itself with its normal
tools.

Once you have asked, the injected guidance is:

1. **Delegate** low-level subtasks to the agy tools (or fan out with `agy_fleet`)
   instead of doing them inline.
2. **Verify** after each run — files exist with the right contents (`read`/`grep`),
   claimed tests/commands re-run (`bash`), exploration answers spot-checked.
   For fleets, verify **each lane**'s evidence.
3. **Iterate** when verification fails — `allowCommands=true` if a tool call was
   auto-denied, or `continueConv=true` to keep the same agent conversation.
4. **Report evidence** — files changed and verification results.

Tool results back this up: every run reports `files_written` and `commands_run`
(both in the response text as `Evidence — …` and in `details`), parsed from
agy's live stream, plus a `Run log` of every tool step so you know exactly what
the agent did.

Run `/agy-models` in pi to show the active config and available models.

## Headless-mode permissions

Shell commands **and file writes** are auto-denied in headless mode unless
`allowCommands` is true (which passes `--dangerously-skip-permissions`) or
matching allow rules exist in `~/.gemini/antigravity-cli/settings.json`. File
*reads* inside the workspace are allowed; writes are not. This was verified
directly against the CLI: with `allowCommands=false` a `write_to_file` call is
denied, the file is never created, and agy still reports the step as `DONE` with
`status: SUCCESS` and an empty response — the denial shows up only as
`denied_actions: [{action: "write_file"}]` on the final result.

pi-agy detects this and appends a ⚠️ warning with the remediation, and it never
reports a denied write as `files_written` evidence (see
[Evidence you can actually verify](#evidence-you-can-actually-verify)). Use
`allowCommands: true` for any task that must write files — including the
read-only presets (`agy_vision`, and `agy_role` with a read-only role such as
`scout` or `reviewer`), which are read-only by design.

Workspace paths accept Windows (`C:\...`) and Git-Bash (`/tmp/...`, `~/...`)
forms; a workspace is registered with `--add-dir` so files land in it rather
than agy's scratch directory. `continueConv: true` resumes the previous
conversation per workspace via `conversation_id`.

## Commands

- `/agy <prompt>` — run a one-off prompt through the agent and print the result.
- `/agy-models` — show active config and list available models.
- `/agy-fleet` — open the live fleet inspector (active + recently finished runs).
- `/agy-doctor` — check the setup: agy CLI + version, config file, workspace,
  permission mode, roles, model catalogue, and the fallback chain.

## Development

Source layout (the entry `index.ts` only wires the extension; all logic lives
in `src/` with one-directional dependencies):

```
index.ts        extension entry: registers tools, opt-in delegation guidance, commands
src/config.ts   defaults, env vars + ~/.pi/agy.json, fleet caps, roles, fallbacks
src/roles.ts    specialist roles: prompt contracts + enforced access policy
src/doctor.ts   /agy-doctor health checks (pure, dependency-injected)
src/model.ts      gemini model/effort consistency (matchEffort)
src/paths.ts     workspace path normalization (Git-Bash forms on Windows)
src/status.ts    live activity state, run log, durations, debounce
src/ui.ts        width-safe card primitives (View, trunc/row/fitParts, wrapping)
src/render.ts    TUI cards: call/stream/result builders + renderer factories
src/fleet.ts     fan-out lane state + headless board text
src/registry.ts  session-wide run registry (single calls + fleet lanes)
src/fleetview.ts persistent FleetView widget (collapsed summary + roster)
src/inspector.ts /agy-fleet overlay inspector (roster + detail)
src/runner.ts    agy spawn, stream-json parsing, evidence extraction
src/results.ts   tool result assembly (response + run log + evidence)
src/executors.ts shared tool execution (single-run + fleet)
src/tools.ts     tool definitions/schemas + TUI renderers
```

Requires **Node.js >= 22.18** (tests run `.ts` files with Node's built-in type
stripping).

```bash
npm install          # installs dev tools + peer packages
npm run typecheck    # tsc --noEmit
npm test             # node --test tests/*.test.ts
npm run test:watch   # re-run on change
npm run pack:check   # inspect the exact npm tarball
npm run release:verify   # typecheck + tests + pack check
```

Load the working copy into pi for manual testing:

```bash
pi -e /absolute/path/to/pi-agy
```

### Branching, CI, and releases

- `main` is production and always releasable. `develop` is the integration
  branch and the default target for pull requests; feature and fix branches are
  cut from `develop`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- Every push and pull request runs the
  [`CI` workflow](.github/workflows/ci.yml) — typecheck plus tests on Node 22,
  24, and 26, a publishable-tarball check, and an advisory dependency audit —
  along with [`CodeQL`](.github/workflows/codeql.yml).
- Releases are cut from `main` by pushing an annotated `vX.Y.Z` tag. The
  [`Release` workflow](.github/workflows/release.yml) verifies the tag matches
  `package.json`, publishes to npm with provenance, and opens a GitHub Release.
  The full runbook — including npm Trusted Publishing (OIDC) setup and the
  `NPM_TOKEN` fallback — is in [RELEASING.md](RELEASING.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
branch model, commit conventions, and pull-request checklist. By participating
you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

The agy agent runs with your credentials and (when `allowCommands` is on) full
shell access through `--dangerously-skip-permissions`. Treat prompts you send
it as trusted input — see [SECURITY.md](SECURITY.md) to report a vulnerability
privately.

## License

MIT — see [LICENSE](LICENSE).