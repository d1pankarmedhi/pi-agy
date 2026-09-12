import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { isGemini, matchEffort } from "./model.ts";
import type { AgyMeta } from "./render.ts";
import {
	activityLine,
	debounce,
	idleActivity,
	isWriteTool,
	liveDetail,
	toDisplayPath,
	type LiveActivity,
	type StepRecord,
} from "./status.ts";

/**
 * Runs one agy agent (`agy -p <prompt> --output-format stream-json`) as a
 * child process and streams live status into pi while it works:
 *
 *   - `step_update` events with a tool step surface the current file being
 *     written/edited or the command being run as a compact status line;
 *   - `agent_response` text deltas stream the agent's writing;
 *   - completed tool steps are accumulated into `steps` (one record per step
 *     index — agy emits both an ACTIVE and a DONE event per step) and parsed
 *     into `files_written` / `commands_run` evidence.
 */

export interface RunOptions {
	prompt: string;
	workspace: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands: boolean;
	/** Extra directories to register as workspace roots (e.g. staged vision images). */
	addDirs?: readonly string[];
	continueConv: boolean;
	conversation?: string;
	jsonSchema?: string;
	timeout: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	/** Per-event activity callback (used by agy_fleet to keep lane state fresh). */
	onActivity?: (live: LiveActivity) => void;
	/** Static run metadata echoed into every streaming `details` payload. */
	meta?: AgyMeta;
	/** Injected child spawner for unit testing child process streaming. */
	spawnChild?: typeof spawn;
}

export interface StreamResult {
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

/**
 * Bounded tail of the agent's most recent output lines, newest last.
 * Derived from stepText by splitting on newlines and dropping blank lines.
 */
export function extractOutputTail(text: string, max = 8): string[] {
	if (!text) return [];
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.slice(-max);
}

/** How much of the growing live stream buffer is scanned for the output tail. */
const OUTPUT_TAIL_WINDOW = 4000;

/**
 * `extractOutputTail` over a bounded window of a buffer that grows for the
 * whole run. Slicing first stops a long run from re-splitting megabytes of text
 * on every event, and the first (possibly partial) line after a mid-buffer
 * slice is dropped rather than shown as a broken fragment.
 */
export function extractRecentTail(text: string, max = 8, window = OUTPUT_TAIL_WINDOW): string[] {
	if (!text) return [];
	if (text.length <= window) return extractOutputTail(text, max);
	const tail = text.slice(-window);
	const newline = tail.indexOf("\n");
	return extractOutputTail(newline >= 0 ? tail.slice(newline + 1) : tail, max);
}

function extractTokens(raw: unknown): number | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.tokens === "number") return r.tokens;
	if (typeof r.total_tokens === "number") return r.total_tokens;
	if (r.usage && typeof r.usage === "object") {
		const u = r.usage as Record<string, unknown>;
		if (typeof u.total_tokens === "number") return u.total_tokens;
		if (typeof u.tokens === "number") return u.tokens;
	}
	return undefined;
}

function extractTurns(raw: unknown): number | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.turns === "number") return r.turns;
	if (typeof r.num_turns === "number") return r.num_turns;
	return undefined;
}

/**
 * Split the files an agent claimed to write into ones that actually exist on
 * disk and ones that do not.
 *
 * agy reports a permission-DENIED `write_to_file` with step state `DONE` and an
 * overall `SUCCESS`, so step state alone cannot be trusted. The denial is only
 * visible as `denied_actions` on the final result — after the step events have
 * already been counted. Checking the filesystem is the only reliable way to
 * keep phantom paths out of `files_written` evidence.
 */
export function splitExistingFiles(
	files: Iterable<string>,
	workspace: string,
	exists: (path: string) => boolean = existsSync
): { existing: string[]; missing: string[] } {
	const existing: string[] = [];
	const missing: string[] = [];
	for (const file of files) {
		if (!file) continue;
		const absolute = isAbsolute(file) ? file : resolve(workspace, file);
		(exists(absolute) ? existing : missing).push(file);
	}
	return { existing: existing.sort(), missing: missing.sort() };
}

// Last conversation id per workspace, so `continue` can resume real context.
const lastConversation = new Map<string, string>();

