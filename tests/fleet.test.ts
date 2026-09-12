import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	activeFleetTotals,
	fleetCollapsedLines,
	fleetRosterLine,
	fleetRosterLines,
} from "../src/fleetview.ts";
import { fleetDetailLines, formatFleetText } from "../src/inspector.ts";
import { FleetRegistry, isActiveStatus, type AgyRunRecord } from "../src/registry.ts";
import type { LiveActivity } from "../src/status.ts";
import { SPINNER_FRAMES, type ThemeLike } from "../src/ui.ts";

const SPINNER_PATTERN = `[${SPINNER_FRAMES.join("")}]`;

// Identity theme: assertions then read as plain text (real themes only add ANSI).
const theme: ThemeLike = {
	fg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
};

const WIDTHS = [24, 32, 48, 64, 80, 96, 120];

function assertFits(lines: string[], width: number) {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`line exceeds ${width} cols (${visibleWidth(line)}): ${JSON.stringify(line)}`
		);
	}
}

function live(patch: Partial<LiveActivity> = {}): LiveActivity {
	return { step: 0, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 0, ...patch };
}

// ---------------------------------------------------------------------------
// FleetRegistry
// ---------------------------------------------------------------------------

test("registry tracks a run from start through finish", () => {
	const registry = new FleetRegistry();
	const run = registry.start({
		id: registry.nextId("agy"),
		kind: "single",
		label: "agy_code",
		preset: "code",
		task: "implement the widget",
		workspace: "E:/dev/pi-agy",
		model: "gemini-3.8-flash-high",
		status: "running",
	});

	assert.equal(registry.all().length, 1);
	assert.equal(registry.active().length, 1);
	assert.equal(registry.get(run.id)?.status, "running");

	registry.patch(run.id, { live: live({ step: 4, phase: "tool", file: "src/a.ts", stepsDone: 3, filesTouched: ["src/a.ts"] }) });
	assert.equal(registry.get(run.id)?.live.stepsDone, 3);

	registry.finish(run.id, {
		status: "done",
		response: "done",
		filesWritten: ["src/a.ts"],
		commandsRun: ["npm test"],
		tokens: 1234,
	});
	const stored = registry.get(run.id)!;
	assert.equal(stored.status, "done");
	assert.equal(stored.live.phase, "done");
	assert.deepEqual(stored.filesWritten, ["src/a.ts"]);
	assert.equal(registry.active().length, 0);
	assert.equal(registry.counts().done, 1);
	assert.equal(registry.counts().tokens, 1234);
});

test("registry keeps active runs before finished ones and counts by status", () => {
	const registry = new FleetRegistry();
	const a = registry.start({ id: "a", kind: "lane", label: "lane a", preset: "fleet", task: "a", workspace: "/w", status: "running" });
	const b = registry.start({ id: "b", kind: "lane", label: "lane b", preset: "fleet", task: "b", workspace: "/w" });
	registry.finish("b", { status: "failed", error: "boom" });
	registry.start({ id: "c", kind: "lane", label: "lane c", preset: "fleet", task: "c", workspace: "/w", status: "running" });
	registry.start({ id: "d", kind: "lane", label: "lane d", preset: "fleet", task: "d", workspace: "/w" });

	const order = registry.all().map((entry) => entry.id);
	assert.deepEqual(order, ["a", "c", "d", "b"], "active runs first, then finished");
	const counts = registry.counts();
	assert.deepEqual(
		{ total: counts.total, active: counts.active, queued: counts.queued, running: counts.running, failed: counts.failed },
		{ total: 4, active: 3, queued: 1, running: 2, failed: 1 }
	);
	assert.equal(isActiveStatus("running"), true);
	assert.equal(isActiveStatus("done"), false);
});

test("registry trims the oldest finished runs", () => {
	const registry = new FleetRegistry();
	for (let i = 0; i < 30; i++) {
		registry.start({ id: `r${i}`, kind: "single", label: "agy", preset: "run", task: "t", workspace: "/w" });
		registry.finish(`r${i}`, { status: "done" });
	}
	assert.equal(registry.all().length, 25, "only the most recent finished runs are retained");
});

