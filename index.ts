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
 *   - Terminal:  /agy-model and /agy-effort pick the model + effort live and
 *                save them to the user file; `pi --agy-model` / `pi
 *                --agy-effort` set the session default at launch.
 *   Order of precedence: built-in defaults < user file < env vars < CLI flags
 *   < per-call tool params.
 *
 * The extension writes nothing of its own — only your own `~/.pi/agy.json`
 * when you run `/agy-model` or `/agy-effort` — so `pi remove` leaves no
 * residue.
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

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { config, roles } from "./src/config.ts";
import { EFFORT_LEVELS, isEffort, isGemini } from "./src/model.ts";
import {
	applyEffort,
	applyModel,
	envOverridesFor,
	listModels,
	parseSettingsArgs,
	saveUserConfig,
	settingsPatch,
	type AppliedSettings,
	type ModelEntry,
} from "./src/settings.ts";
import { doctorDeps, formatDoctorReport, runDoctor } from "./src/doctor.ts";
import { AgyFleetView } from "./src/fleetview.ts";
import { openFleetInspector } from "./src/inspector.ts";
import { agyFleetRegistry } from "./src/registry.ts";
import { runAgy } from "./src/runner.ts";
import { agyCode, agyFleet, agyRole, agyRun, agyVision } from "./src/tools.ts";

// Re-export the public surface (helper functions/types used by tests and
// external consumers).

