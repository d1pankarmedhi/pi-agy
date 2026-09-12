import { test } from "node:test";
import assert from "node:assert/strict";
import {
	activityLine,
	buildRunLog,
	clampConcurrency,
	formatDuration,
	formatFleetBoard,
	isWriteTool,
	summarizeFleet,
	toDisplayPath,
	type FleetLaneState,
	type LiveActivity,
	type StepRecord,
} from "../index.ts";
import {
	ACTIVITY_LONG_RUNNING_MS,
	ACTIVITY_NEEDS_ATTENTION_MS,
	activityAgeMs,
	activityFreshnessText,
	activityState,
	idleActivity,
	liveDetail,
	toolDurationMs,
	type ActivityState,
} from "../src/status.ts";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

test("formatDuration renders seconds, minutes, and zero", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(65_000), "1m 5s");
	assert.equal(formatDuration(3 * 60_000 + 12_000), "3m 12s");
	assert.equal(formatDuration(-5), "0s");
});

// ---------------------------------------------------------------------------
// activityLine
// ---------------------------------------------------------------------------

test("activityLine shows the file being edited on a tool step", () => {
	const l: LiveActivity = {
		step: 4,
		phase: "tool",
		tool: "write_to_file",
		file: "src/main.ts",
		stepsDone: 2,
		filesTouched: [],
		elapsedMs: 42_000,
	};
	assert.equal(activityLine(l), "> step 4 · ✎ src/main.ts · 42s");
});

test("activityLine shows the command being run", () => {
	const l: LiveActivity = {
		step: 5,
		phase: "tool",
		tool: "run_command",
		command: "npm test",
		stepsDone: 3,
		filesTouched: [],
		elapsedMs: 30_000,
	};
	assert.equal(activityLine(l), "> step 5 · $ npm test · 30s");
});

test("activityLine shows thinking/writing phases without elapsed under a second", () => {
	const think: LiveActivity = { step: 1, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 500 };
	assert.equal(activityLine(think), "… step 1 · thinking");
	const write: LiveActivity = { step: 2, phase: "writing", stepsDone: 0, filesTouched: [], elapsedMs: 900 };
	assert.equal(activityLine(write), "… step 2 · writing response");
});

test("activityLine summarizes the done phase with file count", () => {
	const done: LiveActivity = { step: 8, phase: "done", stepsDone: 8, filesTouched: ["a.ts", "b.ts"], elapsedMs: 100_000 };
	assert.equal(activityLine(done), "✓ done · 2 files touched · 1m 40s");
});

test("activityLine falls back to the tool name (underscores → spaces)", () => {
	const l: LiveActivity = { step: 3, phase: "tool", tool: "grep_search", stepsDone: 1, filesTouched: [], elapsedMs: 10_000 };
	assert.equal(activityLine(l), "> step 3 · grep search · 10s");
});

test("isWriteTool classifies mutating tools and leaves read-only tools alone", () => {
	assert.equal(isWriteTool("write_to_file"), true);
	assert.equal(isWriteTool("replace_file_content"), true);
	assert.equal(isWriteTool("edit_file"), true);
	assert.equal(isWriteTool("read_file"), false);
	assert.equal(isWriteTool("view_file"), false);
	assert.equal(isWriteTool("grep_search"), false);
	assert.equal(isWriteTool("run_command"), false);
	assert.equal(isWriteTool(undefined), false);
});

// ---------------------------------------------------------------------------
// toDisplayPath
// ---------------------------------------------------------------------------

test("toDisplayPath strips the workspace prefix regardless of separator style", () => {
	const ws = process.platform === "win32" ? "C:\\dev\\proj" : "/dev/proj";
	const sep = process.platform === "win32" ? "\\" : "/";
	assert.equal(toDisplayPath(`${ws}${sep}src${sep}main.ts`, ws), `src${sep}main.ts`);
	assert.equal(toDisplayPath(`${ws}${sep}src${sep}main.ts`, `${ws}${sep}`), `src${sep}main.ts`);
});

test("toDisplayPath leaves paths outside the workspace untouched", () => {
	assert.equal(toDisplayPath("/etc/hosts", "/dev/proj"), "/etc/hosts");
	assert.equal(toDisplayPath("/dev/proj", ""), "/dev/proj");
});

// ---------------------------------------------------------------------------
// buildRunLog
// ---------------------------------------------------------------------------

test("buildRunLog lists done steps, skips active, and dedupes nothing itself", () => {
	const steps: StepRecord[] = [
		{ index: 2, tool: "write_to_file", file: "a.ts", state: "done" },
		{ index: 3, tool: "write_to_file", file: "a.ts", state: "active" },
		{ index: 4, tool: "run_command", command: "npm test", state: "done" },
	];
	const log = buildRunLog(steps);
	assert.deepEqual(log, ["  ✓ step 2 · ✎ a.ts", "  ✓ step 4 · $ npm test"]);
});