test("registry subscribe fires and unsubscribe stops delivery", () => {
	const registry = new FleetRegistry();
	let calls = 0;
	const unsubscribe = registry.subscribe(() => calls++);
	registry.start({ id: "x", kind: "single", label: "agy", preset: "run", task: "t", workspace: "/w" });
	assert.equal(calls, 1, "start notifies immediately");
	unsubscribe();
	registry.finish("x", { status: "done" });
	assert.equal(calls, 1, "no notifications after unsubscribe");
});

// ---------------------------------------------------------------------------
// FleetView rendering
// ---------------------------------------------------------------------------

function runningRun(id: string, patch: Partial<AgyRunRecord> = {}): AgyRunRecord {
	return {
		id,
		kind: "single",
		label: "agy_code",
		preset: "code",
		task: "do work",
		workspace: "E:/dev/pi-agy",
		status: "running",
		startedAt: Date.now() - 42_000,
		live: live({ step: 12, phase: "tool", file: "src/a.ts", stepsDone: 12, filesTouched: ["src/a.ts"] }),
		recent: [],
		warnings: [],
		filesWritten: [],
		commandsRun: [],
		...patch,
	};
}

test("collapsed FleetView line summarizes active agents and progress", () => {
	const lines = fleetCollapsedLines([runningRun("a"), runningRun("b", { status: "queued" })], 80, theme);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /2 active agents/);
	assert.match(lines[0]!, /24 steps/);
	assert.match(lines[0]!, /1 file/);
	assert.match(lines[0]!, /↓\/← to inspect/);
});

test("activeFleetTotals dedupes files across runs", () => {
	const a = runningRun("a");
	const b = runningRun("b", { live: live({ stepsDone: 3, filesTouched: ["src/a.ts", "src/b.ts"] }) });
	const totals = activeFleetTotals([a, b]);
	assert.equal(totals.agents, 2);
	assert.equal(totals.steps, 15);
	assert.equal(totals.files, 2, "shared files are counted once");
});

test("roster line shows status glyph, label, and activity", () => {
	const line = fleetRosterLine(runningRun("a"), true, 90, theme);
	assert.match(line, new RegExp(`> ${SPINNER_PATTERN} agy_code · running`));
	assert.match(line, /✎ src\/a\.ts/);
	assert.match(line, /42s/);
});

test("expanded roster lists main plus every active run", () => {
	const entries = [runningRun("a"), runningRun("b", { label: "agy_fleet · t2" })];
	const text = fleetRosterLines(entries, "main", 90, theme).join("\n");
	assert.match(text, /↑↓\/jk select · enter inspect · esc back/);
	assert.match(text, /> main/);
	assert.match(text, /agy_fleet · t2/);
	const selected = fleetRosterLines(entries, "a", 90, theme).join("\n");
	assert.match(selected, new RegExp(`> ${SPINNER_PATTERN} agy_code`));
});

test("fleet renders never exceed the terminal width", () => {
	const entries = [runningRun("a"), runningRun("b"), runningRun("c", { status: "queued" })];
	for (const width of WIDTHS) {
		assertFits(fleetCollapsedLines(entries, width, theme), width);
		assertFits(fleetRosterLines(entries, "a", width, theme), width);
		for (const entry of entries) assertFits([fleetRosterLine(entry, true, width, theme)], width);
	}
});

test("collapsed line includes animated spinner and tokens when present", () => {
	const a = runningRun("a", { live: live({ stepsDone: 10, filesTouched: ["src/a.ts"], tokens: 1500 }) });
	const b = runningRun("b", { live: live({ stepsDone: 5, filesTouched: ["src/b.ts"], tokens: 2700 }) });
	const lines = fleetCollapsedLines([a, b], 80, theme, { now: 1000 });
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, new RegExp(`^[ ]{2}${SPINNER_PATTERN} 2 active agents`));
	assert.match(lines[0]!, /15 steps/);
	assert.match(lines[0]!, /2 files/);
	assert.match(lines[0]!, /↓ 4\.2k tokens/);
	assert.match(lines[0]!, /↓\/← to inspect/);
});

