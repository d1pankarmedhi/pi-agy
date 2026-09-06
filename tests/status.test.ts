import { test } from "node:test";
import assert from "node:assert/strict";
import {
	activityLine,
	buildRunLog,
	clampConcurrency,
	formatDuration,
	formatFleetBoard,
	summarizeFleet,
	type FleetLaneState,
	type LiveActivity,
	type StepRecord,
} from "../index.ts";

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