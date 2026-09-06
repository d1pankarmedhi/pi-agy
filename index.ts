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

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgyConfig {
	bin: string;
	model: string;
	effort: "low" | "medium" | "high";
	agent?: string;
	timeout: string;
	defaultAllowCommands: boolean;
	fleetConcurrency: number;
	configFile: string;
}

const DEFAULT_CONFIG: Omit<AgyConfig, "configFile"> = {
	bin: "agy",
	model: "gemini-3.8-flash-high",
	effort: "high",
	timeout: "10m",
	defaultAllowCommands: true,
	fleetConcurrency: 3,
};

/** Hard cap for parallel agy lanes (also the clamp ceiling for the config). */
export const MAX_FLEET_CONCURRENCY = 8;
/** Hard cap for tasks per agy_fleet call. */
export const MAX_FLEET_TASKS = 24;

export function clampConcurrency(n: number, max = MAX_FLEET_CONCURRENCY): number {
	if (!Number.isFinite(n)) return DEFAULT_CONFIG.fleetConcurrency;
	return Math.min(max, Math.max(1, Math.floor(n)));
}

function userConfigPath(): string {
	const env = process.env.AGY_CONFIG;
	return env ? resolve(env) : join(homedir(), ".pi", "agy.json");
}

function loadConfig(): AgyConfig {
	const filePath = userConfigPath();
	let file: Partial<AgyConfig> = {};
	try {
		if (existsSync(filePath)) file = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (e) {
		console.warn(`[pi-agy] could not read ${filePath}: ${(e as Error).message}`);
	}
	const envBool = (v: string | undefined, dflt: boolean) =>
		v === undefined ? dflt : v.toLowerCase() === "true" || v === "1";
	const envInt = (v: string | undefined, dflt: number) => {
		const n = parseInt(v ?? "", 10);
		return Number.isFinite(n) && n > 0 ? n : dflt;
	};
	return {
		bin: process.env.AGY_BIN || file.bin || DEFAULT_CONFIG.bin,
		model: process.env.AGY_MODEL || file.model || DEFAULT_CONFIG.model,
		effort: ((process.env.AGY_EFFORT || file.effort || DEFAULT_CONFIG.effort) as AgyConfig["effort"]),
		agent: process.env.AGY_AGENT || file.agent,
		timeout: process.env.AGY_TIMEOUT || file.timeout || DEFAULT_CONFIG.timeout,
		defaultAllowCommands: envBool(process.env.AGY_ALLOW_CMDS, file.defaultAllowCommands ?? DEFAULT_CONFIG.defaultAllowCommands),
		fleetConcurrency: clampConcurrency(
			envInt(process.env.AGY_FLEET_CONCURRENCY, file.fleetConcurrency ?? DEFAULT_CONFIG.fleetConcurrency)
		),
		configFile: filePath,
	};
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Model / effort helpers
// ---------------------------------------------------------------------------

/**
 * Keep the gemini model slug consistent with the requested effort. agy rejects
 * combinations like `--model gemini-3.8-flash-medium --effort high`, so a
 * gemini slug ending in -low/-medium/-high is rewritten to match `effort`.
 * Non-gemini models (claude, gpt-oss, ...) are returned unchanged; they do not
 * accept a --effort flag.
 */
export function matchEffort(model: string, effort: string | undefined): string {
	if (!effort) return model;
	const m = /^(gemini-[^-]+-[^-]+)-(low|medium|high)$/.exec(model);
	return m ? `${m[1]}-${effort}` : model;
}

function isGemini(model: string): boolean {
	return /^gemini-/.test(model);
}

// Last conversation id per workspace, so `continue` can resume real context.
const lastConversation = new Map<string, string>();

// ---------------------------------------------------------------------------
// Path helpers (Git Bash paths like /tmp/foo or ~/dev on Windows)
// ---------------------------------------------------------------------------

let cygpathWorks: boolean | null = null;

function toWindowsPath(p: string): string {
	if (cygpathWorks === false) return resolve(p);
	try {
		const out = execFileSync("cygpath", ["-w", p], { encoding: "utf8" }).trim();
		if (out) {
			cygpathWorks = true;
			return out;
		}
	} catch {
		cygpathWorks = false;
	}
	return resolve(p);
}

function resolveWorkspace(raw: string, cwd: string): string {
	let p = raw.trim();
	if (p === ".") return cwd;
	if (p.startsWith("~")) p = resolve(homedir(), p.slice(1));
	if (process.platform === "win32" && /^\/[^/]/.test(p) && !/^[A-Za-z]:/.test(p)) {
		return toWindowsPath(p);
	}
	return resolve(cwd, p);
}

// ---------------------------------------------------------------------------
// Live status (subagent-style activity tracking)
//
// While an agy agent runs we know, from its stream-json events, the current
// step index, which tool it is using, and the file/command that tool touches.
// That becomes a compact status line streamed into the conversation card, a
// footer status, and a final "Run log" in the tool result.
// ---------------------------------------------------------------------------

/** Current activity of one agy agent, derived from its stream events. */
export interface LiveActivity {
	/** Last step index reported by the agent (0-based from agy). */
	step: number;
	/** What the agent is doing right now. */
	phase: "thinking" | "tool" | "writing" | "done";
	/** Tool name of the active tool step, while in a tool phase. */
	tool?: string;
	/** File the active tool is writing/editing, if any. */
	file?: string;
	/** Command the active tool is running, if any. */
	command?: string;
	/** Number of tool steps completed so far. */
	stepsDone: number;
	/** Unique files touched so far. */
	filesTouched: string[];
	/** Milliseconds since the run started. */
	elapsedMs: number;
}

/** One completed (or active) tool step for the run log. */
export interface StepRecord {
	index: number;
	tool: string;
	file?: string;
	command?: string;
	state: "active" | "done";
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** Show a file path relative to the workspace when possible (cleaner status lines). */
function toDisplayPath(fp: string, ws: string): string {
	const sep = process.platform === "win32" ? "\\" : "/";
	const base = ws.endsWith(sep) ? ws : ws + sep;
	const lower = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
	return lower(fp).startsWith(lower(base)) ? fp.slice(base.length) : fp;
}

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return s ? `${m}m ${s}s` : `${m}m`;
}

/** Compact one-line status for an activity, e.g. `> step 4 · ✎ src/main.ts · 42s`. */
export function activityLine(l: LiveActivity): string {
	const elapsed = l.elapsedMs >= 1000 ? ` · ${formatDuration(l.elapsedMs)}` : "";
	if (l.phase === "done") {
		const n = l.filesTouched.length;
		return `✓ done${n ? ` · ${n} file${n === 1 ? "" : "s"} touched` : ""}${elapsed}`;
	}
	if (l.phase === "tool") {
		if (l.command) return `> step ${l.step} · $ ${l.command}${elapsed}`;
		if (l.file) return `> step ${l.step} · ✎ ${l.file}${elapsed}`;
		const tool = l.tool && l.tool !== "run_command" ? l.tool.replace(/_/g, " ") : "working";
		return `> step ${l.step} · ${tool}${elapsed}`;
	}
	return `… step ${l.step} · ${l.phase === "writing" ? "writing response" : "thinking"}${elapsed}`;
}

/** Terminal log of every completed tool step, newest last. Capped at `max` lines. */
export function buildRunLog(steps: StepRecord[], max = 40): string[] {
	const out: string[] = [];
	for (const s of steps) {
		if (s.state !== "done") continue;
		if (out.length >= max) {
			out.push(`  · … +${steps.length - out.length} more steps`);
			break;
		}
		const what = s.command ? `$ ${s.command}` : s.file ? `✎ ${s.file}` : s.tool ?? "tool";
		out.push(`  ✓ step ${s.index} · ${truncate(what, 140)}`);
	}
	return out;
}

function liveDetail(l: LiveActivity): Record<string, unknown> {
	return {
		step: l.step,
		phase: l.phase,
		tool: l.tool,
		file: l.file,
		command: l.command,
		stepsDone: l.stepsDone,
		filesTouched: [...l.filesTouched],
		elapsedMs: l.elapsedMs,
	};
}

/** Debounce helper for streaming updates: schedule() batches, flush() forces, cancel() stops. */
function debounce(fn: () => void, ms: number) {
	let timer: NodeJS.Timeout | null = null;
	return {
		schedule() {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				fn();
			}, ms);
		},
		flush() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			fn();
		},
		cancel() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Fleet (fan-out) types
// ---------------------------------------------------------------------------

/** One lane of an agy_fleet run. */
export interface FleetLaneState {
	id: string;
	task: string;
	workspace: string;
	status: "queued" | "running" | "done" | "failed" | "aborted";
	startedAt?: number;
	endedAt?: number;
	live: LiveActivity;
	result?: StreamResult;
	error?: string;
}

export interface FleetSummary {
	total: number;
	running: number;
	done: number;
	failed: number;
	aborted: number;
	elapsedMs: number;
}

export function summarizeFleet(lanes: FleetLaneState[], now = Date.now()): FleetSummary {
	const total = lanes.length;
	const running = lanes.filter((l) => l.status === "running" || l.status === "queued").length;
	const done = lanes.filter((l) => l.status === "done").length;
	const failed = lanes.filter((l) => l.status === "failed").length;
	const aborted = lanes.filter((l) => l.status === "aborted").length;
	const starts = lanes.map((l) => l.startedAt ?? now);
	const ends = lanes.map((l) => l.endedAt ?? now);
	const elapsedMs = total ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0;
	return { total, running, done, failed, aborted, elapsedMs };
}

function laneLine(lane: FleetLaneState, now: number): string {
	const id = lane.id || "?";
	const dur = (lane.endedAt ?? now) - (lane.startedAt ?? now);
	switch (lane.status) {
		case "queued":
			return `○ [${id}] waiting`;
		case "running": {
			const l = { ...lane.live, elapsedMs: dur };
			return `● [${id}] ${activityLine(l)}`;
		}
		case "done": {
			const bits = [`✓ [${id}] done`];
			const f = lane.result?.files_written?.length ?? 0;
			const c = lane.result?.commands_run?.length ?? 0;
			if (f) bits.push(`${f} file${f === 1 ? "" : "s"}`);
			if (c) bits.push(`${c} command${c === 1 ? "" : "s"}`);
			if (dur >= 1000) bits.push(formatDuration(dur));
			return bits.join(" · ");
		}
		case "aborted":
			return `✗ [${id}] aborted`;
		default: {
			const err = lane.error ? ` · ${truncate(lane.error, 60)}` : "";
			return `✗ [${id}] failed${err}${dur >= 1000 ? ` · ${formatDuration(dur)}` : ""}`;
		}
	}
}

/** Live board lines (one per lane) shown in the conversation while a fleet runs. */
export function formatFleetBoard(lanes: FleetLaneState[], now = Date.now()): string[] {
	if (!lanes.length) return [];
	const s = summarizeFleet(lanes, now);
	const head =
		`agy_fleet · ${s.total} lanes · ${s.running} active · ${s.done} done · ` +
		`${s.failed + s.aborted} failed · ${formatDuration(s.elapsedMs)}`;
	return [head, ...lanes.map((l) => `  ${laneLine(l, now)}`)];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RunOptions {
	prompt: string;
	workspace: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands: boolean;
	continueConv: boolean;
	conversation?: string;
	jsonSchema?: string;
	timeout: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	/** Per-event activity callback (used by agy_fleet to keep lane state fresh). */
	onActivity?: (live: LiveActivity) => void;
}

interface StreamResult {
	status: string;
	conversation_id: string;
	response: string;
	error?: string;
	usage?: Record<string, number>;
	duration_seconds?: number;
	num_turns?: number;
	denied_actions?: Array<{ action: string; display_name?: string }>;
	warnings?: string[];
	tool_steps?: number;
	files_written?: string[];
	commands_run?: string[];
	steps?: StepRecord[];
}

function parseResult(raw: Record<string, unknown> | undefined): StreamResult | null {
	if (!raw || typeof raw !== "object") return null;
	const r: StreamResult = {
		status: String(raw.status ?? ""),
		conversation_id: String(raw.conversation_id ?? ""),
		response: String(raw.response ?? ""),
		error: raw.error ? String(raw.error) : undefined,
		usage: (raw.usage as Record<string, number>) || undefined,
		duration_seconds: typeof raw.duration_seconds === "number" ? raw.duration_seconds : undefined,
		num_turns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
		denied_actions: Array.isArray(raw.denied_actions) ? (raw.denied_actions as StreamResult["denied_actions"]) : undefined,
	};
	return r;
}

// Tool names whose parameters contain the path of a file the agent wrote.
const WRITE_TOOLS = new Set([
	"write_to_file",
	"replace_file_content",
	"multi_replace_file_content",
	"sed_file",
	"edit_file",
	"notebook_edit",
]);

function extractFilePath(parameters: unknown): string | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	const p = parameters as Record<string, unknown>;
	for (const key of ["TargetFile", "FilePath", "Path"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	for (const v of Object.values(p)) {
		if (typeof v === "string" && v.length > 4 && /[\\/]/.test(v)) return v;
	}
	return undefined;
}

function extractCommand(parameters: unknown): string | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	const p = parameters as Record<string, unknown>;
	for (const key of ["CommandLine", "Command", "Cmd"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

/** Upper bound for the live-streamed agent text; the final result keeps the full response. */
const STREAM_TEXT_CAP = 4000;

function runAgy(opts: RunOptions): Promise<StreamResult> {
	return new Promise((resolvePromise, reject) => {
		const args = ["-p", opts.prompt, "--output-format", "stream-json"];

		// Register the workspace directory so agy treats it as the active
		// workspace (otherwise file writes fall back to the scratch dir).
		args.push("--add-dir", opts.workspace);

		const effort = opts.effort || config.effort;
		let model = opts.model || config.model;
		if (effort) model = matchEffort(model, effort);
		if (model) args.push("--model", model);
		if (effort && isGemini(model)) args.push("--effort", effort);
		const agent = opts.agent || config.agent;
		if (agent) args.push("--agent", agent);
		if (opts.jsonSchema) args.push("--json-schema", opts.jsonSchema);
		args.push("--print-timeout", opts.timeout);

		// Conversation continuity.
		if (opts.conversation) {
			args.push("--conversation", opts.conversation);
		} else if (opts.continueConv) {
			const prior = lastConversation.get(opts.workspace);
			if (prior) args.push("--conversation", prior);
			else args.push("--continue");
		}

		// File reads/writes inside the workspace are auto-allowed by agy.
		// Command execution needs explicit approval; gate it behind the flag.
		if (opts.allowCommands) args.push("--dangerously-skip-permissions");

		const child = spawn(config.bin, args, {
			cwd: opts.workspace,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let result: StreamResult | null = null;
		let stepText = "";
		const warnings: string[] = [];
		const files = new Set<string>();
		const commands = new Set<string>();
		const steps: StepRecord[] = [];
		const stepByIndex = new Map<number, StepRecord>();
		const startedAt = Date.now();
		const live: LiveActivity = { step: 0, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 0 };

		const refreshLive = () => {
			live.stepsDone = steps.length;
			live.filesTouched = [...files];
			live.elapsedMs = Date.now() - startedAt;
			opts.onActivity?.(live);
		};

		const pushStream = (overrides?: Partial<LiveActivity>) => {
			if (!opts.onUpdate) return;
			if (overrides) Object.assign(live, overrides);
			refreshLive();
			const line = activityLine(live);
			const body =
				stepText.length > STREAM_TEXT_CAP ? stepText.slice(-STREAM_TEXT_CAP) + " …" : stepText;
			opts.onUpdate({
				content: [{ type: "text", text: body ? `${line}\n\n${body}` : line }],
				details: { streaming: true, status: live.phase, ...liveDetail(live) },
			});
		};
		const streamPush = debounce(() => pushStream(), 120);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			// stdout is NDJSON; process complete lines.
			let nl: number;
			while ((nl = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, nl).trim();
				stdout = stdout.slice(nl + 1);
				if (!line) continue;
				let ev: { event?: string; [k: string]: unknown };
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (ev.event === "step_update") {
					const s = ev.step_update as any;
					if (s?.step_type === "tool") {
						const info = s.tool_info as any;
						const tool = typeof info?.name === "string" ? info.name : undefined;
						const params = info?.parameters as Record<string, unknown> | undefined;
						const file = tool && params !== undefined ? extractFilePath(params) : undefined;
						const command = tool === "run_command" && params !== undefined ? extractCommand(params) : undefined;
						live.tool = tool;
						live.file = file ? toDisplayPath(file, opts.workspace) : undefined;
						live.command = command;
						live.phase = "tool";
						const index = typeof s.step_index === "number" ? s.step_index : live.step;
						live.step = index;
						if (s.state === "ACTIVE") {
							// Show the live action immediately (e.g. `✎ src/main.ts`).
							streamPush.flush();
						} else {
							// Tool finished: record it once per step index.
							let rec = stepByIndex.get(index);
							if (!rec) {
								rec = { index, tool: tool ?? "tool", file: live.file, command: live.command, state: "done" };
								stepByIndex.set(index, rec);
								steps.push(rec);
							} else {
								rec.state = "done";
								if (live.file) rec.file = live.file;
								if (live.command) rec.command = live.command;
							}
							if (tool === "run_command" && command) commands.add(command);
							if (file) files.add(file);
							streamPush.flush();
						}
					} else if (s?.step_type === "agent_response") {
						if (typeof s.step_index === "number") live.step = s.step_index;
						if (typeof s.text_delta === "string" && s.text_delta) {
							stepText += s.text_delta;
							live.phase = "writing";
						} else {
							live.phase = "thinking";
						}
						streamPush.schedule();
					} else if (s?.step_type && typeof s.step_index === "number") {
						live.step = s.step_index;
						streamPush.schedule();
					}
				} else if (ev.event === "result") {
					result = parseResult(ev.result as Record<string, unknown>);
					if (result?.conversation_id) {
						lastConversation.set(opts.workspace, result.conversation_id);
					}
				}
			}
		});

		child.stderr.on("data", (d: string) => {
			stderr += d;
		});

		const onAbort = () => child.kill();
		const sig =
			opts.signal && typeof (opts.signal as AbortSignal).addEventListener === "function"
				? (opts.signal as AbortSignal)
				: undefined;
		sig?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			sig?.removeEventListener("abort", onAbort);
			streamPush.cancel();
			const exists = existsSync(opts.workspace);
			reject(
				new Error(
					`Failed to launch agy (${config.bin}) in ${opts.workspace}: ${err.message}` +
						(exists ? "" : " (workspace directory does not exist)")
				)
			);
		});

		child.on("close", (code) => {
			sig?.removeEventListener("abort", onAbort);
			streamPush.cancel();
			if (sig?.aborted) {
				reject(new Error("agy run aborted"));
				return;
			}
			const r = result ?? {
				status: code === 0 ? "SUCCESS" : "ERROR",
				conversation_id: "",
				response: stepText,
				error: stderr.trim() || undefined,
			};

			// Detect the headless-mode trap: agy can finish SUCCESS with no
			// output because a tool call was auto-denied.
			if (r.status === "SUCCESS" && !r.response?.trim()) {
				const denied = r.denied_actions?.map((d) => d.action).join(", ");
				if (denied || /denied|permission/i.test(stderr)) {
					warnings.push(
						`the agy agent produced no output because its tool calls were auto-denied in ` +
							`headless mode${denied ? ` (denied: ${denied})` : ""}. ` +
							`Retry with allowCommands=true or add allow rules under ` +
							`permissions.allow in ~/.gemini/antigravity-cli/settings.json.`
					);
				} else if (stderr.trim()) {
					warnings.push(stderr.trim());
				}
			}
			r.warnings = warnings.length ? warnings : undefined;
			r.tool_steps = steps.length;
			r.steps = steps;
			r.files_written = files.size ? [...files].sort() : undefined;
			r.commands_run = commands.size
				? [...commands].map((c) => (c.length > 160 ? c.slice(0, 157) + "..." : c))
				: undefined;

			if (r.status !== "SUCCESS") {
				const msg = r.error?.trim() || stderr.trim() || `agy exited with code ${code}`;
				reject(new Error(`agy ${r.status}: ${msg}`));
				return;
			}
			resolvePromise(r);
		});
	});
}

function buildResult(
	r: StreamResult,
	opts: { workspace: string; model: string; allowCommands: boolean; steps?: StepRecord[] }
): { content: AgentToolResult<unknown>["content"]; details: Record<string, unknown> } {
	const meta: string[] = [];
	if (r.conversation_id) meta.push(`conversation_id=${r.conversation_id}`);
	if (r.num_turns !== undefined) meta.push(`turns=${r.num_turns}`);
	if (r.duration_seconds !== undefined) meta.push(`duration=${r.duration_seconds.toFixed(1)}s`);
	if (r.usage?.total_tokens !== undefined) meta.push(`tokens=${r.usage.total_tokens}`);

	let text = r.response?.trim() || "(the agy agent returned no text)";
	if (r.warnings?.length) {
		text += `\n\n⚠️ ${r.warnings.join(" ")}`;
	}

	// Run log: the terminal trail of every tool step the agent performed.
	const steps = opts.steps ?? [];
	const log = buildRunLog(steps);
	if (log.length) text += `\n\nRun log (${steps.length} steps):\n${log.join("\n")}`;

	// Evidence the orchestrator can verify against.
	const evidence: string[] = [];
	if (r.files_written?.length) evidence.push(`files: ${r.files_written.join(", ")}`);
	if (r.commands_run?.length) evidence.push(`commands: ${r.commands_run.join(" | ")}`);
	if (evidence.length) text += `\n\nEvidence — ${evidence.join("   ")}`;

	return {
		content: [
			{
				type: "text",
				text: text + (meta.length ? `\n\n(${meta.join("  ")})` : ""),
			},
		],
		details: {
			response: r.response,
			status: r.status,
			conversation_id: r.conversation_id,
			usage: r.usage,
			duration_seconds: r.duration_seconds,
			num_turns: r.num_turns,
			denied_actions: r.denied_actions,
			warnings: r.warnings,
			files_written: r.files_written,
			commands_run: r.commands_run,
			workspace: opts.workspace,
			toolSteps: r.tool_steps ?? 0,
			model: opts.model,
			allowCommands: opts.allowCommands,
			steps,
		},
	};
}

// Shared execute used by all three single-run tools.
async function executeAgy(
	_toolCallId: string,
	params: {
		prompt: string;
		workspace?: string;
		model?: string;
		effort?: "low" | "medium" | "high";
		agent?: string;
		allowCommands?: boolean;
		continueConv?: boolean;
		conversation?: string;
		jsonSchema?: string;
		timeout?: string;
	},
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext
): Promise<AgentToolResult<Record<string, unknown>>> {
	const workspace = params.workspace ? resolveWorkspace(params.workspace, ctx.cwd) : ctx.cwd;
	const model = params.model || config.model;
	const allowCommands = params.allowCommands ?? config.defaultAllowCommands;
	if (ctx.hasUI) ctx.ui.setStatus("agy", `agy ⟳ ${truncate(params.prompt, 50)}…`);
	try {
		const r = await runAgy({
			prompt: params.prompt,
			workspace,
			model,
			effort: params.effort,
			agent: params.agent,
			allowCommands,
			continueConv: params.continueConv ?? false,
			conversation: params.conversation,
			jsonSchema: params.jsonSchema,
			timeout: params.timeout || config.timeout,
			signal,
			onUpdate,
		});
		// Final one-shot status before the footer clears.
		if (ctx.hasUI)
			ctx.ui.setStatus("agy", `agy ✓ done in ${formatDuration(r.duration_seconds ? r.duration_seconds * 1000 : 0)}`);
		return buildResult(r, { workspace, model, allowCommands, steps: r.steps ?? [] });
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("agy", undefined);
	}
}

// ---------------------------------------------------------------------------
// Fleet (fan-out) executor
// ---------------------------------------------------------------------------

interface FleetTaskParams {
	id?: string;
	task: string;
	workspace?: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands?: boolean;
	continueConv?: boolean;
	jsonSchema?: string;
	timeout?: string;
}

interface FleetCallParams extends FleetTaskParams {
	tasks: FleetTaskParams[];
	concurrency?: number;
}

async function executeFleet(
	_toolCallId: string,
	params: FleetCallParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext
): Promise<AgentToolResult<Record<string, unknown>>> {
	const tasks = Array.isArray(params.tasks) ? params.tasks : [];
	if (tasks.length === 0) throw new Error("agy_fleet: provide at least one task in `tasks`");
	if (tasks.length > MAX_FLEET_TASKS)
		throw new Error(`agy_fleet: too many tasks (${tasks.length}); max is ${MAX_FLEET_TASKS}`);
	const concurrency = clampConcurrency(params.concurrency ?? config.fleetConcurrency);

	const lanes: FleetLaneState[] = tasks.map((t, i) => ({
		id: t.id?.trim() || `t${i + 1}`,
		task: t.task,
		workspace: t.workspace ? resolveWorkspace(t.workspace, ctx.cwd) : ctx.cwd,
		status: "queued",
		live: { step: 0, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 0 },
	}));

	const boardPush = debounce(() => {
		if (!onUpdate) return;
		const board = formatFleetBoard(lanes, Date.now());
		onUpdate({
			content: [{ type: "text", text: board.join("\n") }],
			details: {
				streaming: true,
				status: "running",
				lanes: lanes.map((l) => ({
					id: l.id,
					status: l.status,
					activity: liveDetail(l.live),
					error: l.error,
				})),
			},
		});
		if (ctx.hasUI) {
			const active = lanes.filter((l) => l.status === "running" || l.status === "queued").length;
			const done = lanes.filter((l) => l.status === "done").length;
			const bad = lanes.length - active - done;
			ctx.ui.setStatus(
				"agy",
				`agy_fleet ${done}/${lanes.length} done${bad ? ` · ${bad} failed` : ""}${active ? ` · ${active} active` : ""}`
			);
		}
	}, 250);

	const runLane = async (lane: FleetLaneState, t: FleetTaskParams) => {
		lane.status = "running";
		lane.startedAt = Date.now();
		boardPush.schedule();
		try {
			const r = await runAgy({
				prompt: lane.task,
				workspace: lane.workspace,
				model: t.model || params.model,
				effort: t.effort || params.effort,
				agent: t.agent || params.agent,
				allowCommands: t.allowCommands ?? params.allowCommands ?? config.defaultAllowCommands,
				continueConv: t.continueConv ?? false,
				jsonSchema: t.jsonSchema,
				timeout: t.timeout || params.timeout || config.timeout,
				signal,
				onActivity: (live) => {
					lane.live = live;
					boardPush.schedule();
				},
			});
			lane.result = r;
			lane.status = "done";
		} catch (e) {
			lane.status = signal?.aborted ? "aborted" : "failed";
			lane.error = (e as Error).message;
		}
		lane.endedAt = Date.now();
		boardPush.flush();
	};

	const jobs = lanes.map((l, i) => ({ lane: l, task: tasks[i]! }));
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
		while (next < jobs.length) {
			if (signal?.aborted) break;
			const job = jobs[next++]!;
			await runLane(job.lane, job.task);
		}
	});
	await Promise.allSettled(workers);
	boardPush.cancel();
	if (signal?.aborted) throw new Error("agy_fleet aborted");

	const summary = summarizeFleet(lanes);
	const now = Date.now();
	const lines: string[] = [
		`**agy_fleet — ${summary.done}/${summary.total} lanes succeeded** ` +
			`(${summary.total} lanes · ${formatDuration(summary.elapsedMs)} · concurrency ${concurrency})`,
		"",
	];
	for (const lane of lanes) {
		const dur = formatDuration((lane.endedAt ?? now) - (lane.startedAt ?? now));
		if (lane.status === "done" && lane.result) {
			const bits = [
				`${lane.result.files_written?.length ?? 0} files`,
				`${lane.result.commands_run?.length ?? 0} commands`,
				dur,
			];
			lines.push(`- **[${lane.id}]** ✓ done · ${bits.join(" · ")}`);
			const resp = truncate((lane.result.response ?? "(no response)").trim(), 600);
			lines.push(`  ${resp.replace(/\s*\n+\s*/g, " ")}`);
		} else {
			const why =
				lane.status === "aborted"
					? "aborted"
					: lane.error
						? truncate(lane.error, 120)
						: "failed";
			lines.push(`- **[${lane.id}]** ✗ ${lane.status} · ${why} · ${dur}`);
			lines.push(`  task: ${truncate(lane.task.replace(/\s+/g, " "), 160)}`);
		}
	}
	const withEvidence = lanes.filter(
		(l) => l.status === "done" && l.result && (l.result.files_written?.length || l.result.commands_run?.length)
	);
	if (withEvidence.length) {
		lines.push("", "Evidence —");
		for (const lane of withEvidence) {
			const parts: string[] = [];
			if (lane.result?.files_written?.length) parts.push(`files: ${lane.result.files_written.join(", ")}`);
			if (lane.result?.commands_run?.length) parts.push(`commands: ${lane.result.commands_run.join(" | ")}`);
			lines.push(`  [${lane.id}] ${parts.join("   ")}`);
		}
	}
	lines.push(
		"",
		`(${summary.total} lanes · ok=${summary.done} failed=${summary.failed} aborted=${summary.aborted} · ${formatDuration(summary.elapsedMs)})`
	);

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			status: "done",
			lanes: lanes.map((l) => ({
				id: l.id,
				task: l.task,
				workspace: l.workspace,
				status: l.status,
				error: l.error,
				response: l.result?.response,
				files_written: l.result?.files_written,
				commands_run: l.result?.commands_run,
				conversation_id: l.result?.conversation_id,
				num_turns: l.result?.num_turns,
				duration_seconds: l.result?.duration_seconds,
				usage: l.result?.usage,
			})),
			succeeded: summary.done,
			failed: summary.failed,
			aborted: summary.aborted,
			total: lanes.length,
			concurrency,
			duration_seconds: +(summary.elapsedMs / 1000).toFixed(1),
		},
	};
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// The general-purpose worker: delegate a low-level task to the agy/Gemini agent.
const agyRun = defineTool({
	name: "agy",
	label: "Agy (Antigravity)",
	description:
		"Delegate a low-level task to the Antigravity (agy) CLI agent running a Gemini model. " +
		"Use for focused work the main agent can hand off: writing/editing a file, exploring or " +
		"summarizing part of a codebase, running a quick research pass, drafting code, or " +
		"performing a multi-step task in a dedicated workspace. " +
		"The agy agent runs with its own tool loop. File reads/writes inside the workspace are " +
		"auto-allowed; shell commands are enabled only when allowCommands is true (default comes " +
		"from pi-agy config). If the agent returns no text, it usually means a tool call was " +
		"auto-denied — retry with allowCommands=true. " +
		"While it runs, live status shows the current step, the file being written/edited, and " +
		"commands being run; the result includes a full run log plus evidence (files, commands). " +
		"Set continueConv true or pass conversation to keep the same agent conversation going.",
	parameters: Type.Object({
		prompt: Type.String({
			description: "The task/instruction to give the agy agent. Be specific and self-contained.",
		}),
		workspace: Type.Optional(
			Type.String({
				description:
					"Directory to run in (defaults to the current working directory). Accepts Windows or Git-Bash paths (/tmp/foo, ~/dev). The agent may only read/write inside this workspace unless its own settings allow more.",
			})
		),
		model: Type.Optional(
			Type.String({
				description: `Model slug, e.g. gemini-3.8-flash-high (default: ${config.model}). Run 'agy models' to list.`,
			})
		),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		agent: Type.Optional(
			Type.String({
				description: "agy agent to use (run 'agy agents' to list).",
			})
		),
		allowCommands: Type.Optional(
			Type.Boolean({
				description:
					"Allow the agy agent to run shell commands (passes --dangerously-skip-permissions). " +
					`Default: ${config.defaultAllowCommands}. Enable when the task requires running tests, builds, git, etc.`,
			})
		),
		continueConv: Type.Optional(
			Type.Boolean({
				description:
					"Continue the most recent agy conversation for this workspace, preserving context from earlier calls.",
			})
		),
		conversation: Type.Optional(
			Type.String({
				description: "Resume a specific agy conversation by its conversation_id (overrides continueConv).",
			})
		),
		jsonSchema: Type.Optional(
			Type.String({
				description: "JSON schema (string) to constrain the agent's final structured output.",
			})
		),
		timeout: Type.Optional(
			Type.String({
				description: `Max wait for a response, e.g. "10m" (default: ${config.timeout}).`,
			})
		),
	}),
	execute: executeAgy,
});