export { config, clampConcurrency, MAX_FLEET_CONCURRENCY, MAX_FLEET_TASKS, roles } from "./src/config.ts";
export type { AgyConfig } from "./src/config.ts";
export {
	applyRole,
	BUILTIN_ROLES,
	findRole,
	resolveRoles,
	roleIds,
} from "./src/roles.ts";
export type { AgyRole, AgyRoleOverride, RoleResolution } from "./src/roles.ts";
export { doctorDeps, formatDoctorReport, runDoctor } from "./src/doctor.ts";
export type { DoctorCheck, DoctorReport, DoctorStatus } from "./src/doctor.ts";
export { EFFORT_LEVELS, effortFromModel, isEffort, matchEffort } from "./src/model.ts";
export {
	ACTIVITY_LONG_RUNNING_MS,
	ACTIVITY_NEEDS_ATTENTION_MS,
	activityAgeMs,
	activityFreshnessText,
	activityLine,
	activityState,
	buildRunLog,
	debounce,
	formatDuration,
	idleActivity,
	isWriteTool,
	liveDetail,
	toDisplayPath,
	toolDurationMs,
	truncate,
} from "./src/status.ts";
export type { ActivityState, LiveActivity, StepRecord } from "./src/status.ts";
export { formatFleetBoard, summarizeFleet } from "./src/fleet.ts";
export type { FleetLaneState, FleetSummary } from "./src/fleet.ts";
export {
	activeFleetTotals,
	AGY_FLEET_WIDGET_KEY,
	AgyFleetView,
	fleetCollapsedLines,
	fleetRosterLine,
	fleetRosterLines,
	fleetSingleRunLines,
} from "./src/fleetview.ts";
export type { AgyFleetViewOptions } from "./src/fleetview.ts";
export {
	FleetInspectorComponent,
	fleetDetailLines,
	formatFleetText,
	openFleetInspector,
} from "./src/inspector.ts";
export {
	agyFleetRegistry,
	FleetRegistry,
	isActiveStatus,
} from "./src/registry.ts";
export type {
	AgyRunFinish,
	AgyRunInput,
	AgyRunPreset,
	AgyRunRecord,
	AgyRunStatus,
	FleetCounts,
} from "./src/registry.ts";
export {
	fleetBoardLines,
	fleetCallLines,
	fleetRenderers,
	fleetResultLines,
	LiveView,
	singleActivityLines,
	singleCallLines,
	singleRenderers,
	singleResultLines,
} from "./src/render.ts";
export type {
	AgyCallArgs,
	AgyMeta,
	AgyPreset,
	AgyRenderState,
	FleetCallArgs,
	FleetDetails,
	FleetLaneDetails,
	FleetTaskArgs,
	SingleDetails,
} from "./src/render.ts";
export {
	compactNumber,
	divider,
	fitLine,
	formatActivityAge,
	formatTokens,
	frameAt,
	oneLine,
	row,
	SPINNER_FRAMES,
	spinnerGlyph,
	treeBranch,
	treeIndent,
	trunc,
	truncLine,
	View,
	wrap,
} from "./src/ui.ts";
export type { RenderComponent, ThemeLike } from "./src/ui.ts";
export { buildResult } from "./src/results.ts";
export { executeAgy, executeFleet } from "./src/executors.ts";
export type { AgyToolParams, FleetCallParams, FleetTaskParams } from "./src/executors.ts";
export { agyCode, agyFleet, agyRole, agyRun, agyVision } from "./src/tools.ts";
export {
	buildVisionPrompt,
	isImagePath,
	NO_SHELL_GUIDE,
	normalizeImages,
	resolveVisionAllowCommands,
	VISION_GUIDE,
} from "./src/vision.ts";
export type { VisionPromptInput } from "./src/vision.ts";
export { extractOutputTail, runAgy, splitExistingFiles } from "./src/runner.ts";
export type { RunOptions, StreamResult } from "./src/runner.ts";
export {
	applyEffort,
	applyModel,
	envOverrides,
	envOverridesFor,
	listModels,
	MODEL_LIST_TIMEOUT_MS,
	parseModelCatalogue,
	parseSettingsArgs,
	readUserConfig,
	saveUserConfig,
	settingsPatch,
} from "./src/settings.ts";
export type {
	AppliedSettings,
	ModelEntry,
	ModelListExec,
	SettingsArgs,
	SettingsTarget,
} from "./src/settings.ts";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(agyRun);
	pi.registerTool(agyCode);
	pi.registerTool(agyVision);
	pi.registerTool(agyRole);
	pi.registerTool(agyFleet);

	// CLI flags set the session defaults at launch:
	//   pi --agy-model gemini-3.1-pro-high --agy-effort high
	pi.registerFlag("agy-model", {
		description: "agy model slug for this pi session (overrides AGY_MODEL and ~/.pi/agy.json)",
		type: "string",
	});
	pi.registerFlag("agy-effort", {
		description: "agy reasoning effort for this pi session: low, medium, or high",
		type: "string",
	});

	/** Flags outrank env vars and the config file, but not per-call tool params. */
	function applyFlagOverrides(): string[] {
		const notes: string[] = [];
		const model = pi.getFlag("agy-model");
		if (typeof model === "string" && model.trim()) applyModel(config, model);
		const effort = pi.getFlag("agy-effort");
		if (typeof effort === "string" && effort.trim()) {
			const level = effort.trim();
			if (isEffort(level)) applyEffort(config, level);
			else notes.push(`ignoring --agy-effort=${effort}: expected low, medium, or high`);
		}
		return notes;
	}

	for (const note of applyFlagOverrides()) console.warn(`[pi-agy] ${note}`);

	// The session fleet surface: a persistent widget under the editor while agy
	// work runs, plus the /agy-fleet inspector it opens. Both read the same
	// session-wide registry the executors write to.
	const fleetView = new AgyFleetView((ctx) => openFleetInspector(ctx, agyFleetRegistry));

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") agyFleetRegistry.clear();
		fleetView.setContext(ctx);
	});

	pi.on("session_shutdown", () => {
		fleetView.dispose();
	});

	// The agy tools are OPT-IN: the injected guidance forbids delegating unless
	// the user explicitly asks for agy, and reminds pi to verify whenever it is
	// allowed to delegate. Injected automatically on every agent start.
	const AGY_GUIDE = [
		"## Antigravity (agy) tools — opt-in only",
		"agy, agy_code, agy_vision, agy_role, and agy_fleet delegate work to Google Antigravity's Gemini agent. They are OFF BY DEFAULT: do NOT call any agy tool (and do not otherwise invoke the Antigravity agent) unless the user explicitly asks for it in the current request — e.g. \"use agy\", \"delegate this to agy\", \"run agy_fleet\", \"use the agy tools\", or \"use Antigravity\".",
		"Do not infer permission from incidental words. \"Delegate\", \"parallelize\", \"fan out\", \"explore\", \"investigate\", or \"subtasks\" on their own do NOT mean \"use agy\": handle those with your normal tools (or ask the user which they want). An earlier request to use agy does not carry over to later turns.",
		"When you are not explicitly asked to use agy, do the work yourself and never silently hand it to the Antigravity agent.",
		"Once the user has asked, you are the orchestrator for that task: use agy, agy_code, agy_vision, agy_role, and agy_fleet to delegate low-level subtasks (writing code, exploring a codebase, inspecting screenshots/images, research passes) to the Antigravity agent instead of doing them inline.",
		"- Codebase exploration has no dedicated tool: use agy_role({ role: \"scout\", prompt }) for a read-only recon pass, or read-only agy_fleet lanes when several areas need mapping at once. Read-only roles are enforced — they cannot be granted write or shell access.",
		"- Image and screenshot work goes to agy_vision({ images: [\"path/to/shot.png\"], prompt, url?, jsonSchema? }): the agent opens the actual pixels. `images` accepts workspace-relative, absolute, `~/…`, Windows, Git-Bash, and file:// paths — files outside the workspace are staged into a temp dir for the run, so you can point at screenshots anywhere on disk. `url` makes it capture a headless-Chrome screenshot first (implies allowCommands). pi cannot attach images inline, so pass file paths.",
		"- For independent subtasks, fan out with agy_fleet(tasks:[{id, task, workspace?, role?, allowCommands?}, ...]) — each lane is a separate agy agent; the live board and per-lane results tell you what each one did. A lane may name a specialist role.",
		"- Prefer agy_role({ role, prompt }) when the work has a recognisable shape — it applies a prompt contract plus an access policy that an unstructured prompt does not get: scout (read-only recon), implementer (edits + validation), reviewer (findings with severities), verifier (audits claimed evidence), oracle (second opinion). Read-only roles are enforced and cannot be granted write or shell access.",
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

	// Open the live fleet inspector (active + recently finished agy runs).
	pi.registerCommand("agy-fleet", {
		description: "Open the live agy fleet inspector (active + recent runs)",
		handler: async (_args, ctx) => {
			await openFleetInspector(ctx, agyFleetRegistry);
		},
	});

	// Check the setup: agy CLI, config, workspace, permission mode, roles, models.
	pi.registerCommand("agy-doctor", {
		description: "Check the pi-agy setup (agy CLI, config, permissions, roles, models)",
		handler: async (_args, ctx) => {
			const report = await runDoctor(await doctorDeps(config, roles, ctx.cwd));
			const text = formatDoctorReport(report);
			if (ctx.hasUI) ctx.ui.notify(text, report.ok ? "info" : "error");
			else console.log(text);
		},
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

	// -----------------------------------------------------------------------
	// Terminal settings: pick the model + effort agy runs with
	// -----------------------------------------------------------------------

	const settingsHelp: Record<"model" | "effort", string> = {
		model: [
			"Usage: /agy-model [slug] [--session]",
			"",
			"With no slug, picks from the models in `agy models`.",
			`The choice applies to every later agy run and is saved to ${config.configFile}.`,
			"Pass --session to change this session only.",
		].join("\n"),
		effort: [
			"Usage: /agy-effort [low|medium|high] [--session]",
			"",
			"With no level, picks from low/medium/high.",
			"Effort applies to gemini-* models only and keeps the model slug in sync.",
			`The choice is saved to ${config.configFile}; pass --session to skip saving.`,
		].join("\n"),
	};

	let modelCache: { at: number; entries: ModelEntry[] } | undefined;
	const MODEL_CACHE_MS = 60_000;

	async function cachedModels(): Promise<ModelEntry[]> {
		if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.entries;
		const entries = await listModels(config.bin);
		modelCache = { at: Date.now(), entries };
		return entries;
	}

	async function pickModel(ctx: ExtensionContext): Promise<string | undefined> {
		ctx.ui.notify("Fetching agy models…", "info");
		const entries = await cachedModels();
		if (entries.length === 0) {
			ctx.ui.notify(`Could not list models (\`${config.bin} models\` failed).`, "warning");
			const typed = await ctx.ui.input(`agy model (current: ${config.model})`, "e.g. gemini-3.1-pro-high");
			return typed?.trim() || undefined;
		}
		const choices: { value: string; label: string }[] = [];
		const seen = new Set<string>();
		const add = (slug: string, label?: string) => {
			if (!slug || seen.has(slug)) return;
			seen.add(slug);
			choices.push({ value: slug, label: label ? `${slug}  —  ${label}` : slug });
		};
		if (!entries.some((entry) => entry.slug === config.model)) add(config.model, "current");
		for (const entry of entries) add(entry.slug, entry.label === entry.slug ? undefined : entry.label);
		const options = choices.map((choice) => (choice.value === config.model ? `● ${choice.label}` : `  ${choice.label}`));
		const picked = await ctx.ui.select(`agy model (current: ${config.model})`, options);
		const index = picked === undefined ? -1 : options.indexOf(picked);
		return index >= 0 ? choices[index].value : undefined;
	}

	async function pickEffort(ctx: ExtensionContext): Promise<string | undefined> {
		const options = EFFORT_LEVELS.map((level) => (level === config.effort ? `● ${level} (current)` : `  ${level}`));
		const picked = await ctx.ui.select(`agy effort (current: ${config.effort})`, options);
		if (picked === undefined) return undefined;
		return EFFORT_LEVELS.find((level) => picked.includes(level));
	}

	function notifySettings(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else console.log(message);
	}

	async function settingsCommand(kind: "model" | "effort", args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseSettingsArgs(args);
		if (parsed.help) return notifySettings(ctx, settingsHelp[kind]);
		if (parsed.extra.length) {
			return notifySettings(ctx, `Unexpected extra arguments: ${parsed.extra.join(" ")}\n\n${settingsHelp[kind]}`, "error");
		}

		let value = parsed.value;
		if (!value) {
			if (!ctx.hasUI) return notifySettings(ctx, settingsHelp[kind], "error");
			value = kind === "model" ? await pickModel(ctx) : await pickEffort(ctx);
			if (!value) return; // cancelled
		}

		let applied: AppliedSettings;
		if (kind === "model") applied = applyModel(config, value);
		else if (isEffort(value)) applied = applyEffort(config, value);
		else return notifySettings(ctx, `Unknown effort "${value}". Use low, medium, or high.`, "error");

		const notes: string[] = [];
		let saved = false;
		let saveFailed = false;
		if (parsed.session) {
			notes.push("this session only (--session)");
		} else {
			try {
				saveUserConfig(config.configFile, settingsPatch(applied));
				saved = true;
				notes.push(`saved to ${config.configFile}`);
			} catch (e) {
				saveFailed = true;
				notes.push(`could not save ${config.configFile}: ${(e as Error).message} — applied for this session`);
			}
		}
		// Override notices only matter when something was actually saved; a
		// `--session` change is not overridden by env vars or launch flags.
		const overriding = saved ? envOverridesFor(kind) : [];
		for (const name of overriding) notes.push(`${name} is set and overrides the saved value`);
		const flag = pi.getFlag(`agy-${kind}`);
		if (saved && typeof flag === "string" && flag.trim()) {
			notes.push(`--agy-${kind} is set and will override the saved value on the next launch`);
		}

		const headline = kind === "model" ? `agy model → ${applied.model}` : `agy effort → ${applied.effort}`;
		const detail = kind === "model" && isGemini(applied.model) ? ` (effort ${applied.effort})` : "";
		notifySettings(
			ctx,
			[headline + detail, ...notes, "applies to the next agy run"].join("\n"),
			saveFailed || overriding.length ? "warning" : "info"
		);
	}

	pi.registerCommand("agy-model", {
		description: "Choose the agy model (picker, or /agy-model <slug>) — saved to your config",
		getArgumentCompletions: async (prefix: string) => {
			const entries = await cachedModels();
			const items = entries
				.map((entry) => ({
					value: entry.slug,
					label: entry.slug,
					description: entry.label === entry.slug ? undefined : entry.label,
				}))
				.filter((item) => item.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await settingsCommand("model", args, ctx);
		},
	});

	pi.registerCommand("agy-effort", {
		description: "Choose the agy reasoning effort (low/medium/high) — saved to your config",
		getArgumentCompletions: (prefix: string) => {
			const items = EFFORT_LEVELS.map((level) => ({ value: level, label: level })).filter((item) =>
				item.value.startsWith(prefix)
			);
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await settingsCommand("effort", args, ctx);
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