/**
 * Live status (subagent-style activity tracking).
 *
 * While an agy agent runs we know, from its stream-json events, the current
 * step index, which tool it is using, and the file/command that tool touches.
 * That becomes a compact status line streamed into the conversation card, a
 * footer status, and a final "Run log" in the tool result.
 */

export type ActivityState = "active" | "active_long_running" | "needs_attention";

export const ACTIVITY_LONG_RUNNING_MS = 45_000;
export const ACTIVITY_NEEDS_ATTENTION_MS = 120_000;

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
	/** Epoch ms of the most recent stream event (undefined before the first). */
	lastActivityAt?: number;
	/** Epoch ms when the current tool step became ACTIVE. */
	toolStartedAt?: number;
	/** Bounded tail of the agent's most recent output lines (newest last). */
	outputTail?: string[];
	/** Live token count when the stream reports usage. */
	tokens?: number;
	/** Live turn count when the stream reports it. */
	turns?: number;
}

/** One completed (or active) tool step for the run log. */
export interface StepRecord {
	index: number;
	tool: string;
	file?: string;
	command?: string;
	state: "active" | "done" | "failed";
}

export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** Show a file path relative to the workspace when possible (cleaner status lines). */
export function toDisplayPath(fp: string, ws: string): string {
	if (!ws) return fp;
	const win = process.platform === "win32";
	const norm = (s: string) => (win ? s.replace(/\//g, "\\").toLowerCase() : s);
	const nf = norm(fp);
	let nw = norm(ws);
	if (!nw.endsWith(win ? "\\" : "/")) nw += win ? "\\" : "/";
	if (!nf.startsWith(nw)) return fp;
	return fp.slice(ws.length + (ws.endsWith("/") || ws.endsWith("\\") ? 0 : 1));
}

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * True for agy tools that mutate the workspace. Used to keep read-only
 * exploration reads out of the `files_written` evidence list.
 */
export function isWriteTool(tool: string | undefined): boolean {
	return /(write|edit|create|apply|patch|replace|insert|append|delete|rename|move)/i.test(tool ?? "");
}

/** Compact one-line status for an activity, e.g. `> step 4 · ✎ src/main.ts · 42s`. */export function activityLine(l: LiveActivity): string {
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

/** Epoch ms since the last stream event; undefined when never observed. */
export function activityAgeMs(live: LiveActivity, now?: number): number | undefined {
	if (live.lastActivityAt === undefined) return undefined;
	return Math.max(0, (now ?? Date.now()) - live.lastActivityAt);
}

/**
 * Liveness bucket from `activityAgeMs`:
 *   undefined age            → "active"
 *   < ACTIVITY_LONG_RUNNING_MS        → "active"
 *   < ACTIVITY_NEEDS_ATTENTION_MS     → "active_long_running"
 *   otherwise                         → "needs_attention"
 */
export function activityState(live: LiveActivity, now?: number): ActivityState {
	const age = activityAgeMs(live, now);
	if (age === undefined || age < ACTIVITY_LONG_RUNNING_MS) {
		return "active";
	}
	if (age < ACTIVITY_NEEDS_ATTENTION_MS) {
		return "active_long_running";
	}
	return "needs_attention";
}

function livenessAgeText(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 1000) return "now";
	if (clamped < 60_000) return `${Math.floor(clamped / 1000)}s`;
	return `${Math.floor(clamped / 60_000)}m`;
}

/**
 * pi-subagents-compatible liveness label. `state` may be supplied when the
 * caller already derived it, otherwise it comes from `activityState`. Returns
 * `undefined` when there is no age and the state is plain "active" (nothing
 * useful to say yet).
 */
export function activityFreshnessText(
	live: LiveActivity,
	now?: number,
	state?: ActivityState
): string | undefined {
	const st = state ?? activityState(live, now);
	const age = activityAgeMs(live, now);
	if (age === undefined) {
		if (st === "needs_attention") return "needs attention";
		if (st === "active_long_running") return "active but long-running";
		return undefined;
	}
	const ageText = livenessAgeText(age);
	if (st === "needs_attention") {
		return `no activity for ${ageText}`;
	}
	if (st === "active_long_running") {
		return `active but long-running · last activity ${ageText} ago`;
	}
	return ageText === "now" ? "active now" : `active ${ageText} ago`;
}

/** Duration of the active tool step, or undefined. */
export function toolDurationMs(live: LiveActivity, now?: number): number | undefined {
	if (live.toolStartedAt === undefined) return undefined;
	return Math.max(0, (now ?? Date.now()) - live.toolStartedAt);
}

/** Terminal log of every completed tool step, newest last. Capped at `max` lines. */
export function buildRunLog(steps: StepRecord[], max = 40): string[] {
	const out: string[] = [];
	const terminal = steps.filter((s) => s.state !== "active");
	for (const s of terminal) {
		if (out.length >= max) {
			out.push(`  · … +${terminal.length - out.length} more steps`);
			break;
		}
		const what = s.command ? `$ ${s.command}` : s.file ? `✎ ${s.file}` : s.tool ?? "tool";
		out.push(`  ${s.state === "failed" ? "✗" : "✓"} step ${s.index} · ${truncate(what, 140)}`);
	}
	return out;
}

/** Structured detail snapshot of an activity, for streaming `details` payloads. */
export function liveDetail(l: LiveActivity): Record<string, unknown> {
	const out: Record<string, unknown> = {
		step: l.step,
		phase: l.phase,
		tool: l.tool,
		file: l.file,
		command: l.command,
		stepsDone: l.stepsDone,
		filesTouched: [...l.filesTouched],
		elapsedMs: l.elapsedMs,
	};
	if (l.lastActivityAt !== undefined) out.lastActivityAt = l.lastActivityAt;
	if (l.toolStartedAt !== undefined) out.toolStartedAt = l.toolStartedAt;
	if (l.outputTail !== undefined) out.outputTail = [...l.outputTail];
	if (l.tokens !== undefined) out.tokens = l.tokens;
	if (l.turns !== undefined) out.turns = l.turns;
	return out;
}

/** Debounce helper for streaming updates: schedule() batches, flush() forces, cancel() stops. */
export function debounce(fn: () => void, ms: number) {
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

/** A fresh, idle activity (used when seeding run/lane state). */
export function idleActivity(): LiveActivity {
	return { step: 0, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 0 };
}