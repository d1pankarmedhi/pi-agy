import { activityLine, formatDuration, truncate, type LiveActivity } from "./status.ts";
import type { StreamResult } from "./runner.ts";

/**
 * Fleet (fan-out) state and presentation. `agy_fleet` runs several agy agents
 * in parallel; each lane carries its own live activity and result, and the
 * board renders the same compact card shape pi-subagents uses.
 */

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