/** Everything that shapes the agy command line (no I/O, so it is unit-testable). */
export interface AgyArgsInput {
	prompt: string;
	workspace: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands: boolean;
	jsonSchema?: string;
	timeout: string;
	/** Extra workspace roots (repeatable `--add-dir`), e.g. staged vision images. */
	addDirs?: readonly string[];
	/** Explicit conversation id to resume (wins over `continueConv`). */
	conversation?: string;
	continueConv?: boolean;
}

/** Build the agy CLI arguments for one run. */
export function buildAgyArgs(opts: AgyArgsInput): string[] {
	const args = ["-p", opts.prompt, "--output-format", "stream-json"];

	// Register the workspace directory so agy treats it as the active
	// workspace (otherwise file writes fall back to the scratch dir).
	args.push("--add-dir", opts.workspace);
	// Extra roots (repeatable flag) — used to expose staged image copies
	// that live outside the workspace so the agent can read them.
	const seenDirs = new Set([opts.workspace]);
	for (const dir of opts.addDirs ?? []) {
		if (dir && !seenDirs.has(dir)) {
			seenDirs.add(dir);
			args.push("--add-dir", dir);
		}
	}

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
	if (opts.conversation) args.push("--conversation", opts.conversation);
	else if (opts.continueConv) args.push("--continue");

	// Headless permission gate. Shell commands AND file writes are auto-denied
	// without this flag (a denied write_to_file still reports step DONE and an
	// overall SUCCESS, so it is only visible via `denied_actions`).
	if (opts.allowCommands) args.push("--dangerously-skip-permissions");

	return args;
}