// Read-only exploration preset: never passes --dangerously-skip-permissions and
// steers the agent toward agy's native read-only tools instead of shell commands.
const EXPLORE_GUIDE =
	"IMPORTANT: shell commands (run_command) are DENIED in this environment. " +
	"Use only these built-in read-only tools: list_dir, view_file, grep_search, read_resource. " +
	"Never attempt run_command — it will be auto-denied and the task will fail.";

const agyExplore = defineTool({
	name: "agy_explore",
	label: "Agy Explore",
	description:
		"Delegate a read-only exploration task to the Antigravity (agy) agent (Gemini). " +
		"Use to map, explain, or investigate a codebase, a directory, or a chunk of code without " +
		"modifying anything. Shell commands are never enabled for this tool; file reads inside " +
		"the workspace are allowed. Live status shows the step and file it is inspecting; the " +
		"result includes a run log. Returns the agent's findings.",
	parameters: Type.Object({
		prompt: Type.String({
			description:
				"The exploration question/instruction, e.g. 'Map the modules in src/ and explain how they connect'.",
		}),
		workspace: Type.Optional(Type.String({ description: "Directory to explore (defaults to cwd)." })),
		model: Type.Optional(Type.String({ description: `Model slug (default: ${config.model}).` })),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		timeout: Type.Optional(Type.String({ description: `Max wait (default: ${config.timeout}).` })),
	}),
	execute: (id, params, signal, onUpdate, ctx) =>
		executeAgy(
			id,
			{ ...params, prompt: `${params.prompt}\n\n${EXPLORE_GUIDE}`, allowCommands: false },
			signal,
			onUpdate,
			ctx
		),
});

