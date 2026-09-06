/**
 * pi-agy — Antigravity CLI (agy) worker extension for pi.
 *
 * Delegates low-level tasks (writing code, exploring a codebase, focused
 * research passes) to Google Antigravity's headless CLI (`agy`), which drives
 * a Gemini (or other) model agent with its own tool loop. Pi's main agent
 * stays in control as the ORCHESTRATOR and verifies the agent's work before
 * reporting success — that guidance is injected automatically on every agent
 * start, so installation is all users need.
 *
 * Live status, subagent-style:
 *   - Every agy run streams a compact status line into the conversation while
 *     it works: which step the agent is on, the file it is writing/editing,
 *     the command it is running (`> step 4 · ✎ src/main.ts`, `$ npm test`).
 *     A parallel footer status and a final "Run log" of every tool step make
 *     progress visible without babysitting the run.
 *   - `agy_fleet` fans out multiple agy agents on a list of tasks (bounded
 *     concurrency) and publishes a live per-lane board — same shape as
 *     pi-subagents cards — then returns per-lane evidence for verification.
 *
 * Module layout (src/): config, model, paths, status (live activity lines),
 * fleet (fan-out board), runner (agy stream parsing), results (tool result
 * assembly), executors (shared tool execution), tools (tool definitions).
 * This entry file only wires everything into the extension runtime.
 *
 * Requirements:
 *   - `agy` installed and authenticated once (`agy -p "hi"` works).
 *   - Headless mode uses cached credentials; no interactive login needed.
 *
 * Configuration (all optional — sensible defaults below):
 *   - Env vars:  AGY_BIN, AGY_MODEL, AGY_EFFORT, AGY_AGENT, AGY_TIMEOUT,
 *                AGY_ALLOW_CMDS, AGY_FLEET_CONCURRENCY, AGY_CONFIG
 *   - User file: ~/.pi/agy.json (path overridable via AGY_CONFIG)
 *   Order of precedence: built-in defaults < user file < env vars < tool params.
 *
 * The extension never writes to disk, so `pi remove` leaves no residue.
 *
 * Headless-mode permissions:
 *   File reads/writes inside the workspace are auto-allowed by agy. Shell
 *   commands are auto-denied unless allowCommands is true (passes
 *   --dangerously-skip-permissions) or matching allow rules exist in
 *   ~/.gemini/antigravity-cli/settings.json. When a tool call is denied, agy
 *   can finish with status SUCCESS but an empty response; this extension
 *   detects that and reports it so the orchestrator can retry with
 *   allowCommands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./src/config.ts";
import { runAgy } from "./src/runner.ts";
import { agyCode, agyExplore, agyFleet, agyRun } from "./src/tools.ts";

// Re-export the public surface (helper functions/types used by tests and
// external consumers).

export { config, clampConcurrency, MAX_FLEET_CONCURRENCY, MAX_FLEET_TASKS } from "./src/config.ts";
export type { AgyConfig } from "./src/config.ts";
export { matchEffort } from "./src/model.ts";
export {
	activityLine,
	buildRunLog,
	debounce,
	formatDuration,
	idleActivity,
	liveDetail,
	toDisplayPath,
	truncate,
} from "./src/status.ts";
export type { LiveActivity, StepRecord } from "./src/status.ts";
export { formatFleetBoard, summarizeFleet } from "./src/fleet.ts";
export type { FleetLaneState, FleetSummary } from "./src/fleet.ts";
export { buildResult } from "./src/results.ts";
export { executeAgy, executeFleet } from "./src/executors.ts";
export type { AgyToolParams, FleetCallParams, FleetTaskParams } from "./src/executors.ts";
export { agyCode, agyExplore, agyFleet, agyRun } from "./src/tools.ts";
export { runAgy } from "./src/runner.ts";
export type { RunOptions, StreamResult } from "./src/runner.ts";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(agyRun);
	pi.registerTool(agyExplore);
	pi.registerTool(agyCode);
	pi.registerTool(agyFleet);

	// Pi is the orchestrator: when it delegates work to the agy agent tools, it
	// must verify the outcome itself before reporting success. This guidance is
	// injected automatically on every agent start — installation is all users
	// need; there is nothing to configure manually.
	const ORCHESTRATOR_GUIDE = [
		"## Orchestration with the agy tools",
		"You are the orchestrator. Use agy, agy_code, agy_explore, and agy_fleet to delegate low-level subtasks (writing code, exploring a codebase, research passes) to the Antigravity Gemini agent instead of doing them inline.",
		"- For independent subtasks, fan out with agy_fleet(tasks:[{id, task, workspace?, allowCommands?}, ...]) — each lane is a separate agy agent; the live board and per-lane results tell you what each one did.",
		"After a delegated agy run (including each agy_fleet lane), VERIFY the outcome yourself before reporting success:",
		"- files the agent claims to have written exist and contain what was asked (use read / ls / grep),",
		"- commands or tests the agent claims to have run actually pass (re-run them with bash when cheap),",
		"- exploration answers are grounded in the actual files (spot-check with read/grep).",
		"If verification fails, or the agy agent returned no output because its tool calls were auto-denied, iterate: retry with allowCommands=true when shell access is needed, or send a follow-up agy call with continueConv=true to fix the remaining issues.",
		"Report what was done with concrete evidence: files changed and verification results.",
	].join("\n");

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + ORCHESTRATOR_GUIDE };
	});

	// Quick sanity check / model list.
	pi.registerCommand("agy-models", {
		description: "List Antigravity (agy) models and show the pi-agy config",
		handler: async (_args, ctx) => {
			const { execFile } = await import("node:child_process");
			const models = await new Promise<string>((res) => {
				execFile(config.bin, ["models"], { windowsHide: true }, (err, stdout) =>
					res(err ? `(could not list models: ${err.message})` : stdout)
				);
			});
			const msg =
				`agy bin=${config.bin}\nmodel=${config.model}\neffort=${config.effort}\n` +
				`allowCommands=${config.defaultAllowCommands}\n` +
				`timeout=${config.timeout}\nfleetConcurrency=${config.fleetConcurrency}\n` +
				`config=${config.configFile}\n\n${models}`;
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});

	// One-off quick prompt through the agy agent, prints result.
	pi.registerCommand("agy", {
		description: "Run a one-off prompt through the agy (Antigravity) agent",
		handler: async (args, ctx) => {
			const prompt = args || (ctx.hasUI ? await ctx.ui.input("Prompt for agy:", "e.g. refactor the auth module") : undefined);
			if (!prompt) return;
			if (ctx.hasUI) ctx.ui.notify("Running agy…", "info");
			try {
				const r = await runAgy({
					prompt,
					workspace: ctx.cwd,
					allowCommands: config.defaultAllowCommands,
					continueConv: false,
					timeout: config.timeout,
				});
				if (ctx.hasUI) ctx.ui.notify(r.response?.trim() || "(no response)", "info");
			} catch (e) {
				if (ctx.hasUI) ctx.ui.notify(`agy failed: ${(e as Error).message}`, "error");
			}
		},
	});
}