test("buildRunLog caps long logs", () => {
	const steps: StepRecord[] = Array.from({ length: 50 }, (_, i) => ({
		index: i,
		tool: "write_to_file",
		file: `f${i}.ts`,
		state: "done",
	}));
	const log = buildRunLog(steps, 10);
	assert.equal(log.length, 11); // 10 entries + "+N more"
	assert.match(log[10]!, /\+40 more steps/);
});

// ---------------------------------------------------------------------------
// clampConcurrency
// ---------------------------------------------------------------------------

test("clampConcurrency clamps into 1..max and rejects NaN", () => {
	assert.equal(clampConcurrency(3), 3);
	assert.equal(clampConcurrency(0), 1);
	assert.equal(clampConcurrency(-5), 1);
	assert.equal(clampConcurrency(100), 8);
	assert.equal(clampConcurrency(2.9), 2);
	assert.equal(clampConcurrency(Number.NaN), 3); // default fleet concurrency
	assert.equal(clampConcurrency(4, 2), 2);
});

// ---------------------------------------------------------------------------
// Fleet board + summary
// ---------------------------------------------------------------------------

function lane(partial: Partial<FleetLaneState>): FleetLaneState {
	return {
		id: "t1",
		task: "task",
		workspace: "/ws",
		status: "queued",
		live: { step: 0, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 0 },
		...partial,
	};
}

test("summarizeFleet counts lanes by status and computes elapsed", () => {
	const now = 5000;
	const lanes = [
		lane({ status: "running", startedAt: 0 }),
		lane({ status: "done", startedAt: 0, endedAt: 3000 }),
		lane({ status: "failed", startedAt: 1000, endedAt: 2000 }),
		lane({ status: "aborted", startedAt: 1000, endedAt: 4000 }),
		lane({ status: "queued" }),
	];
	assert.deepEqual(summarizeFleet(lanes, now), {
		total: 5,
		running: 2,
		done: 1,
		failed: 1,
		aborted: 1,
		elapsedMs: 5000,
	});
});

test("formatFleetBoard renders a live board with per-lane lines", () => {
	const now = 120_000;
	const lanes = [
		lane({
			id: "setup",
			status: "running",
			startedAt: now - 25_000,
			live: { step: 4, phase: "tool", tool: "write_to_file", file: "src/config.js", stepsDone: 3, filesTouched: ["src/config.js"], elapsedMs: 25_000 },
		}),
		lane({
			id: "tests",
			status: "done",
			startedAt: now - 60_000,
			endedAt: now - 3000,
			result: { files_written: ["a.test.ts"], commands_run: ["npm test"], response: "ok" } as any,
		}),
		lane({ id: "lint", status: "failed", startedAt: now - 40_000, endedAt: now - 20_000, error: "agy ERROR: timeout" }),
		lane({ id: "docs", status: "queued" }),
	];
	const [head, ...rows] = formatFleetBoard(lanes, now);
	assert.match(head, /^agy_fleet · 4 lanes · 2 active · 1 done · 1 failed · 1m$/);
	assert.equal(rows.length, 4);
	assert.match(rows[0]!, /● \[setup\] > step 4 · ✎ src\/config\.js · 25s/);
	assert.match(rows[1]!, /✓ \[tests\] done · 1 file · 1 command · 57s/);
	assert.match(rows[2]!, /✗ \[lint\] failed · agy ERROR: timeout · 20s/);
	assert.match(rows[3]!, /○ \[docs\] waiting/);
});

// ---------------------------------------------------------------------------
// Liveness, freshness, and duration helpers (§3)
// ---------------------------------------------------------------------------

test("activityAgeMs returns undefined when lastActivityAt is undefined", () => {
	const live = idleActivity();
	assert.equal(activityAgeMs(live), undefined);
	assert.equal(activityAgeMs(live, 100_000), undefined);
});

test("activityAgeMs computes elapsed time since lastActivityAt, clamped to 0", () => {
	const live: LiveActivity = { ...idleActivity(), lastActivityAt: 100_000 };
	assert.equal(activityAgeMs(live, 105_000), 5_000);
	assert.equal(activityAgeMs(live, 100_000), 0);
	assert.equal(activityAgeMs(live, 95_000), 0);
});

test("activityState bucket boundaries: undefined, <45s, exactly 45s, <120s, exactly 120s, >120s", () => {
	const now = 500_000;
	assert.equal(ACTIVITY_LONG_RUNNING_MS, 45_000);
	assert.equal(ACTIVITY_NEEDS_ATTENTION_MS, 120_000);

	// undefined age -> "active"
	assert.equal(activityState(idleActivity(), now), "active");

	// age < ACTIVITY_LONG_RUNNING_MS -> "active"
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now }, now), "active");
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now - 44_999 }, now), "active");

	// exactly at ACTIVITY_LONG_RUNNING_MS (45_000) -> "active_long_running"
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now - 45_000 }, now), "active_long_running");
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now - 45_001 }, now), "active_long_running");

	// age < ACTIVITY_NEEDS_ATTENTION_MS (120_000) -> "active_long_running"
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now - 119_999 }, now), "active_long_running");

	// exactly at ACTIVITY_NEEDS_ATTENTION_MS (120_000) -> "needs_attention"
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now - 120_000 }, now), "needs_attention");
	assert.equal(activityState({ ...idleActivity(), lastActivityAt: now - 120_001 }, now), "needs_attention");
});

