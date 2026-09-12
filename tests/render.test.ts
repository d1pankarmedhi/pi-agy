import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fleetBoardLines,
	fleetCallLines,
	fleetRenderers,
	fleetResultLines,
	LiveView,
	singleActivityLines,
	singleCallLines,
	singleRenderers,
	singleResultLines,
	type AgyMeta,
	type AgyRenderState,
	type FleetDetails,
	type SingleDetails,
} from "../src/render.ts";
import { fitParts, row, trunc, View, type ThemeLike } from "../src/ui.ts";

// Identity theme: keeps assertions readable (real themes only add ANSI codes,
// which never change visible width).
const theme: ThemeLike = {
	fg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
};

const meta: AgyMeta = {
	preset: "code",
	model: "gemini-3.8-flash-high",
	effort: "high",
	workspace: "E:/dev/SAAS/secondbrain",
	allowCommands: false,
	timeout: "10m",
};

const WIDTHS = [16, 24, 32, 48, 64, 80, 96, 120, 160];

/** Every renderer must respect the terminal width — no exceptions. */
function assertFits(lines: string[], width: number) {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`line exceeds ${width} cols (${visibleWidth(line)}): ${JSON.stringify(line)}`
		);
	}
}

const streamDetails: SingleDetails = {
	phase: "tool",
	step: 50,
	file: "worker/src/lib/contradiction.ts",
	stepsDone: 49,
	elapsedMs: 99_000,
	meta,
	recent: [
		{ index: 47, tool: "read_file", file: "worker/src/lib/schema.ts", state: "done" },
		{ index: 48, tool: "run_command", command: "npm run typecheck", state: "done" },
	],
};

const doneDetails: SingleDetails = {
	status: "SUCCESS",
	meta,
	duration_seconds: 134.2,
	num_turns: 12,
	usage: { total_tokens: 48_231 },
	toolSteps: 50,
	response: "The worker pipeline has three stages.\n\n1. Ingest\n2. Extract\n3. Persist",
	files_written: [
		"E:/dev/SAAS/secondbrain/worker/src/lib/contradiction.ts",
		"E:/dev/SAAS/secondbrain/worker/src/lib/schema.ts",
	],
	commands_run: ["npm run typecheck", "npm test -- worker"],
	steps: Array.from({ length: 30 }, (_, i) => ({
		index: i,
		tool: i % 2 === 0 ? "run_command" : "write_to_file",
		command: i % 2 === 0 ? `npm test -- worker/${i}` : undefined,
		file: i % 2 === 0 ? undefined : `worker/src/lib/m${i}.ts`,
		state: "done" as const,
	})),
};

const fleetDetails: FleetDetails = {
	concurrency: 3,
	elapsedMs: 130_000,
	lanes: [
		{
			id: "ingest",
			status: "running",
			elapsedMs: 42_000,
			activity: { step: 12, phase: "tool", tool: "write_to_file", file: "worker/src/ingest.ts", stepsDone: 11, filesTouched: [], elapsedMs: 42_000 },
		},
		{ id: "extract", status: "done", elapsedMs: 38_000, files_written: ["a.ts", "b.ts"], commands_run: ["npm test"] },
		{ id: "schema", status: "failed", elapsedMs: 12_000, error: "agy ERROR: print timeout exceeded", task: "Migrate the graph tables" },
		{ id: "docs", status: "queued" },
	],
};

// ---------------------------------------------------------------------------
// ui primitives
// ---------------------------------------------------------------------------

test("trunc respects visible width and adds an ellipsis", () => {
	assert.equal(trunc("hello", 10), "hello");
	assert.equal(visibleWidth(trunc("hello world", 6)), 6);
	assert.ok(trunc("hello world", 6).includes("…"));
});

test("row right-aligns and never overflows", () => {
	const line = row("left side", "42s", 20);
	assert.equal(visibleWidth(line), 20);
	assert.ok(line.endsWith("42s"));
	assert.ok(line.startsWith("left side"));
});

test("fitParts drops trailing parts at token boundaries", () => {
	const parts = ["gemini-3.8-flash-high", "high effort", "timeout 10m"];
	assert.equal(fitParts(parts, 200, " · "), parts.join(" · "));
	assert.equal(fitParts(parts, 22, " · "), "gemini-3.8-flash-high");
	assert.equal(fitParts(parts, 3, " · "), "gemini-3.8-flash-high"); // never returns empty for a required first part
	assert.equal(fitParts(parts, 0, " · "), ""); // but a zero budget shows nothing
});

