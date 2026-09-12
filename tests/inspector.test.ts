import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fleetDetailLines,
	formatFleetText,
	FleetInspectorComponent,
} from "../src/inspector.ts";
import { FleetRegistry, type AgyRunRecord } from "../src/registry.ts";
import type { LiveActivity, StepRecord } from "../src/status.ts";
import { SPINNER_FRAMES, type ThemeLike } from "../src/ui.ts";

const theme: ThemeLike = {
	fg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
};

function live(patch: Partial<LiveActivity> = {}): LiveActivity {
	return { step: 0, phase: "thinking", stepsDone: 0, filesTouched: [], elapsedMs: 0, ...patch };
}

function mockRun(id: string, patch: Partial<AgyRunRecord> = {}): AgyRunRecord {
	return {
		id,
		kind: "single",
		label: "agy_code",
		preset: "code",
		task: "implement feature",
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

function assertFits(lines: string[], width: number) {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`line exceeds ${width} cols (${visibleWidth(line)}): ${JSON.stringify(line)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// fleetDetailLines section rendering
// ---------------------------------------------------------------------------

test("fleetDetailLines renders task and workspace sections", () => {
	const run = mockRun("r1", {
		task: "build the component",
		workspace: "E:/dev/my-project",
	});
	const text = fleetDetailLines(run, 100, theme).join("\n");
	assert.match(text, /task {2}build the component/);
	assert.match(text, /cwd {3}E:\/dev\/my-project/);
});

test("fleetDetailLines renders liveness section with freshness and right-aligned elapsed", () => {
	const now = Date.now();
	const run = mockRun("r2", {
		status: "running",
		startedAt: now - 35_000,
		live: live({
			step: 7,
			phase: "tool",
			file: "src/core.ts",
			lastActivityAt: now - 4_000,
		}),
	});
	const lines = fleetDetailLines(run, 100, theme);
	const livenessLine = lines.find((l) => l.includes("step 7"));
	assert.ok(livenessLine, "liveness line should exist");
	assert.match(livenessLine, /step 7/);
	assert.match(livenessLine, /src\/core\.ts/);
	assert.match(livenessLine, /active 4s ago/);
	assert.match(livenessLine, /35s/);
	// Elapsed should be right-aligned (towards the end of the line)
	assert.ok(livenessLine.trimEnd().endsWith("35s"), `expected line to end with elapsed: ${livenessLine}`);
});

test("fleetDetailLines renders live token display and metrics", () => {
	// Live run with live tokens
	const liveRun = mockRun("r3", {
		status: "running",
		live: live({
			stepsDone: 15,
			filesTouched: ["src/a.ts", "src/b.ts"],
			tokens: 4_200,
			turns: 3,
		}),
		commandsRun: ["npm test", "git status"],
	});
	const liveText = fleetDetailLines(liveRun, 100, theme).join("\n");
	assert.match(liveText, /steps 15/);
	assert.match(liveText, /files 2/);
	assert.match(liveText, /commands 2/);
	assert.match(liveText, /turns 3/);
	assert.match(liveText, /↓ 4\.2k tokens/);

	// Finished run with final tokens
	const doneRun = mockRun("r4", {
		status: "done",
		tokens: 48_200,
		numTurns: 6,
		live: live({ stepsDone: 9 }),
		commandsRun: ["npm test"],
		filesWritten: ["src/fleetview.ts"],
	});
	const doneText = fleetDetailLines(doneRun, 100, theme).join("\n");
	assert.match(doneText, /steps 9/);
	assert.match(doneText, /commands 1/);
	assert.match(doneText, /tokens 48k/);
	assert.match(doneText, /files {2}src\/fleetview\.ts/);
});

test("fleetDetailLines renders output-tail section with ⎿ prefixes", () => {
	const runWithOutput = mockRun("r5", {
		live: live({
			outputTail: [
				"Compiling TypeScript files...",
				"Found 0 errors in 42 files.",
				"Build finished in 1.2s.",
			],
		}),
	});
	const text = fleetDetailLines(runWithOutput, 100, theme).join("\n");
	assert.match(text, /output/);
	assert.match(text, /⎿ Compiling TypeScript files\.\.\./);
	assert.match(text, /⎿ Found 0 errors in 42 files\./);
	assert.match(text, /⎿ Build finished in 1\.2s\./);

	// Without outputTail, output section is omitted
	const runNoOutput = mockRun("r6", { live: live({ outputTail: [] }) });
	const textNoOutput = fleetDetailLines(runNoOutput, 100, theme).join("\n");
	assert.doesNotMatch(textNoOutput, /output/);
	assert.doesNotMatch(textNoOutput, /⎿/);
});

test("fleetDetailLines renders recent-steps tree with treeBranch glyphs", () => {
	const steps: StepRecord[] = [
		{ index: 1, tool: "read_file", file: "src/schema.ts", state: "done" },
		{ index: 2, tool: "run_command", command: "npm test", state: "done" },
		{ index: 3, tool: "write_file", file: "src/feature.ts", state: "active" },
	];
	const run = mockRun("r7", { recent: steps });
	const lines = fleetDetailLines(run, 100, theme);
	const text = lines.join("\n");

	assert.match(text, /recent steps/);
	// Non-last steps use ├─
	assert.match(text, /├─ ✓ 1 {2}▤ src\/schema\.ts/);
	assert.match(text, /├─ ✓ 2 {2}\$ npm test/);
	// Last step uses └─ and active glyph ▸
	assert.match(text, /└─ ▸ 3 {2}✎ src\/feature\.ts/);
});

// ---------------------------------------------------------------------------
// showTools toggle
// ---------------------------------------------------------------------------

test("showTools toggle hides recent-steps and evidence sections in fleetDetailLines", () => {
	const run = mockRun("r8", {
		recent: [{ index: 1, tool: "write_file", file: "src/a.ts", state: "done" }],
		filesWritten: ["src/a.ts"],
		commandsRun: ["npm test"],
		live: live({ outputTail: ["Finished building."] }),
	});

	// With showTools = true (default)
	const withTools = fleetDetailLines(run, 100, theme, { showTools: true }).join("\n");
	assert.match(withTools, /recent steps/);
	assert.match(withTools, /evidence/);
	assert.match(withTools, /output/);

	// With showTools = false
	const withoutTools = fleetDetailLines(run, 100, theme, { showTools: false }).join("\n");
	assert.doesNotMatch(withoutTools, /recent steps/);
	assert.doesNotMatch(withoutTools, /evidence/);
	// Output, task, and header should still be present
	assert.match(withoutTools, /output/);
	assert.match(withoutTools, /task {2}implement feature/);
	assert.match(withoutTools, /◆ agy_code/);
});

test("FleetInspectorComponent toggles showTools with x and ctrl+o", () => {
	const registry = new FleetRegistry();
	registry.start({
		id: "r",
		kind: "single",
		label: "agy_code",
		preset: "code",
		task: "code task",
		workspace: "/w",
		status: "running",
	});
	registry.patch("r", {
		recent: [{ index: 1, tool: "run_command", command: "ls", state: "done" }],
		filesWritten: ["src/out.ts"],
	});

	let requestedRender = false;
	const fakeTui = {
		requestRender: () => { requestedRender = true; },
		terminal: { rows: 24 },
	};
	const comp = new FleetInspectorComponent(fakeTui, theme, registry, () => {});

	try {
		assert.equal(comp.showTools, true);
		let rendered = comp.render(100).join("\n");
		assert.match(rendered, /recent steps/);
		assert.match(rendered, /evidence/);

		// Press 'x' to toggle off
		comp.handleInput("x");
		assert.equal(comp.showTools, false);
		rendered = comp.render(100).join("\n");
		assert.doesNotMatch(rendered, /recent steps/);
		assert.doesNotMatch(rendered, /evidence/);

		// Press 'x' again to toggle on
		comp.handleInput("x");
		assert.equal(comp.showTools, true);
		rendered = comp.render(100).join("\n");
		assert.match(rendered, /recent steps/);
		assert.match(rendered, /evidence/);

		// Press ctrl+o to toggle off
		comp.handleInput("\x0f");
		assert.equal(comp.showTools, false);

		// Press ctrl+o string representation to toggle on
		comp.handleInput("ctrl+o");
		assert.equal(comp.showTools, true);
	} finally {
		comp.dispose();
	}
});

// ---------------------------------------------------------------------------
// Inspector keyboard navigation & header/footer
// ---------------------------------------------------------------------------

test("FleetInspectorComponent handles Shift+J / Shift+K line scrolling and keys", () => {
	const registry = new FleetRegistry();
	registry.start({
		id: "r",
		kind: "single",
		label: "agy_test",
		preset: "code",
		task: "long task",
		workspace: "/w",
		status: "running",
	});
	// Generate many response lines to make detail tall
	registry.finish("r", {
		status: "done",
		response: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
	});

	const fakeTui = {
		requestRender: () => {},
		terminal: { rows: 20 },
	};
	let closed = false;
	const comp = new FleetInspectorComponent(fakeTui, theme, registry, () => {
		closed = true;
	});

	try {
		comp.render(80);

		// Scroll to top with 'g'
		comp.handleInput("g");

		// Shift+J one-line scroll down
		comp.handleInput("J");
		comp.handleInput("shift+j");

		// Shift+K one-line scroll up
		comp.handleInput("K");
		comp.handleInput("shift+k");

		// Test footer keys text
		const rendered = comp.render(120).join("\n");
		assert.match(
			rendered,
			/↑\/↓ select · Shift\+J\/K line · PgUp\/PgDn page · x tools · g\/G · r refresh · Esc close/,
		);

		// Test Esc close
		comp.handleInput("escape");
		assert.equal(closed, true);
	} finally {
		comp.dispose();
	}
});

test("FleetInspectorComponent animates running entries and displays header totals", () => {
	const registry = new FleetRegistry();
	const now = Date.now();
	registry.start({
		id: "r1",
		kind: "single",
		label: "agy_run",
		preset: "code",
		task: "active task",
		workspace: "/w",
		status: "running",
	});
	registry.patch("r1", {
		live: live({ tokens: 3_100 }),
	});

	const fakeTui = {
		requestRender: () => {},
		terminal: { rows: 24 },
	};
	const comp = new FleetInspectorComponent(fakeTui, theme, registry, () => {});

	try {
		const rendered = comp.render(100).join("\n");
		// Header totals: 1 active · 1 tracked · ↓ 3.1k tokens
		assert.match(rendered, /1 active · 1 tracked · ↓ 3\.1k tokens/);
		// Running entry should have an animated braille spinner in the header and roster
		const hasSpinner = SPINNER_FRAMES.some((frame) => rendered.includes(frame));
		assert.ok(hasSpinner, "expected an animated braille spinner for running entry");
	} finally {
		comp.dispose();
	}
});

// ---------------------------------------------------------------------------
// formatFleetText
// ---------------------------------------------------------------------------

test("formatFleetText summarizes empty and populated registries", () => {
	const emptyRegistry = new FleetRegistry();
	assert.match(formatFleetText(emptyRegistry), /No agy runs tracked in this session yet\./);

	const registry = new FleetRegistry();
	registry.start({
		id: "r",
		kind: "single",
		label: "agy_code",
		preset: "code",
		task: "implement widget",
		workspace: "/w",
		status: "running",
	});
	registry.finish("r", {
		status: "done",
		filesWritten: ["src/a.ts"],
		commandsRun: ["npm test"],
	});
	const text = formatFleetText(registry);
	assert.match(text, /1 tracked · 0 active · 1 done/);
	assert.match(text, /\[done\] agy_code/);
	assert.match(text, /files: src\/a\.ts/);
	assert.match(text, /ran: npm test/);
});

// ---------------------------------------------------------------------------
// Width invariants (widths 24..160)
// ---------------------------------------------------------------------------

test("fleetDetailLines satisfies width invariants across widths 24..160", () => {
	const fullRun = mockRun("r_full", {
		task: "A very long task description that wraps across multiple lines and goes on and on ".repeat(5),
		workspace: "E:/deeply/nested/directory/structure/that/has/a/very/long/path/name",
		status: "running",
		startedAt: Date.now() - 120_000,
		live: live({
			step: 42,
			phase: "tool",
			file: "src/components/very/deeply/nested/inspector/component/file.ts",
			lastActivityAt: Date.now() - 5_000,
			tokens: 84_500,
			turns: 12,
			stepsDone: 42,
			filesTouched: ["src/a.ts", "src/b.ts", "src/c.ts"],
			outputTail: [
				"Compiling module with very long name and options --target es2022 --moduleResolution node...",
				"Successfully generated declaration files.",
				"All done.",
			],
		}),
		recent: [
			{ index: 40, tool: "run_command", command: "npm run build -- --production --profile", state: "done" },
			{ index: 41, tool: "write_file", file: "src/long/path/to/source/file.ts", state: "done" },
			{ index: 42, tool: "write_file", file: "src/components/very/deeply/nested/inspector/component/file.ts", state: "active" },
		],
		filesWritten: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
		commandsRun: ["npm test", "npm run typecheck", "git diff"],
		warnings: ["tool calls were auto-denied due to permissions", "another long warning message here"],
		error: "agy ERROR: model unavailable or timed out after 120 seconds",
		response: "Detailed response text with lots of words and lines\n".repeat(15),
	});

	for (let w = 24; w <= 160; w++) {
		const linesWithTools = fleetDetailLines(fullRun, w, theme, { showTools: true });
		assertFits(linesWithTools, w);
		const linesWithoutTools = fleetDetailLines(fullRun, w, theme, { showTools: false });
		assertFits(linesWithoutTools, w);
	}
});
