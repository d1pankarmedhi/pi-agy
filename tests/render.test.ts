import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	fleetBoardLines,
	fleetCallLines,
	fleetRenderers,
	fleetResultLines,
	singleActivityLines,
	singleCallLines,
	singleRenderers,
	singleResultLines,
	type AgyMeta,
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
	preset: "explore",
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

// ---------------------------------------------------------------------------
// Single-run cards
// ---------------------------------------------------------------------------

test("singleCallLines shows title, config meta, and prompt", () => {
	const lines = singleCallLines(
		"explore",
		{ prompt: "Map the modules in src/", model: "gemini-3.8-flash-high", effort: "high", timeout: "10m", workspace: "ws" },
		96,
		theme
	);
	const text = lines.join("\n");
	assert.match(text, /agy_explore/);
	assert.match(text, /read-only/);
	assert.match(text, /gemini-3\.8-flash-high/);
	assert.match(text, /Map the modules in src\//);
});

test("singleActivityLines shows live step, target, elapsed, and recent trail", () => {
	const lines = singleActivityLines("explore", streamDetails, 96, theme);
	const text = lines.join("\n");
	assert.match(text, /step 50/);
	assert.match(text, /contradiction\.ts/);
	assert.match(text, /1m 39s/);
	assert.match(text, /npm run typecheck/);
	assert.match(text, /schema\.ts/);
	assert.match(text, /▤/);
});

test("singleResultLines summarizes metrics, response, evidence, and run log", () => {
	const collapsed = singleResultLines("explore", doneDetails, 96, theme, false).join("\n");
	assert.match(collapsed, /steps 50/);
	assert.match(collapsed, /files 2/);
	assert.match(collapsed, /tokens 48k/);
	assert.match(collapsed, /run log/);
	assert.match(collapsed, /Ctrl\+O to expand/);
	assert.match(collapsed, /worker\/src\/lib\/contradiction\.ts/);

	const expanded = singleResultLines("explore", doneDetails, 96, theme, true).join("\n");
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
		assertFits(at((w) => singleCallLines("explore", { prompt: "a".repeat(400), workspace: "C:/very/long/workspace/path/here", model: "gemini-3.8-flash-high" }, w, theme), width), width);
		assertFits(at((w) => singleActivityLines("explore", streamDetails, w, theme), width), width);
		assertFits(at((w) => singleResultLines("explore", doneDetails, w, theme, false), width), width);
		assertFits(at((w) => singleResultLines("explore", doneDetails, w, theme, true), width), width);
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