test("View truncates defensively and survives a throwing builder", () => {
	const view = new View(() => ["x".repeat(100), "short"]);
	assert.deepEqual(view.render(10).map(visibleWidth), [10, 5]);
	const broken = new View(() => {
		throw new Error("boom");
	});
	assert.deepEqual(broken.render(20), []);
});

test("commands with embedded newlines are flattened into one line", () => {
	const lines = singleActivityLines(
		"run",
		{ phase: "tool", step: 1, command: "git commit -m 'title\n\nbody'", meta: { ...meta, preset: "run" } },
		80,
		theme
	);
	assert.ok(lines.every((l) => !l.includes("\n")), "no rendered line may contain a raw newline");
	assert.match(lines.join(" "), /title body/);
});

// ---------------------------------------------------------------------------
// Error results must not render as success
// ---------------------------------------------------------------------------

test("singleRenderers renders a pi-generated tool error as a failure card", () => {
	const renderers = singleRenderers("run");
	const result = {
		content: [{ type: "text" as const, text: "Failed to launch agy (agy) in /ws: ENOENT" }],
		details: undefined,
	} as never;
	const lines = renderers
		.renderResult(result, { expanded: false, isPartial: false }, theme as never, { isError: true })
		.render(80)
		.join("\n");
	assert.match(lines, /failed/);
	assert.match(lines, /ENOENT/);
	assert.doesNotMatch(lines, /✓ done/);
});

test("fleetRenderers renders a pi-generated fleet error instead of 0/0 success", () => {
	const renderers = fleetRenderers();
	const result = { content: [{ type: "text" as const, text: "agy_fleet aborted" }], details: undefined } as never;
	const lines = renderers
		.renderResult(result, { expanded: false, isPartial: false }, theme as never, { isError: true })
		.render(80)
		.join("\n");
	assert.match(lines, /failed/);
	assert.match(lines, /aborted/);
	assert.doesNotMatch(lines, /✓/);
});

test("LiveView timer lifecycle: install on partial, clear on final, clear on invalidate and dispose", () => {
	let invalidations = 0;
	const state: AgyRenderState = {};
	const context = {
		invalidate: () => {
			invalidations++;
		},
		state,
	};

	// 1. Partial render installs timer
	const partial = new LiveView((w, frame) => [`frame ${frame}`], true, context);
	const partialLines = partial.render(80);
	assert.match(partialLines[0]!, /frame \d+/);
	assert.ok(state.animationTimer !== undefined, "timer should be installed on context.state");

	// 2. Final render clears timer and does not reinstall
	const final = new LiveView((w) => ["final output"], false, context);
	const finalLines = final.render(80);
	assert.equal(finalLines[0], "final output");
	assert.equal(state.animationTimer, undefined, "timer should be cleared on final render");

	// 3. Invalidate on component clears timer
	const partial2 = new LiveView((w, frame) => ["partial 2"], true, context);
	partial2.render(80);
	assert.ok(state.animationTimer !== undefined, "timer installed on second partial");
	partial2.invalidate();
	assert.equal(state.animationTimer, undefined, "timer cleared on invalidate()");

	// 4. Dispose on component clears timer
	const partial3 = new LiveView((w, frame) => ["partial 3"], true, context);
	partial3.render(80);
	assert.ok(state.animationTimer !== undefined, "timer installed on third partial");
	partial3.dispose();
	assert.equal(state.animationTimer, undefined, "timer cleared on dispose()");
});

// ---------------------------------------------------------------------------
// Single-run cards
// ---------------------------------------------------------------------------