// Code-writing preset: implementation tasks in a workspace.
const agyCode = defineTool({
	name: "agy_code",
	label: "Agy Code",
	description:
		"Delegate a code-writing/implementation task to the Antigravity (agy) agent (Gemini). " +
		"Use for writing or editing files, implementing a feature, or generating code in the workspace. " +
		"File reads/writes in the workspace are allowed. Shell commands are enabled by default " +
		`(allowCommands defaults to ${config.defaultAllowCommands}; set false for pure file tasks). ` +
		"Live status shows the step and file the agent is writing/editing in real time; the " +
		"result includes a run log plus evidence. If the agent returns no text it was probably " +
		"denied permission — retry with allowCommands=true.",
	parameters: Type.Object({
		prompt: Type.String({
			description:
				"The implementation task. Be concrete: what to create/modify, file names, and expected behavior.",
		}),
		workspace: Type.Optional(Type.String({ description: "Directory to work in (defaults to cwd)." })),
		model: Type.Optional(Type.String({ description: `Model slug (default: ${config.model}).` })),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		allowCommands: Type.Optional(
			Type.Boolean({
				description:
					"Allow the agent to run shell commands (e.g. to run tests). " +
					`Default: ${config.defaultAllowCommands}.`,
			})
		),
		continueConv: Type.Optional(
			Type.Boolean({ description: "Continue the previous agy conversation for this workspace." })
		),
		timeout: Type.Optional(Type.String({ description: `Max wait (default: ${config.timeout}).` })),
	}),
	execute: (id, params, signal, onUpdate, ctx) =>
		executeAgy(
			id,
			{ ...params, allowCommands: params.allowCommands ?? config.defaultAllowCommands },
			signal,
			onUpdate,
			ctx
		),
});

const fleetTaskSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Lane id shown in status/results (default: t1, t2, …)." })),
	task: Type.String({ description: "The prompt/instruction for this agy lane." }),
	workspace: Type.Optional(
		Type.String({ description: "Directory to run this lane in (defaults to cwd)." })
	),
	model: Type.Optional(Type.String({ description: `Model slug (default: ${config.model}).` })),
	effort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	agent: Type.Optional(Type.String({ description: "agy agent to use for this lane." })),
	allowCommands: Type.Optional(
		Type.Boolean({ description: `Allow shell commands for this lane (default: ${config.defaultAllowCommands}).` })
	),
	continueConv: Type.Optional(
		Type.Boolean({ description: "Continue the most recent conversation in this lane's workspace." })
	),
	jsonSchema: Type.Optional(Type.String({ description: "JSON schema string to constrain this lane's output." })),
	timeout: Type.Optional(Type.String({ description: `Max wait for this lane (default: ${config.timeout}).` })),
});

// Fan-out preset: run several agy agents in parallel with a live per-lane board.
const agyFleet = defineTool({
	name: "agy_fleet",
	label: "Agy Fleet (fan-out)",
	description:
		"Fan out multiple Antigravity (agy) agents on a list of tasks and run them in parallel " +
		"with bounded concurrency. Each lane is its own agy agent with its own tool loop and " +
		"workspace. A live board in the conversation shows every lane: current step, the file " +
		"being written/edited, the command running, and done/failed state — then the final " +
		"result reports per-lane status, response, files, and commands so the orchestrator can " +
		"verify each lane. Use to parallelize independent subtasks (edit several modules, run " +
		"separate research passes, scaffold multiple components). All lanes sharing one " +
		"workspace write to the same directory — prefer distinct workspaces (or distinct files) " +
		"to avoid conflicting edits.",
	parameters: Type.Object({
		tasks: Type.Array(fleetTaskSchema, {
			description: "One entry per agy lane (2–24). Each needs a self-contained `task` prompt.",
		}),
		concurrency: Type.Optional(
			Type.Integer({
				description: `Max parallel agy agents (default: ${config.fleetConcurrency}, range 1–${MAX_FLEET_CONCURRENCY}).`,
			})
		),
		model: Type.Optional(Type.String({ description: `Default model for all lanes (default: ${config.model}).` })),
		effort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
		agent: Type.Optional(Type.String({ description: "Default agy agent for all lanes." })),
		allowCommands: Type.Optional(
			Type.Boolean({ description: `Default allowCommands for all lanes (default: ${config.defaultAllowCommands}).` })
		),
		timeout: Type.Optional(Type.String({ description: `Default max wait per lane (default: ${config.timeout}).` })),
	}),
	execute: executeFleet,
});

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