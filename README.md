# pi-agy

Delegate low-level tasks — writing code, exploring a codebase, research passes —
to Google Antigravity's [agy CLI](https://antigravity.google/docs/cli/headless/)
running a Gemini agent. Pi stays the **orchestrator**: it farms out subtasks to
agy (`agy`, `agy_code`, `agy_explore` tools), then **verifies** the agent's work
itself before reporting success.

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

All tools stream progress live and return the agent's response plus metadata:
`conversation_id`, `num_turns`, `usage`, duration, `warnings`, and verification
**evidence** (files written, commands run).

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
| `AGY_CONFIG`        | `~/.pi/agy.json`        | path to the optional user config file      |

Optional user config file `~/.pi/agy.json` (env vars win over it, per-call
tool params win over both):

```json
{
  "bin": "agy",
  "model": "gemini-3.8-flash-high",
  "effort": "high",
  "timeout": "10m",
  "defaultAllowCommands": true
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

1. **Delegate** low-level subtasks to the agy tools instead of doing them inline.
2. **Verify** after each run — files exist with the right contents (`read`/`grep`),
   claimed tests/commands re-run (`bash`), exploration answers spot-checked.
3. **Iterate** when verification fails — `allowCommands=true` if a tool call was
   auto-denied, or `continueConv=true` to keep the same agent conversation.
4. **Report evidence** — files changed and verification results.

Tool results back this up: every run reports `files_written` and `commands_run`
(both in the response text as `Evidence — …` and in `details`), parsed from
agy's live stream.

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