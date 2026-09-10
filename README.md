# pi-agy

Delegate low-level tasks — writing code, exploring a codebase, research passes,
inspecting screenshots and images — to Google Antigravity's
[agy CLI](https://antigravity.google/docs/cli/headless/) running a Gemini agent.
Pi stays the **orchestrator**: once you ask for it, it farms out subtasks to agy
(`agy`, `agy_code`, `agy_explore`, `agy_vision`, `agy_fleet` tools), then
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
# from GitHub (requires you to have pushed the repo — see Development below)
pi install git:github.com/d1pankarmedhi/pi-agy

# from npm once published
pi install npm:pi-agy

# from a local checkout
pi install E:/dev/pi-agy
```

Uninstall:

```bash
pi list       # shows the installed source string, e.g. git:github.com/d1pankarmedhi/pi-agy
pi remove <source>
```

No residue: `pi remove` deletes the package install; pi-agy itself never
creates files anywhere.

## Tools

| Tool          | Purpose                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `agy`         | General worker. Full control: workspace, model, effort, agent, `allowCommands`, `continueConv`, `conversation`, JSON schema, timeout. |
| `agy_code`    | Implementation tasks. Writes/edits files in the workspace; commands enabled by default.            |
| `agy_explore` | Read-only exploration. Never enables shell commands; steers the agent to `list_dir`/`view_file`/`grep_search`. |
| `agy_vision`  | **Images & screenshots.** Read-only by default: inspects image files with the multimodal agent (screenshots, mockups, diagrams, charts, scanned pages). `images` accepts workspace-relative, absolute, `~/…`, Git-Bash, and `file://` paths — files outside the workspace are staged into a temp dir for the run. Pass a `url` and it captures a headless-Chrome screenshot first (implies `allowCommands`). |
| `agy_fleet`   | **Fan-out**: run 2–24 independent subtasks as parallel agy agents (bounded concurrency, default 3) with a live per-lane board and per-lane evidence. |

All tools stream a live status card and return the agent's response plus
metadata: `conversation_id`, `num_turns`, `usage`, duration, `warnings`,
verification **evidence** (files written, commands run), and a **run log** of
every tool step.

## Live status (what is the agent doing right now?)

Every tool renders a **premium, responsive card** in the TUI instead of a bare
text blob. The call card states the request; the result card is a live status
continuation that updates per step and expands with `Ctrl+O`.

**Call card** — what was asked, and with which configuration:

```text
◆ agy_explore · read-only
  gemini-3.8-flash-high  ·  high effort  ·  timeout 10m  ·  E:/dev/SAAS/secondbrain
  Map the modules in src/ and explain how they connect to the worker pipeline
```

**While running** — current step and target, live metrics, and the recent trail:

```text
▸ step 50  ·  ✎ worker/src/lib/contradiction.ts                     1m 39s
  steps 49 · files 6 · commands 3
────────────────────────────────────────────────────────────────────────
  ✓ 47  ▤ worker/src/lib/schema.ts
  ✓ 48  $ npm run typecheck
  ✓ 49  grep search
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

Cards adapt to the terminal width: metric chips and subtitles drop at token
boundaries, long values ellipsize, and the layout never overflows the column.
Tool glyphs are semantic — `✎` write/edit, `▤` read, `⌕` search, `⌂` list,
`$` command.

The same state is mirrored into the footer status bar (`agy ⟳ step 12 · ✎ src/a.ts · 42s`)
and into structured streaming `details` (`step`, `tool`, `file`, `command`,
`filesTouched`, `recent`, `preview`, `elapsedMs`) for RPC/UI consumers. The tool
result still carries the full run log in plain text for the orchestrator.

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

File reads/writes inside the workspace are auto-allowed by agy. Shell commands
are auto-denied unless `allowCommands` is true (passes
`--dangerously-skip-permissions`) or matching allow rules exist in
`~/.gemini/antigravity-cli/settings.json`. When a tool call is denied, agy can
finish with `SUCCESS` but no output — pi-agy detects this and appends a ⚠️
warning with the remediation.

Workspace paths accept Windows (`C:\...`) and Git-Bash (`/tmp/...`, `~/...`)
forms; a workspace is registered with `--add-dir` so files land in it rather
than agy's scratch directory. `continueConv: true` resumes the previous
conversation per workspace via `conversation_id`.

## Commands

- `/agy <prompt>` — run a one-off prompt through the agent and print the result.
- `/agy-models` — show active config and list available models.

## Development

Source layout (the entry `index.ts` only wires the extension; all logic lives
in `src/` with one-directional dependencies):

```
index.ts        extension entry: registers tools, opt-in delegation guidance, commands
src/config.ts   defaults, env vars + ~/.pi/agy.json, fleet caps
src/model.ts      gemini model/effort consistency (matchEffort)
src/paths.ts     workspace path normalization (Git-Bash forms on Windows)
src/status.ts    live activity state, run log, durations, debounce
src/ui.ts        width-safe card primitives (View, trunc/row/fitParts, wrapping)
src/render.ts    TUI cards: call/stream/result builders + renderer factories
src/fleet.ts     fan-out lane state + headless board text
src/runner.ts    agy spawn, stream-json parsing, evidence extraction
src/results.ts   tool result assembly (response + run log + evidence)
src/executors.ts shared tool execution (single-run + fleet)
src/tools.ts     tool definitions/schemas + TUI renderers
```

```bash
npm install          # installs dev tools + peer packages
npm run typecheck    # tsc --noEmit
npm test             # node --test
```

To publish on GitHub:

```bash
git init && git add -A && git commit -m "Initial release: pi-agy"
git remote add origin https://github.com/d1pankarmedhi/pi-agy.git
git push -u origin main
# then install the released tag with:
pi install git:github.com/d1pankarmedhi/pi-agy
```

For npm publishing: `npm publish` (requires the `pi-package` keyword and `.npmrc`
auth). If the name `pi-agy` is taken on npm, rename in `package.json` and update
the `repository`/`homepage` URLs accordingly.

## Security

The agy agent runs with your credentials and (when `allowCommands` is on) full
shell access through `--dangerously-skip-permissions`. Treat prompts you send
it as trusted input — see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).