test("compact single-run block renders max 3 rows with activity duration and task", () => {
	const run = runningRun("a", {
		label: "agy_code",
		task: "Refactor the fleet widget rows",
		startedAt: 1_000_000,
		live: live({
			stepsDone: 12,
			file: "src/fleetview.ts",
			tokens: 4200,
			toolStartedAt: 1_068_600,
		}),
	});
	const now = 1_072_000; // elapsed = 72s = 1m 12s; toolDuration = 3400ms = 3.4s
	const lines = fleetCollapsedLines([run], 80, theme, { now, frame: 2 });
	assert.equal(lines.length, 3);
	// Row 1: spinner, label, status, steps, tokens, elapsed
	assert.match(lines[0]!, new RegExp(`${SPINNER_PATTERN} agy_code · running · 12 steps · ↓ 4\\.2k tokens`));
	assert.match(lines[0]!, /1m 12s/);
	// Row 2: ⎿, file, tool duration
	assert.match(lines[1]!, /⎿  ✎ src\/fleetview\.ts  3\.4s/);
	// Row 3: task
	assert.match(lines[2]!, /task: Refactor the fleet widget rows/);
});

test("expanded roster orders running first, then queued, then finished, with overflow summary", () => {
	const r1 = runningRun("r1", { label: "worker-1", live: live({ stepsDone: 12, tokens: 4200 }) });
	const r2 = runningRun("r2", { label: "worker-2", live: live({ stepsDone: 4, tokens: 1100 }) });
	const q1 = runningRun("q1", { label: "worker-3", status: "queued" });
	const q2 = runningRun("q2", { label: "worker-4", status: "queued" });
	const d1 = runningRun("d1", { label: "worker-5", status: "done", endedAt: Date.now() });
	const d2 = runningRun("d2", { label: "worker-6", status: "done", endedAt: Date.now() });

	// maxRows = 4 -> r1, r2, 2 queued, d1 are visible; d2 is overflow (+1 more (1 finished))
	const lines = fleetRosterLines([r1, r2, q1, q2, d1, d2], "main", 90, theme, 4);
	const text = lines.join("\n");
	assert.match(text, /worker-1/);
	assert.match(text, /worker-2/);
	assert.match(text, /2 queued/);
	assert.match(text, /worker-5/);
	assert.match(text, /\+1 more \(1 finished\)/);
});

test("queued lane shows — for elapsed duration instead of a timestamp", () => {
	const q = runningRun("q", { status: "queued", label: "agy_fleet · t3", startedAt: Date.now() - 100_000 });
	const line = fleetRosterLine(q, false, 90, theme);
	assert.match(line, /○ agy_fleet · t3/);
	assert.match(line, /waiting/);
	assert.match(line, /— · queued/);
	assert.doesNotMatch(line, /1m|100s/);
});

test("width invariants across widths 24..160 for all widget layouts", () => {
	const r1 = runningRun("r1", {
		label: "agy_code_very_long_label_name",
		task: "A very long task description that definitely exceeds small column widths",
		live: live({ stepsDone: 42, file: "src/very/deeply/nested/directory/fleetview.ts", tokens: 120_000, toolStartedAt: Date.now() - 3400 }),
	});
	const q1 = runningRun("q1", { status: "queued", label: "agy_fleet_queued_lane_with_long_name" });
	const d1 = runningRun("d1", { status: "done", label: "agy_done_lane", endedAt: Date.now() });

	const testWidths = [24, 32, 40, 48, 64, 80, 96, 120, 160];
	for (const w of testWidths) {
		// Single-run collapsed
		assertFits(fleetCollapsedLines([r1], w, theme), w);
		// Multi-run collapsed
		assertFits(fleetCollapsedLines([r1, q1], w, theme), w);
		// Single lines
		assertFits([fleetRosterLine(r1, true, w, theme)], w);
		assertFits([fleetRosterLine(q1, false, w, theme)], w);
		assertFits([fleetRosterLine(d1, false, w, theme)], w);
		// Expanded roster with overflow
		assertFits(fleetRosterLines([r1, q1, d1], "main", w, theme, 2), w);
	}
});