test("singleCallLines shows title, config meta, and prompt", () => {
	const lines = singleCallLines(
		"code",
		{ prompt: "Map the modules in src/", model: "gemini-3.8-flash-high", effort: "high", timeout: "10m", workspace: "ws" },
		96,
		theme
	);
	const text = lines.join("\n");
	assert.match(text, /agy_code/);
	assert.match(text, /implement/);
	assert.match(text, /gemini-3\.8-flash-high/);
	assert.match(text, /Map the modules in src\//);
});

test("singleCallLines renders the vision preset with image and screenshot meta", () => {
	const lines = singleCallLines(
		"vision",
		{
			prompt: "List layout bugs",
			images: ["shot.png", "ui/mock.png"],
			url: "http://localhost:3000",
			model: "gemini-3.8-flash-high",
			workspace: "ws",
		},
		120,
		theme
	);
	const text = lines.join("\n");
	assert.match(text, /agy_vision/);
	assert.match(text, /image/);
	assert.match(text, /2 images/);
	assert.match(text, /screenshot http:\/\/localhost:3000/);
	assert.match(text, /List layout bugs/);
});

test("singleActivityLines shows live step, target, elapsed, and recent trail", () => {
	const lines = singleActivityLines("code", streamDetails, 96, theme);
	const text = lines.join("\n");
	assert.match(text, /step 50/);
	assert.match(text, /contradiction\.ts/);
	assert.match(text, /1m 39s/);
	assert.match(text, /npm run typecheck/);
	assert.match(text, /schema\.ts/);
	assert.match(text, /▤/);
});

test("singleActivityLines renders freshness chip when lastActivityAt is present", () => {
	const now = 1_700_000_100_000;
	const details: SingleDetails = {
		...streamDetails,
		lastActivityAt: now - 3_000,
	};
	const lines = singleActivityLines("code", details, 96, theme, 0, now);
	const text = lines.join("\n");
	assert.match(text, /active 3s ago/);
	assert.match(text, /⠋/);
});

test("singleActivityLines formats token stat with formatTokens", () => {
	const details: SingleDetails = {
		...streamDetails,
		tokens: 4_200,
	};
	const lines = singleActivityLines("code", details, 96, theme);
	const text = lines.join("\n");
	assert.match(text, /↓ 4\.2k tokens/);
});

test("singleActivityLines formats recent steps with tree branches and glyphs", () => {
	const details: SingleDetails = {
		...streamDetails,
		recent: [
			{ index: 47, tool: "read_file", file: "worker/src/lib/schema.ts", state: "done" },
			{ index: 48, tool: "run_command", command: "npm run typecheck", state: "done" },
			{ index: 49, tool: "write_to_file", file: "worker/src/lib/contradiction.ts", state: "active" },
		],
	};
	const lines = singleActivityLines("code", details, 96, theme);
	const text = lines.join("\n");
	assert.match(text, /├─ ✓ 47/);
	assert.match(text, /├─ ✓ 48/);
	assert.match(text, /└─ ▸ 49/);
});

test("singleActivityLines renders output tail with current tool duration", () => {
	const now = 1_700_000_100_000;
	const details: SingleDetails = {
		...streamDetails,
		toolStartedAt: now - 3_400,
		outputTail: ["Compiling schema…", "Writing the contradiction scorer…"],
	};
	const lines = singleActivityLines("code", details, 96, theme, 0, now);
	const text = lines.join("\n");
	assert.match(text, /⎿/);
	assert.match(text, /Writing the contradiction scorer… 3\.4s/);
});

test("singleResultLines summarizes metrics, response, evidence, and run log", () => {
	const collapsed = singleResultLines("code", doneDetails, 96, theme, false).join("\n");
	assert.match(collapsed, /steps 50/);
	assert.match(collapsed, /files 2/);
	assert.match(collapsed, /tokens 48k/);
	assert.match(collapsed, /run log/);
	assert.match(collapsed, /Ctrl\+O to expand/);
	assert.match(collapsed, /worker\/src\/lib\/contradiction\.ts/);

	const expanded = singleResultLines("code", doneDetails, 96, theme, true).join("\n");
	assert.doesNotMatch(expanded, /Ctrl\+O to expand/);
	assert.match(expanded, /workspace/);
});

test("singleResultLines surfaces warnings and the empty-response case", () => {
	const lines = singleResultLines(
		"run",
		{ status: "SUCCESS", meta: { ...meta, preset: "run" }, warnings: ["tool calls were auto-denied"], response: "" },
		90,
		theme,
		false
	).join("\n");
	assert.match(lines, /auto-denied/);
	assert.match(lines, /returned no text/);
	assert.match(lines, /✗/);
});

// ---------------------------------------------------------------------------
// Fleet cards
// ---------------------------------------------------------------------------

test("fleetCallLines lists lanes with ids and task previews", () => {
	const lines = fleetCallLines(
		{
			concurrency: 3,
			tasks: [
				{ id: "ingest", task: "Refactor the ingest stage" },
				{ id: "extract", task: "Add contradiction scoring" },
			],
		},
		90,
		theme
	).join("\n");
	assert.match(lines, /agy_fleet/);
	assert.match(lines, /2 lanes/);
	assert.match(lines, /ingest/);
	assert.match(lines, /Refactor the ingest stage/);
});

test("fleetBoardLines shows per-lane state, activity, and elapsed", () => {
	const lines = fleetBoardLines(fleetDetails, 96, theme).join("\n");
	assert.match(lines, /2 active/);
	assert.match(lines, /1 failed/);
	assert.match(lines, /ingest/);
	assert.match(lines, /worker\/src\/ingest\.ts/);
	assert.match(lines, /print timeout exceeded/);
	assert.match(lines, /waiting/);
});

test("fleetBoardLines renders spinner glyph and freshness for live lanes", () => {
	const now = 1_700_000_100_000;
	const details: FleetDetails = {
		elapsedMs: 50_000,
		lanes: [
			{
				id: "worker1",
				status: "running",
				activity: {
					step: 5,
					phase: "tool",
					file: "src/worker.ts",
					lastActivityAt: now - 3_000,
					stepsDone: 4,
					filesTouched: [],
					elapsedMs: 5_000,
				},
			},
		],
	};
	const lines = fleetBoardLines(details, 100, theme, 0, now);
	const text = lines.join("\n");
	assert.match(text, /worker1/);
	assert.match(text, /active 3s ago/);
	assert.match(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("fleetBoardLines degrades to a stacked layout on narrow terminals", () => {
	const wide = fleetBoardLines(fleetDetails, 120, theme);
	const narrow = fleetBoardLines(fleetDetails, 40, theme);
	assert.ok(narrow.length >= wide.length);
	assertFits(narrow, 40);
});

test("fleetResultLines reports per-lane outcome and evidence", () => {
	const details: FleetDetails = {
		concurrency: 3,
		elapsedMs: 130_000,
		succeeded: 1,
		failed: 1,
		aborted: 0,
		lanes: [
			{ id: "ingest", status: "done", duration_seconds: 42, files_written: ["worker/src/ingest.ts"], commands_run: ["npm test"], response: "Refactored the ingest stage." },
			{ id: "schema", status: "failed", duration_seconds: 12, error: "agy ERROR: print timeout exceeded", task: "Migrate the graph tables" },
		],
	};
	const lines = fleetResultLines(details, 96, theme, false).join("\n");
	assert.match(lines, /1\/2 lanes/);
	assert.match(lines, /1 failed/);
	assert.match(lines, /1 file · 1 command/);
	assert.match(lines, /evidence/);
	assert.match(lines, /\[ingest\] files: worker\/src\/ingest\.ts/);
});

test("fleetResultLines shows a duration for a failed lane that only has elapsedMs", () => {
	const lines = fleetResultLines(
		{
			succeeded: 0,
			failed: 1,
			aborted: 0,
			lanes: [{ id: "t1", status: "failed", error: "boom", elapsedMs: 12_000 }],
		},
		96,
		theme,
		false
	).join("\n");
	assert.match(lines, /boom/);
	assert.match(lines, /12s/);
});

// ---------------------------------------------------------------------------
// Responsiveness: every card fits every width
// ---------------------------------------------------------------------------

test("all cards stay within the requested width", () => {
	const at = (build: (w: number) => string[], width: number) => new View(build).render(width);
	for (const width of WIDTHS) {
		assertFits(at((w) => singleCallLines("code", { prompt: "a".repeat(400), workspace: "C:/very/long/workspace/path/here", model: "gemini-3.8-flash-high" }, w, theme), width), width);
		assertFits(
			at(
				(w) =>
					singleCallLines(
						"vision",
						{ prompt: "p".repeat(300), images: ["a/very/long/image/name/that/keeps/going.png"], url: "https://example.com/a/very/long/page/path?with=query", workspace: "C:/very/long/workspace/path/here" },
						w,
						theme
					),
				width
			),
			width
		);
		assertFits(at((w) => singleActivityLines("code", streamDetails, w, theme), width), width);
		assertFits(at((w) => singleResultLines("code", doneDetails, w, theme, false), width), width);
		assertFits(at((w) => singleResultLines("code", doneDetails, w, theme, true), width), width);
		assertFits(at((w) => fleetCallLines({ concurrency: 3, tasks: [{ id: "a-very-long-lane-id", task: "t".repeat(200) }] }, w, theme), width), width);
		assertFits(at((w) => fleetBoardLines(fleetDetails, w, theme), width), width);
		assertFits(
			at(
				(w) =>
					fleetResultLines(
						{
							elapsedMs: 130_000,
							lanes: [
								{ id: "lane-with-a-long-name", status: "done", files_written: ["a/very/long/file/path/that/keeps/going.ts"], commands_run: ["npm run a-very-long-command --with-flags"], response: "r".repeat(300) },
							],
						},
						w,
						theme,
						true
					),
				width
			),
			width
		);
	}
});

test("new singleActivityLines and fleetBoardLines stay width-safe across widths 16..160", () => {
	const now = 1_700_000_100_000;
	const richDetails: SingleDetails = {
		step: 50,
		phase: "tool",
		file: "worker/src/lib/contradiction.ts",
		stepsDone: 49,
		elapsedMs: 99_000,
		lastActivityAt: now - 3000,
		toolStartedAt: now - 3400,
		tokens: 4200,
		outputTail: [
			"Very long output line 1 that should be truncated properly without exceeding any width constraints whatsoever",
			"Very long output line 2 with more details and text",
			"Writing the contradiction scorer…",
		],
		recent: [
			{ index: 47, tool: "read_file", file: "worker/src/lib/schema.ts", state: "done" },
			{ index: 48, tool: "run_command", command: "npm run typecheck --with-many-flags-and-arguments", state: "done" },
			{ index: 49, tool: "write_to_file", file: "worker/src/lib/contradiction.ts", state: "active" },
		],
	};
	const richFleet: FleetDetails = {
		elapsedMs: 130_000,
		lanes: [
			{
				id: "a-very-long-lane-identifier-that-could-overflow",
				status: "running",
				elapsedMs: 42_000,
				activity: {
					step: 12,
					phase: "tool",
					tool: "write_to_file",
					file: "worker/src/long/path/to/ingest.ts",
					lastActivityAt: now - 2000,
					toolStartedAt: now - 1500,
					stepsDone: 11,
					filesTouched: [],
					elapsedMs: 42_000,
					tokens: 3500,
				},
			},
		],
	};

	for (let w = 16; w <= 160; w++) {
		const actLines = singleActivityLines("code", richDetails, w, theme, 2, now);
		assertFits(actLines, w);
		const fleetLines = fleetBoardLines(richFleet, w, theme, 2, now);
		assertFits(fleetLines, w);
	}
});

// ---------------------------------------------------------------------------
// Specialist-role card
// ---------------------------------------------------------------------------

test("the role card identifies the specialist and its access policy", () => {
	const lines = singleCallLines("role", { role: "reviewer", prompt: "review src/a.ts" }, 100, theme);
	const text = lines.join("\n");
	assert.match(text, /◆ agy_role/);
	assert.match(text, /reviewer/);
	assert.match(text, /specialist/);
	assert.doesNotMatch(text, /shell/, "a read-only role must not advertise shell access");
});

test("the role card stays width-safe for a long role id", () => {
	const args = { role: "a-very-long-specialist-role-name-that-keeps-going", prompt: "t".repeat(300) };
	for (const width of WIDTHS) {
		assertFits(singleCallLines("role", args, width, theme), width);
	}
});

// ---------------------------------------------------------------------------
// Narrow-width hardening: the pure builders clamp to every width from 1 up
// ---------------------------------------------------------------------------

test("every card builder respects widths 1..24", () => {
	const narrow: SingleDetails = {
		...streamDetails,
		lastActivityAt: Date.now() - 200_000,
		toolStartedAt: Date.now() - 3_000,
		outputTail: ["a fairly long output line that will not fit"],
		tokens: 4_240_000,
		turns: 42,
	};
	const builders: Array<[string, (w: number) => string[]]> = [
		["singleCallLines", (w) => singleCallLines("code", { prompt: "x".repeat(400), workspace: "E:/dev/pi-agy" }, w, theme)],
		["singleActivityLines", (w) => singleActivityLines("code", narrow, w, theme)],
		["singleResultLines", (w) => singleResultLines("code", { ...doneDetails, ...narrow, warnings: ["w"], response: "y".repeat(2000) }, w, theme, false)],
		["fleetCallLines", (w) => fleetCallLines({ tasks: [{ id: "a", task: "t".repeat(200) }], concurrency: 3 }, w, theme)],
		["fleetBoardLines", (w) => fleetBoardLines(fleetDetails, w, theme)],
		["fleetResultLines", (w) => fleetResultLines({ ...fleetDetails, succeeded: 1, failed: 1 }, w, theme, false)],
	];
	for (const [name, build] of builders) {
		for (let w = 1; w <= 24; w++) {
			assertFits(build(w), w);
		}
	}
});
