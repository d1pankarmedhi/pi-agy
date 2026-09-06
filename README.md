# pi-agy

Delegate low-level tasks — writing code, exploring a codebase, research passes —
to Google Antigravity's [agy CLI](https://antigravity.google/docs/cli/headless/)
running a Gemini agent. Pi stays the **orchestrator**: it farms out subtasks to
agy (`agy`, `agy_code`, `agy_explore`, `agy_fleet` tools), then **verifies** the
agent's work itself before reporting success.

Unlike a black box, every run is observable: a live status line in the
conversation shows what the agent is doing in real time (the step, the file it
is writing/editing, the command it is running), and the final result includes a
full **run log** of every tool step. `agy_fleet` fans out multiple agy agents
on a list of tasks with bounded concurrency and a live per-lane board — the
same shape as pi-subagents cards.

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
| `agy_fleet`   | **Fan-out**: run 2–24 independent subtasks as parallel agy agents (bounded concurrency, default 3) with a live per-lane board and per-lane evidence. |

All tools stream a live status card and return the agent's response plus
metadata: `conversation_id`, `num_turns`, `usage`, duration, `warnings`,
verification **evidence** (files written, commands run), and a **run log** of
every tool step.

## Live status (what is the agent doing right now?)

While an agy agent runs, pi shows a compact one-line status that updates per
step — subagent-style:

```text
> step 4 · ✎ src/main.ts              ← currently editing this file
> step 5 · $ npm test                 ← currently running this command
… step 6 · thinking / writing response
```

The step's file is shown workspace-relative, so `✎ src/main.ts` means
`<workspace>/src/main.ts`. The same state also appears in the footer status bar
(`agy ⟳ …`) when a UI is present, and structured `details` (`step`, `tool`,
`file`, `command`, `filesTouched`, `elapsedMs`) are streamed for RPC/UI
consumers. When the run finishes, the result carries a **run log**: a terminal
trail of every tool step the agent performed, e.g.

```text
Run log (9 steps):
  ✓ step 2 · ✎ src/main.ts
  ✓ step 5 · $ npm test
  …
```

## Fan-out with agy_fleet

Parallelize independent subtasks by handing the orchestrator a list of lanes:

```
agy_fleet(tasks=[
  { id: "edit-a", task: "Refactor function X in src/a.ts", workspace: "." },
  { id: "edit-b", task: "Refactor function Y in src/b.ts" },
  { id: "probe",  task: "Write a quick perf probe script and run it", allowCommands: true },
], concurrency: 2)
```

While the fleet runs, a live board shows every lane — same card shape as
pi-subagents:

```text
agy_fleet · 3 lanes · 2 active · 1 done · 0 failed · 1m 12s
  ● [edit-a] > step 3 · ✎ src/a.ts · 42s
  ● [edit-b] > step 2 · ✎ src/b.ts · 38s
  ✓ [probe]  done · 1 file · 1 command · 1m 05s
```

The final result reports per-lane status, short response, duration, and
`Evidence — [id] files: … commands: …` per successful lane so the orchestrator
can verify each one. Lanes default to your current working directory unless
they declare their own `workspace`; give concurrent lanes distinct workspaces
or distinct files to avoid conflicting edits. Per-lane `model`, `effort`,
`agent`, `allowCommands`, `continueConv`, `jsonSchema`, and `timeout` override
the call-level defaults.

## Configuration

Sensible defaults are baked in: `gemini-3.8-flash-high`, `effort=high`,
10m timeout, commands allowed, orchestration+verification on. Override with
environment variables (highest precedence) or an optional user config file.

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

## Orchestration pattern (pi = orchestrator, agy = subagent) — automatic

pi-agy **automatically** injects orchestration + verification guidance into
pi's system prompt on every agent start (`before_agent_start`). No manual
system prompt edits and no configuration are needed — installing the package
activates it:

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
index.ts        extension entry: registers tools, orchestration guidance, commands
src/config.ts   defaults, env vars + ~/.pi/agy.json, fleet caps
src/model.ts      gemini model/effort consistency (matchEffort)
src/paths.ts     workspace path normalization (Git-Bash forms on Windows)
src/status.ts    live activity lines, run log, durations, debounce
src/fleet.ts     fan-out lane state + per-lane board rendering
src/runner.ts    agy spawn, stream-json parsing, evidence extraction
src/results.ts   tool result assembly (response + run log + evidence)
src/executors.ts shared tool execution (single-run + fleet)
src/tools.ts     tool definitions/schemas (agy, agy_code, agy_explore, agy_fleet)
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