test("activityFreshnessText reproduces pi-subagents wording for every branch in spec §1", () => {
	const now = 500_000;

	// Branch 1: lastActivityAt === undefined and state needs_attention -> "needs attention"
	assert.equal(activityFreshnessText(idleActivity(), now, "needs_attention"), "needs attention");

	// Branch 2: lastActivityAt === undefined and state active_long_running -> "active but long-running"
	assert.equal(activityFreshnessText(idleActivity(), now, "active_long_running"), "active but long-running");

	// Branch 3: lastActivityAt === undefined and state active -> undefined
	assert.equal(activityFreshnessText(idleActivity(), now), undefined);
	assert.equal(activityFreshnessText(idleActivity(), now, "active"), undefined);

	// Branch 4: age < 1s -> "active now"
	const liveNow: LiveActivity = { ...idleActivity(), lastActivityAt: now - 500 };
	assert.equal(activityFreshnessText(liveNow, now), "active now");
	const live0s: LiveActivity = { ...idleActivity(), lastActivityAt: now };
	assert.equal(activityFreshnessText(live0s, now), "active now");

	// Branch 5: age < 60s (and < 45s, so state is active) -> "active 12s ago"
	const live12s: LiveActivity = { ...idleActivity(), lastActivityAt: now - 12_000 };
	assert.equal(activityFreshnessText(live12s, now), "active 12s ago");
	const live44s: LiveActivity = { ...idleActivity(), lastActivityAt: now - 44_000 };
	assert.equal(activityFreshnessText(live44s, now), "active 44s ago");

	// Branch 6: state active_long_running:
	// exactly 45s: "active but long-running · last activity 45s ago"
	const live45s: LiveActivity = { ...idleActivity(), lastActivityAt: now - 45_000 };
	assert.equal(activityFreshnessText(live45s, now), "active but long-running · last activity 45s ago");

	// 1m (e.g. 60s, 70s): "active but long-running · last activity 1m ago"
	const live60s: LiveActivity = { ...idleActivity(), lastActivityAt: now - 60_000 };
	assert.equal(activityFreshnessText(live60s, now), "active but long-running · last activity 1m ago");
	const live1m: LiveActivity = { ...idleActivity(), lastActivityAt: now - 70_000 };
	assert.equal(activityFreshnessText(live1m, now), "active but long-running · last activity 1m ago");
	const live119s: LiveActivity = { ...idleActivity(), lastActivityAt: now - 119_999 };
	assert.equal(activityFreshnessText(live119s, now), "active but long-running · last activity 1m ago");

	// Branch 7: state needs_attention:
	// exactly 120s (2m): "no activity for 2m"
	const live2m: LiveActivity = { ...idleActivity(), lastActivityAt: now - 120_000 };
	assert.equal(activityFreshnessText(live2m, now), "no activity for 2m");
	const live3m: LiveActivity = { ...idleActivity(), lastActivityAt: now - 180_000 };
	assert.equal(activityFreshnessText(live3m, now), "no activity for 3m");
});

test("toolDurationMs computes duration of active tool step or returns undefined", () => {
	// Undefined toolStartedAt
	assert.equal(toolDurationMs(idleActivity()), undefined);
	assert.equal(toolDurationMs(idleActivity(), 100_000), undefined);

	// Defined toolStartedAt
	const live: LiveActivity = { ...idleActivity(), toolStartedAt: 100_000 };
	assert.equal(toolDurationMs(live, 103_400), 3_400);
	assert.equal(toolDurationMs(live, 100_000), 0);
	assert.equal(toolDurationMs(live, 90_000), 0);
});

test("liveDetail includes new fields when present and omits them when absent", () => {
	const base = idleActivity();
	const baseDetail = liveDetail(base);
	assert.equal("lastActivityAt" in baseDetail, false);
	assert.equal("toolStartedAt" in baseDetail, false);
	assert.equal("outputTail" in baseDetail, false);
	assert.equal("tokens" in baseDetail, false);
	assert.equal("turns" in baseDetail, false);

	const full: LiveActivity = {
		...base,
		lastActivityAt: 100_000,
		toolStartedAt: 102_000,
		outputTail: ["line 1", "line 2"],
		tokens: 4200,
		turns: 3,
	};
	const fullDetail = liveDetail(full);
	assert.equal(fullDetail.lastActivityAt, 100_000);
	assert.equal(fullDetail.toolStartedAt, 102_000);
	assert.deepEqual(fullDetail.outputTail, ["line 1", "line 2"]);
	assert.notEqual(fullDetail.outputTail, full.outputTail);
	assert.equal(fullDetail.tokens, 4200);
	assert.equal(fullDetail.turns, 3);
});