// ---------------------------------------------------------------------------
// Inspector detail
// ---------------------------------------------------------------------------

test("inspector detail reports status, metrics, evidence, and response", () => {
	const registry = new FleetRegistry();
	registry.start({ id: "r", kind: "lane", label: "agy_fleet · t1", preset: "fleet", task: "wire the widget", workspace: "E:/dev/pi-agy", model: "gemini-3.8-flash-high", status: "running", laneId: "t1" });
	registry.patch("r", { live: live({ step: 9, phase: "tool", command: "npm test", stepsDone: 9 }) });
	registry.finish("r", {
		status: "done",
		response: "widget wired and tested",
		filesWritten: ["src/fleetview.ts"],
		commandsRun: ["npm test"],
		numTurns: 6,
		tokens: 48_200,
	});
	const text = fleetDetailLines(registry.get("r")!, 96, theme).join("\n");
	assert.match(text, /◆ agy_fleet · t1 · done/);
	assert.match(text, /lane t1/);
	assert.match(text, /task {2}wire the widget/);
	assert.match(text, /steps 9/);
	assert.match(text, /commands 1/);
	assert.match(text, /tokens 48k/);
	assert.match(text, /files {2}src\/fleetview\.ts/);
	assert.match(text, /widget wired and tested/);
});

test("inspector detail surfaces failures and warnings", () => {
	const registry = new FleetRegistry();
	registry.start({ id: "f", kind: "single", label: "agy_role · scout", preset: "role", task: "map the repo", workspace: "/w", status: "running" });
	registry.finish("f", { status: "failed", error: "agy ERROR: model unavailable", warnings: ["tool calls were auto-denied"] });
	const text = fleetDetailLines(registry.get("f")!, 90, theme).join("\n");
	assert.match(text, /agy_role · scout · failed/);
	assert.match(text, /✗ agy ERROR: model unavailable/);
	assert.match(text, /⚠ tool calls were auto-denied/);
});

test("inspector detail never exceeds the terminal width", () => {
	const registry = new FleetRegistry();
	registry.start({ id: "r", kind: "single", label: "agy", preset: "run", task: "a very long task description ".repeat(20), workspace: "E:/a/very/long/workspace/path/that/keeps/going", status: "running" });
	registry.patch("r", { live: live({ step: 10, phase: "tool", file: "src/deeply/nested/path/to/a/file.ts", stepsDone: 10 }) });
	registry.finish("r", { status: "done", response: "line\n".repeat(200), filesWritten: ["a".repeat(200)], commandsRun: ["b".repeat(200)] });
	for (const width of WIDTHS) assertFits(fleetDetailLines(registry.get("r")!, width, theme), width);
});

test("formatFleetText renders a plain-text fallback for non-UI modes", () => {
	const registry = new FleetRegistry();
	assert.match(formatFleetText(registry), /No agy runs tracked/);
	registry.start({ id: "r", kind: "single", label: "agy_code", preset: "code", task: "fix the bug", workspace: "/w", status: "running" });
	registry.finish("r", { status: "done", filesWritten: ["src/a.ts"], commandsRun: ["npm test"] });
	const text = formatFleetText(registry);
	assert.match(text, /1 tracked · 0 active · 1 done/);
	assert.match(text, /\[done\] agy_code/);
	assert.match(text, /files: src\/a\.ts/);
	assert.match(text, /ran: npm test/);
});
