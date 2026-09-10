/**
 * pi-agy — Antigravity CLI (agy) worker extension for pi.
 *
 * Delegates low-level tasks (writing code, exploring a codebase, focused
 * research passes) to Google Antigravity's headless CLI (`agy`), which drives
 * a Gemini (or other) model agent with its own tool loop. Pi's main agent
 * stays in control as the ORCHESTRATOR and verifies the agent's work before
 * reporting success. Delegation is OPT-IN: guidance injected on every agent
 * start tells pi not to call any agy tool unless the user explicitly asks for
 * agy, and (when asked) to verify the result before reporting success.
 *
 * Live status (rich TUI cards):
 *   - Every run renders a call card plus a live status card — current step and
 *     the file/command being worked on, running metrics (steps · files ·
 *     commands), a recent step trail, and a response preview — then a result
 *     card with the outcome, response, evidence (files written / commands run),
 *     and a capped run log (Ctrl+O to expand).
 *   - `agy_fleet` fans out multiple agy agents on a list of tasks (bounded
 *     concurrency) and publishes a live per-lane board, then returns per-lane
 *     evidence for verification.
 *
 * Module layout (src/): config, model, paths, vision (image-prompt building),
 * status (live activity state), ui (width-safe card primitives), render (TUI
 * cards), fleet (fan-out board), runner (agy stream parsing), results (tool
 * result assembly), executors (shared tool execution), tools (tool definitions
 * + renderers).
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
import { agyCode, agyExplore, agyFleet, agyRun, agyVision } from "./src/tools.ts";

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
	isWriteTool,
	liveDetail,
	toDisplayPath,
	truncate,
} from "./src/status.ts";
export type { LiveActivity, StepRecord } from "./src/status.ts";
export { formatFleetBoard, summarizeFleet } from "./src/fleet.ts";
export type { FleetLaneState, FleetSummary } from "./src/fleet.ts";
export {
	fleetBoardLines,
	fleetCallLines,
	fleetRenderers,
	fleetResultLines,
	singleActivityLines,
	singleCallLines,
	singleRenderers,
	singleResultLines,
} from "./src/render.ts";
export type {
	AgyCallArgs,
	AgyMeta,
	AgyPreset,
	FleetCallArgs,
	FleetDetails,
	FleetLaneDetails,
	FleetTaskArgs,
	SingleDetails,
} from "./src/render.ts";
export { compactNumber, divider, oneLine, row, trunc, View, wrap } from "./src/ui.ts";
export type { RenderComponent, ThemeLike } from "./src/ui.ts";
export { buildResult } from "./src/results.ts";
export { executeAgy, executeFleet } from "./src/executors.ts";
export type { AgyToolParams, FleetCallParams, FleetTaskParams } from "./src/executors.ts";
export { agyCode, agyExplore, agyFleet, agyRun, agyVision } from "./src/tools.ts";
export {
	buildVisionPrompt,
	isImagePath,
	NO_SHELL_GUIDE,
	normalizeImages,
	resolveVisionAllowCommands,
	VISION_GUIDE,
} from "./src/vision.ts";
export type { VisionPromptInput } from "./src/vision.ts";
export { runAgy } from "./src/runner.ts";
export type { RunOptions, StreamResult } from "./src/runner.ts";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(agyRun);
	pi.registerTool(agyExplore);
	pi.registerTool(agyCode);
	pi.registerTool(agyVision);
	pi.registerTool(agyFleet);

	// The agy tools are OPT-IN: the injected guidance forbids delegating unless
	// the user explicitly asks for agy, and reminds pi to verify whenever it is
	// allowed to delegate. Injected automatically on every agent start.
	const AGY_GUIDE = [
		"## Antigravity (agy) tools — opt-in only",
		"agy, agy_code, agy_explore, agy_vision, and agy_fleet delegate work to Google Antigravity's Gemini agent. They are OFF BY DEFAULT: do NOT call any agy tool (and do not otherwise invoke the Antigravity agent) unless the user explicitly asks for it in the current request — e.g. \"use agy\", \"delegate this to agy\", \"run agy_fleet\", \"use the agy tools\", or \"use Antigravity\".",
		"Do not infer permission from incidental words. \"Delegate\", \"parallelize\", \"fan out\", \"explore\", \"investigate\", or \"subtasks\" on their own do NOT mean \"use agy\": handle those with your normal tools (or ask the user which they want). An earlier request to use agy does not carry over to later turns.",
		"When you are not explicitly asked to use agy, do the work yourself and never silently hand it to the Antigravity agent.",
		"Once the user has asked, you are the orchestrator for that task: use agy, agy_code, agy_explore, agy_vision, and agy_fleet to delegate low-level subtasks (writing code, exploring a codebase, inspecting screenshots/images, research passes) to the Antigravity agent instead of doing them inline.",
		"- Image and screenshot work goes to agy_vision({ images: [\"path/to/shot.png\"], prompt, url?, jsonSchema? }): the agent opens the actual pixels. `images` accepts workspace-relative, absolute, `~/…`, Windows, Git-Bash, and file:// paths — files outside the workspace are staged into a temp dir for the run, so you can point at screenshots anywhere on disk. `url` makes it capture a headless-Chrome screenshot first (implies allowCommands). pi cannot attach images inline, so pass file paths.",
		"- For independent subtasks, fan out with agy_fleet(tasks:[{id, task, workspace?, allowCommands?}, ...]) — each lane is a separate agy agent; the live board and per-lane results tell you what each one did.",
		"After a delegated agy run (including each agy_fleet lane), VERIFY the outcome yourself before reporting success:",
		"- files the agent claims to have written exist and contain what was asked (use read / ls / grep),",
		"- commands or tests the agent claims to have run actually pass (re-run them with bash when cheap),",
		"- exploration answers are grounded in the actual files (spot-check with read/grep).",
		"If verification fails, or the agy agent returned no output because its tool calls were auto-denied, iterate: retry with allowCommands=true when shell access is needed, or send a follow-up agy call with continueConv=true to fix the remaining issues.",
		"Report what was done with concrete evidence: files changed and verification results.",
	].join("\n");

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + AGY_GUIDE };
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