/**
 * Live status (subagent-style activity tracking).
 *
 * While an agy agent runs we know, from its stream-json events, the current
 * step index, which tool it is using, and the file/command that tool touches.
 * That becomes a compact status line streamed into the conversation card, a
 * footer status, and a final "Run log" in the tool result.
 */

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

export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** Show a file path relative to the workspace when possible (cleaner status lines). */
export function toDisplayPath(fp: string, ws: string): string {
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

/** Structured detail snapshot of an activity, for streaming `details` payloads. */
export function liveDetail(l: LiveActivity): Record<string, unknown> {
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