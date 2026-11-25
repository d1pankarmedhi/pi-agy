<p align="center">
  <img src="https://raw.githubusercontent.com/d1pankarmedhi/pi-agy/main/docs/assets/banner.png" alt="pi-agy" width="880" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dmpunk/pi-agy"><img src="https://img.shields.io/npm/v/@dmpunk/pi-agy?color=7c5cff&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@dmpunk/pi-agy"><img src="https://img.shields.io/npm/dm/@dmpunk/pi-agy?color=4c7dff" alt="npm downloads" /></a>
  <a href="https://github.com/d1pankarmedhi/pi-agy/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/d1pankarmedhi/pi-agy/ci.yml?branch=main&label=CI" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2fbf9f" alt="MIT license" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522.18-2fbf9f" alt="Node 22.18+" /></a>
</p>

<p align="center">
  <b>Delegate the small work to Gemini. Keep the judgement in pi.</b>
</p>

pi-agy adds six tools to [pi](https://github.com/earendil-works/pi) that hand a
subtask to Google Antigravity's [`agy`
CLI](https://antigravity.google/docs/cli/headless/) — a Gemini agent with its own
tool loop. Pi writes the task, watches it run, and checks the result against the
filesystem before calling it done. You keep one conversation; the grunt work
happens in parallel.

**Delegation is opt-in.** Pi only reaches for agy when you ask in the current
request ("use agy", "run agy_fleet", "use Antigravity"). Words like *delegate*
or *explore* do not count, and a request from an earlier turn does not carry
over. Otherwise pi does the work itself.

[Install](#install) · [Quick start](#quick-start) · [Tools](#tools) ·
[Reports](#reports) · [Roles](#specialist-roles) ·
[Configuration](#configuration)

## Requirements

- **pi** with extension support, and **Node.js 22.18+**.
- **agy** installed and authenticated once, so `agy -p "hi"` works in a
  terminal. Headless runs reuse those cached credentials.

## Install

```bash
pi install npm:@dmpunk/pi-agy            # latest from npm
pi install npm:@dmpunk/pi-agy@0.5.1      # pinned, reproducible
pi install git:github.com/d1pankarmedhi/pi-agy@v0.5.1   # from a release tag
pi install /absolute/path/to/pi-agy      # local checkout (development)
```

Remove it with `pi remove <source>`. The extension keeps no state: the only
writes are your own `~/.pi/agy.json` (when you save a model or effort) and the
reports you ask for, described in [Reports](#reports). Both report roots are
git-ignored and can be turned off.

> The npm package is scoped as **`@dmpunk/pi-agy`** because the bare name is
> taken. The project, repo, and tool names stay `pi-agy` / `agy`.

## Quick start

A code task, a review, and a screenshot check:

```text
agy_code({ prompt: "Extract the retry logic from src/client.ts into src/retry.ts and update the imports." })

agy_role({ role: "reviewer", prompt: "Review the diff in src/retry.ts for correctness." })

agy_vision({ url: "http://localhost:3000/pricing", prompt: "Find contrast and overflow problems in the pricing table." })
```

Anything independent can run at once:

```text
agy_fleet({ tasks: [
  { id: "api",   task: "Add pagination to GET /items in src/api/items.ts." },
  { id: "tests", task: "Cover the new pagination with tests in tests/items.test.ts." },
  { id: "docs",  task: "Document the query parameters in docs/api.md." },
]})
```

Every run renders a live card, then returns the agent's response plus the
evidence pi used to verify it. Fleets also write a full report to disk, so you
can hand the output to someone else — see [Reports](#reports).

## Tools

| Tool | What it does |
| --- | --- |
| `agy` | General worker with every knob exposed: workspace, model, effort, agent, `allowCommands`, `continueConv`, `conversation`, `jsonSchema`, timeout. |
| `agy_code` | Implementation tasks. Writes files in the workspace; shell allowed by default. |
| `agy_role` | Runs a named specialist (`scout`, `implementer`, `reviewer`, `verifier`, `oracle`, or your own) with a shaped output contract and an enforced access policy. |
| `agy_vision` | Image work: screenshots, mockups, diagrams, charts, scanned pages. Read-only by default; pass `url` to capture a page first. |
| `agy_fleet` | Fans out 2–24 independent subtasks as parallel agents (default 3 at a time) with a per-lane board. Lanes may name a role. |
| `agy_reports` | Lists or clears the reports written to disk. |

Exploration has no separate tool: use `agy_role({ role: "scout", … })` for one
recon pass, or read-only `agy_fleet` lanes when several areas need mapping. One
prompt contract and one access policy, instead of a second copy that drifts.

Common parameters on every tool: `workspace`, `model`, `effort`, `timeout`,
`allowCommands`, `jsonSchema`, and `output` (write the report). Single-run tools
also take `continueConv` / `conversation`; `agy_role` takes `role`.

### What comes back

Each result carries the agent's response plus:

- `conversation_id` and `num_turns` — resume the same run later.
- `usage` and duration.
- **Evidence** — files written and commands run, parsed from the live stream.
- A **run log** of every tool step, with failures marked `✗`.
- `warnings`, including anything agy denied permission for.

### Evidence you can actually verify

agy can finish with `status: SUCCESS` while a tool call was silently denied: a
blocked `write_to_file` still reports its step as `DONE`, and the denial only
surfaces in `denied_actions` on the final result. So pi-agy never takes
`files_written` at face value. Every path is resolved against the workspace and
checked on disk; anything missing is dropped and reported ("N files the agent
reported writing do not exist on disk"). Only a step in state `DONE` counts as
success — `ERROR` steps do not. A run that did nothing cannot look clean.

## Live status

Each run renders a card in the conversation instead of a wall of text: what was
asked, the step in progress, the file or command it is touching, and running
totals (steps, files, commands, turns, tokens). `Ctrl+O` expands it.

```text
▸ step 50 · ✎ worker/src/lib/contradiction.ts                 1m 39s
  ⠹ active 3s ago · steps 49 · files 6 · commands 3 · ↓ 4.2k tokens
  ├─ ✓ 47  ▤ worker/src/lib/schema.ts
  └─ ▸ 49  ✎ worker/src/lib/contradiction.ts
  ⎿  Writing the contradiction scorer… 3.4s
```

When it finishes the card shows the outcome, the response, the evidence, and
the run log. A fleet adds a per-lane board with the same states.

The status bar mirrors the active run (`agy ⟳ step 12 · ✎ src/a.ts · 42s`), and
a persistent **FleetView** widget tracks every live run in the session — open
the full inspector with `/agy-fleet` to see all of it side by side. The widget
and inspector disappear when nothing is running.

Cards are width-safe: lines are measured by visible width, truncated with
style-preserving primitives, and segmented on grapheme boundaries, so long paths
and emoji never overflow or bleed colors.

## Reports

A fleet's result is a summary — lane responses are capped at 4k characters so a
24-lane fan-out does not flood the conversation. The complete output is written
to disk on every fleet run, and the result names the path:

```text
Reports: `.agy/fleet/fleet-20251125-141133-a1b2/report.md` (4 lane files + manifest.json)
```

```text
.agy/fleet/fleet-20251125-141133-a1b2/
├── report.md          # one document: summary table + every lane in full
├── manifest.json      # machine-readable index: statuses, evidence, usage, provenance
└── lanes/
    ├── t1.md          # frontmatter + task + response + evidence + run log
    └── t2.md
```

`report.md` is the file to hand to a person or another tool. `lanes/<id>.md` is
one lane per file, so separate agents can each take their own. The YAML
frontmatter carries lane, status, role, model, workspace, duration, turns,
tokens, `conversation_id`, files written, and commands run — provenance survives
the hand-off, and `conversation_id` means a follow-up run can resume that lane.

Choose where it goes:

```text
agy_fleet({ tasks: [...], output: "docs/research" })        # that directory
agy_fleet({ tasks: [...], output: "docs/research/run.md" }) # one combined document
agy_fleet({ tasks: [...], output: false })                  # nothing on disk
```

### Single runs

A single run already returns its response in full, so its report is **opt-in**:

```text
agy_role({ role: "reviewer", prompt: "...", output: true })   # .agy/runs/run-…/
agy_code({ prompt: "...", output: "docs/impl" })              # that directory
agy({ prompt: "...", output: "docs/one.md" })                 # one document
```

```text
.agy/runs/run-20251125-151108-abcd/
├── report.md
└── manifest.json
```

The task recorded is what you asked for, not the role-expanded prompt or the
vision guide — a reviewer report shows your request above the contract's output.

### Cleanup

Cleanup is optional: every write prunes old reports first.

| Setting | Default | Meaning |
| --- | --- | --- |
| `reportKeep` | `20` | report directories kept per root (`0` = unlimited) |
| `reportMaxAgeDays` | `0` | drop reports older than N days (`0` = never) |

When you want the space back, `agy_reports` covers both roots:

```text
agy_reports({ action: "list" })                       # ids, kinds, sizes, lane counts
agy_reports({ action: "clear", fleetId: "fleet-…" })  # one report
agy_reports({ action: "clear", keep: 2 })             # all but the newest 2 per root
agy_reports({ action: "clear", olderThan: "7d" })     # older than a week
agy_reports({ action: "clear", all: true, dryRun: true })
```

`clear` needs a selector, so nothing is wiped by omission. It only touches
directories named `fleet-…` or `run-…` under a report root, refuses to follow
symlinks, and reports the bytes freed. From the terminal: `/agy-reports` to
list, `/agy-reports clear` to remove everything.

## Specialist roles

A role bundles a shaped output contract with an access policy. The same model
does noticeably better when it is told exactly what shape to return — and the
policy is what stops a review from quietly editing your code.

| Role | Access | Use it for |
| --- | --- | --- |
| `scout` | read-only | Fast recon: files, entry points, data flow, where to start. Returns a `# Code Context` brief. |
| `implementer` | writes + shell | The smallest correct change, validated with your own checks. |
| `reviewer` | read-only | Findings graded P0/P1/P2 with `file:line` evidence, or exactly `No issues found.` |
| `verifier` | read-only | Audits claimed evidence: `SUPPORTED` / `PARTIALLY SUPPORTED` / `UNSUPPORTED`. |
| `oracle` | read-only | A second opinion before you act. Attacks the plan instead of approving it. |

```text
agy_role({ role: "scout",    prompt: "Map the auth flow before we plan." })
agy_role({ role: "reviewer", prompt: "Review this diff for correctness." })
agy_role({ role: "verifier", prompt: "Claim: the cache is invalidated on write. Verify it." })
```

Read-only is **enforced**: `allowCommands` is forced off and a caller cannot
raise it. Built-in roles pin neither a model nor an effort, so every run uses
the global default — `gemini-3.8-flash-high` at `high` effort. A custom role can
pin one in config, and the caller can always override — never the access policy.

Give each fleet lane a role when the work has different shapes:

```text
agy_fleet({ tasks: [
  { id: "correctness", role: "reviewer", task: "Review src/auth.ts." },
  { id: "tests",       role: "reviewer", task: "Review tests/auth.test.ts." },
  { id: "claims",      role: "verifier", task: "Verify the PR description's claims." },
]})
```

An unknown role fails the call before any agent starts.

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

A role that omits `allowCommands` is read-only. Silence never grants write
access.

## Configuration

Defaults: `gemini-3.8-flash-high` at `high` effort for every tool and role, 10m
timeout, commands allowed, fleet concurrency 3. Precedence is built-in defaults <
`~/.pi/agy.json` < env vars < CLI flags < per-call tool params.

| Env var | Default | Meaning |
| --- | --- | --- |
| `AGY_BIN` | `agy` | binary path or name |
| `AGY_MODEL` | `gemini-3.8-flash-high` | model slug (`agy models` lists them) |
| `AGY_EFFORT` | `high` | `low` \| `medium` \| `high` |
| `AGY_AGENT` | — | agy agent name (`agy agents` lists them) |
| `AGY_TIMEOUT` | `10m` | max wait per run |
| `AGY_ALLOW_CMDS` | `true` | pass `--dangerously-skip-permissions` by default |
| `AGY_FLEET_CONCURRENCY` | `3` | parallel lanes (1–8) |
| `AGY_FLEET_OUTPUT` | `.agy/fleet` | fleet report root (`off` disables) |
| `AGY_RUN_OUTPUT` | `.agy/runs` | single-run report root (`off` disables) |
| `AGY_REPORT_KEEP` | `20` | reports kept per root before pruning |
| `AGY_REPORT_MAX_AGE_DAYS` | `0` | age limit for reports |
| `AGY_FALLBACK_MODELS` | — | comma-separated models to retry with |
| `AGY_CONFIG` | `~/.pi/agy.json` | config file path |

The config file takes the same keys in camelCase:

```json
{
  "bin": "agy",
  "model": "gemini-3.8-flash-high",
  "effort": "high",
  "timeout": "10m",
  "defaultAllowCommands": true,
  "fleetConcurrency": 3,
  "fleetOutput": ".agy/fleet",
  "runOutput": ".agy/runs",
  "reportKeep": 20
}
```

> `model` and `effort` must agree: gemini slugs encode their effort, and agy
> rejects a mismatch like `gemini-3.8-flash-medium` with `--effort high`. pi-agy
> resolves the two per precedence level and rewrites the slug to match, so
> `AGY_MODEL=gemini-3.8-flash-low` with no explicit effort keeps `low`.

**Model fallback.** Set `AGY_FALLBACK_MODELS=gemini-3.1-pro-high` to retry a
failed run with the next model. An abort is never retried. The result reports
the chain and the model that actually ran.

### Model and effort from the terminal

| Command | What it does |
| --- | --- |
| `/agy-model` | picker from `agy models`, current one marked |
| `/agy-model gemini-3.1-pro-high` | set it directly |
| `/agy-effort` | picker: `low`, `medium`, `high` |
| `/agy-effort low` | set it directly |

Changes apply to every later run in the session and are saved to the config
file, so they survive a restart. `--session` skips the save. `Tab` completes
model slugs and effort levels. At launch, `pi --agy-model … --agy-effort …`
sets the session default above env vars and the file.

Picking a gemini model also sets the effort encoded in its slug; non-gemini
models (`claude-*`, `gpt-oss-*`) ignore effort. If `AGY_MODEL` or `AGY_EFFORT`
is exported, it wins over the saved value and the command tells you so.

## Images and screenshots

`agy_vision` delegates image work to agy's multimodal agent, which opens the
actual pixels rather than guessing from a filename.

pi cannot attach images inline and the agy CLI has no image flag, so images are
delegated **by path**: workspace-relative, absolute, `~/…`, Git-Bash
(`/c/Users/…`), or `file://`. Files outside the workspace are copied into a
per-run temp directory registered with `--add-dir`, then removed — no
`allowNonWorkspaceAccess` setting needed. A path that does not exist is reported,
not silently skipped.

```text
agy_vision({
  images: ["screenshots/home.png", "screenshots/pricing.png"],
  prompt: "List every visual regression versus a standard SaaS pricing page.",
  jsonSchema: '{"type":"object","properties":{"issues":{"type":"array","items":{"type":"string"}}}}',
})
```

Local paths work from anywhere on disk:

```text
agy_vision({ images: ["~/Desktop/mock.png", "C:/Users/me/Downloads/bug.png"], prompt: "Which control is misaligned?" })
```

Read-only is the default: no `--dangerously-skip-permissions`, and the prompt
tells the agent shell commands are denied so it sticks to reading files.
`jsonSchema` is the recommended way to get structured findings back.

Pass `url` to capture the page first:

```text
agy_vision({ url: "http://localhost:3000", prompt: "Check the hero section for overflow and contrast issues." })
```

The agent drives headless Chrome (`--headless=new --screenshot=… --window-size=1280,800`),
saves the PNG in the workspace, and inspects it; the run log shows the exact
command. A `url` implies `allowCommands=true` — pass `allowCommands: false` to
override.

For image *generation*, use `agy_code` (or `agy`) with `allowCommands=true`.
Without ImageMagick or PIL the agent still manages by writing a small Node PNG
encoder or rendering HTML/SVG through headless Chrome; `ffmpeg` covers format
conversion and video frames.

**Two things to check.** Generated files that came from a *shell command* (a
headless screenshot, a Node script) do not appear in `files_written`, so verify
the file yourself before reporting success. And use a `gemini-*` slug — the
claude and gpt-oss entries in `agy models` are not the vision path.

## Commands

- `/agy <prompt>` — one-off prompt through the agent, result printed.
- `/agy-model [slug]` — pick or set the model.
- `/agy-effort [low|medium|high]` — pick or set the effort.
- `/agy-models` — show active config and list available models.
- `/agy-fleet` — open the live fleet inspector (active and recent runs).
- `/agy-reports [clear]` — list or clear the on-disk reports.
- `/agy-doctor` — check the setup: CLI, config, workspace, permissions, roles,
  models, fallback chain.

## Permissions

Headless runs deny **shell commands and file writes** unless `allowCommands` is
true (which passes `--dangerously-skip-permissions`) or matching allow rules
exist in `~/.gemini/antigravity-cli/settings.json`. Reads inside the workspace
are allowed.

That denial is silent at the step level, which is the trap pi-agy exists to
close: a denied write still reports `DONE`, the run still ends `SUCCESS`, and
the response can be empty. pi-agy detects it, adds a warning with the
remediation, and never lists a denied write as evidence.

Anything that must write files needs `allowCommands: true`. The read-only
presets — `agy_vision`, and `agy_role` with `scout` or `reviewer` — keep it off
by design, so they can inspect your code but never modify it.

Workspaces accept Windows (`C:\…`) and Git-Bash (`/tmp/…`, `~/…`) forms and are
registered with `--add-dir`, so files land in the workspace instead of agy's
scratch directory. `continueConv: true` resumes the previous conversation for
that workspace.

## Development

Entry point is `index.ts`, which only wires things up; all logic lives in `src/`
with one-directional dependencies.

```text
src/config.ts    defaults, env vars, ~/.pi/agy.json, roles, fallbacks
src/roles.ts     roles: prompt contracts + enforced access policy
src/runner.ts    spawn agy, parse stream-json, extract evidence
src/results.ts   tool result assembly (response + run log + evidence)
src/executors.ts single-run and fleet execution
src/artifacts.ts reports on disk: write, list, prune, clear
src/tools.ts     tool definitions, schemas, TUI renderers
src/render.ts    cards: call, stream, result
src/status.ts    live activity, run log, durations
src/ui.ts        width-safe primitives (View, trunc, fit, wrap)
src/fleet.ts     lane state and headless board
src/registry.ts  session-wide run registry
src/fleetview.ts persistent FleetView widget
src/inspector.ts /agy-fleet overlay
src/vision.ts    image prompt building and staging
src/doctor.ts    /agy-doctor checks
src/model.ts     gemini slug / effort consistency
src/paths.ts     workspace path normalization
```

```bash
npm install             # dev tools + peer packages
npm run typecheck       # tsc --noEmit
npm test                # node --test tests/*.test.ts
npm run test:watch      # re-run on change
npm run pack:check      # inspect the exact npm tarball
npm run release:verify  # typecheck + tests + pack check
```

Try the working copy without installing it:

```bash
pi -e /absolute/path/to/pi-agy
```

**Branches and releases.** `main` is production and always releasable;
`develop` is the integration branch and the target for pull requests. Every push
to either branch, and every pull request, runs
[CI](.github/workflows/ci.yml) (typecheck + tests on Node 22, 24, 26, tarball
check). Releases are cut by pushing an annotated `vX.Y.Z` tag on `main`; the
[Release workflow](.github/workflows/release.yml) verifies the tag against
`package.json`, publishes to npm with provenance, and opens a GitHub Release.
The full runbook, including npm Trusted Publishing, is in
[RELEASING.md](RELEASING.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the branch
model, commit conventions, and PR checklist. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

The agent runs with your credentials and, when `allowCommands` is on, full shell
access. Treat prompts you send it as trusted input. Report vulnerabilities
privately per [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