export function runAgy(opts: RunOptions): Promise<StreamResult> {
	return new Promise((resolvePromise, reject) => {
		// Resolve conversation continuity against the last id seen in this workspace.
		const prior = opts.conversation ? undefined : lastConversation.get(opts.workspace);
		const args = buildAgyArgs({
			...opts,
			conversation: opts.conversation ?? (opts.continueConv ? prior : undefined),
		});

		const spawnFn = opts.spawnChild ?? spawn;
		const child = spawnFn(config.bin, args, {
			cwd: opts.workspace,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let result: StreamResult | null = null;
		let stepText = "";
		const warnings: string[] = [];
		const failedActions: string[] = [];
		const files = new Set<string>();
		const commands = new Set<string>();
		const steps: StepRecord[] = [];
		const stepByIndex = new Map<number, StepRecord>();
		const startedAt = Date.now();
		const live: LiveActivity = idleActivity();

		const refreshLive = () => {
			live.stepsDone = steps.length;
			live.filesTouched = [...files];
			live.elapsedMs = Date.now() - startedAt;
			const tail = extractRecentTail(stepText, 8);
			live.outputTail = tail.length ? tail : undefined;
			opts.onActivity?.(live);
		};

		const pushStream = (overrides?: Partial<LiveActivity>) => {
			live.lastActivityAt = Date.now();
			if (overrides) Object.assign(live, overrides);
			refreshLive();
			if (!opts.onUpdate) return;
			const line = activityLine(live);
			const body =
				stepText.length > STREAM_TEXT_CAP ? stepText.slice(-STREAM_TEXT_CAP) + " …" : stepText;
			opts.onUpdate({
				content: [{ type: "text", text: body ? `${line}\n\n${body}` : line }],
				details: {
					streaming: true,
					status: live.phase,
					recent: steps.slice(-6),
					preview: stepText.slice(-800),
					meta: opts.meta,
					commands_run: commands.size ? [...commands] : undefined,
					...liveDetail(live),
				},
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
					live.lastActivityAt = Date.now();
					const s = ev.step_update as any;
					const streamTokens = extractTokens(s) ?? extractTokens(ev);
					if (streamTokens !== undefined) live.tokens = streamTokens;
					const streamTurns = extractTurns(s) ?? extractTurns(ev);
					if (streamTurns !== undefined) live.turns = streamTurns;

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
							live.toolStartedAt = Date.now();
							// Show the live action immediately (e.g. `✎ src/main.ts`).
							streamPush.flush();
						} else {
							live.toolStartedAt = undefined;
							// agy reports a terminal state per step: DONE on success, ERROR on
							// failure, and a plain DONE even when the call was permission-denied
							// (the denial only surfaces in `denied_actions`). Evidence must be
							// recorded ONLY for a genuine DONE, otherwise a denied write lands in
							// `files_written` and the orchestrator verifies a file that was never
							// created.
							const succeeded = String(s.state ?? "").toUpperCase() === "DONE";
							let rec = stepByIndex.get(index);
							if (!rec) {
								rec = {
									index,
									tool: tool ?? "tool",
									file: live.file,
									command: live.command,
									state: succeeded ? "done" : "failed",
								};
								stepByIndex.set(index, rec);
								steps.push(rec);
							} else {
								// Never downgrade a step that already succeeded.
								if (!succeeded && rec.state !== "done") rec.state = "failed";
								if (live.file) rec.file = live.file;
								if (live.command) rec.command = live.command;
							}
							if (succeeded) {
								if (tool === "run_command" && command) commands.add(command);
								// Only mutating tools count as files *written*; exploration reads
								// still appear in the live activity + step trail.
								if (file && isWriteTool(tool)) files.add(file);
							} else {
								const what = command ? `$ ${command}` : file ? `${tool ?? "tool"} ${file}` : (tool ?? "tool");
								failedActions.push(`step ${index}: ${what}`);
							}
							streamPush.flush();
						}
					} else if (s?.step_type === "agent_response") {
						if (typeof s.step_index === "number") live.step = s.step_index;
						if (typeof s.text_delta === "string" && s.text_delta) {
							stepText += s.text_delta;
							const tail = extractRecentTail(stepText, 8);
							live.outputTail = tail.length ? tail : undefined;
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
					live.lastActivityAt = Date.now();
					result = parseResult(ev.result as Record<string, unknown>);
					if (result?.conversation_id) {
						lastConversation.set(opts.workspace, result.conversation_id);
					}
					const resTokens = extractTokens(ev.result) ?? extractTokens(result);
					if (resTokens !== undefined) live.tokens = resTokens;
					const resTurns = extractTurns(ev.result) ?? extractTurns(result);
					if (resTurns !== undefined) live.turns = resTurns;
					refreshLive();
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
			live.toolStartedAt = undefined;
			if (sig?.aborted) {
				refreshLive();
				reject(new Error("agy run aborted"));
				return;
			}
			const r = result ?? {
				status: code === 0 ? "SUCCESS" : "ERROR",
				conversation_id: "",
				response: stepText,
				error: stderr.trim() || undefined,
			};
			const resTokens = extractTokens(r);
			if (resTokens !== undefined && live.tokens === undefined) {
				live.tokens = resTokens;
			}
			const resTurns = extractTurns(r);
			if (resTurns !== undefined && live.turns === undefined) {
				live.turns = resTurns;
			}
			refreshLive();

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
			if (failedActions.length) {
				const shown = failedActions.slice(0, 5).join(", ");
				warnings.push(
					`${failedActions.length} tool step${failedActions.length === 1 ? "" : "s"} failed or ${failedActions.length === 1 ? "was" : "were"} denied ` +
						`(${shown}${failedActions.length > 5 ? ", …" : ""}); nothing from ${failedActions.length === 1 ? "it" : "them"} is reported as files/commands evidence.`
				);
			}
			// A denied action (even when the overall run says SUCCESS and the step
			// says DONE) means the agent did not do what the evidence implies.
			if (r.denied_actions?.length && r.response?.trim()) {
				warnings.push(
					`agy denied ${r.denied_actions.length} action(s): ${r.denied_actions.map((d) => d.action).join(", ")}. ` +
						`Those actions did not happen; retry with allowCommands=true if they were required.`
				);
			}
			r.tool_steps = steps.length;
			r.steps = steps;
			// Evidence must be verifiable: drop claimed writes that do not exist.
			const claimed = files.size ? splitExistingFiles(files, opts.workspace) : { existing: [], missing: [] };
			if (claimed.missing.length) {
				warnings.push(
					`${claimed.missing.length} file${claimed.missing.length === 1 ? "" : "s"} the agent reported writing do not exist on disk ` +
						`(likely denied or failed): ${claimed.missing.slice(0, 5).join(", ")}${claimed.missing.length > 5 ? ", …" : ""}. ` +
						`They are excluded from files_written.`
				);
			}
			r.warnings = warnings.length ? warnings : undefined;
			r.files_written = claimed.existing.length ? claimed.existing : undefined;
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