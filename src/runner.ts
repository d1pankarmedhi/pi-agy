import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { isGemini, matchEffort } from "./model.ts";
import {
	activityLine,
	debounce,
	idleActivity,
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
	continueConv: boolean;
	conversation?: string;
	jsonSchema?: string;
	timeout: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	/** Per-event activity callback (used by agy_fleet to keep lane state fresh). */
	onActivity?: (live: LiveActivity) => void;
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

// Last conversation id per workspace, so `continue` can resume real context.
const lastConversation = new Map<string, string>();

export function runAgy(opts: RunOptions): Promise<StreamResult> {
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
		const live: LiveActivity = idleActivity();

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