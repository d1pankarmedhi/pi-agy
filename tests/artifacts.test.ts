import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearAllReports,
	clearReports,
	formatBytes,
	formatFleetReport,
	formatLaneDoc,
	listAllReports,
	listReports,
	newFleetId,
	newReportId,
	parseAge,
	pruneReports,
	reportRoots,
	resolveFleetOutput,
	resolveRunOutput,
	writeFleetArtifacts,
	writeFleetReportFile,
	writeRunReport,
	type ArtifactLane,
	type FleetMeta,
} from "../src/artifacts.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-agy-artifacts-"));
}

const META: FleetMeta = {
	fleetId: "fleet-20250101-120000-abcd",
	cwd: "/work/project",
	concurrency: 2,
	aborted: false,
	startedAt: Date.parse("2025-01-01T12:00:00.000Z"),
	finishedAt: Date.parse("2025-01-01T12:00:42.000Z"),
};

function lane(patch: Partial<ArtifactLane> = {}): ArtifactLane {
	return {
		id: "t1",
		task: "Summarize the auth module",
		workspace: "/work/project",
		status: "done",
		startedAt: META.startedAt,
		endedAt: META.finishedAt,
		result: {
			status: "SUCCESS",
			conversation_id: "conv-1",
			response: "# Auth\n\nToken refresh lives in `refresh.ts`.",
			num_turns: 7,
			duration_seconds: 42,
			tool_steps: 3,
			usage: { total_tokens: 12_345 },
			files_written: ["src/auth/refresh.ts"],
			commands_run: ["npm test -- auth"],
			steps: [
				{ index: 1, tool: "read_file", file: "src/auth/index.ts", state: "done" },
				{ index: 2, tool: "run_command", command: "npm test -- auth", state: "done" },
				{ index: 3, tool: "write_to_file", file: "src/auth/refresh.ts", state: "done" },
			],
		},
		...patch,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("formatLaneDoc keeps the full response, evidence, warnings and provenance", () => {
	const target = lane({
		role: "scout",
		model: "gemini-3.1-pro",
		effort: "high",
		result: {
			...lane().result!,
			warnings: ["3 files the agent reported writing do not exist on disk"],
			denied_actions: [{ action: "write_to_file" }],
		},
	});
	const doc = formatLaneDoc(target, META);

	assert.match(doc, /^---\n/);
	assert.match(doc, /\nlane: "t1"/);
	assert.match(doc, /\nrole: "scout"/);
	assert.match(doc, /\nmodel: "gemini-3\.1-pro"/);
	assert.match(doc, /\nconversation_id: "conv-1"/);
	assert.match(doc, /\nfiles_written: \["src\/auth\/refresh\.ts"\]/);
	assert.match(doc, /\nduration_seconds: 42\.0/);
	assert.match(doc, /### Task\n\n> Summarize the auth module/);
	assert.match(doc, /### Deliverable\n\n# Auth\n\nToken refresh lives in `refresh\.ts`\./);
	assert.match(doc, /### Evidence[\s\S]*file: `src\/auth\/refresh\.ts`/);
	assert.match(doc, /### Caveats[\s\S]*denied write_to_file/);
	// Full paths in the run log — this is a document, not a status line.
	assert.match(doc, /✓ 2\. run_command · `npm test -- auth`/);
});

test("formatLaneDoc does not truncate a long response", () => {
	const long = "x".repeat(9000);
	const doc = formatLaneDoc(lane({ result: { ...lane().result!, response: long } }), META);
	assert.ok(doc.includes(long), "the full response must survive into the report");
});

test("formatLaneDoc reports failures with their error and partial output", () => {
	const doc = formatLaneDoc(
		lane({ status: "failed", error: "agy exited with code 2", result: { ...lane().result!, response: "half done" } }),
		META
	);
	assert.match(doc, /### Failure\n\n`failed` — agy exited with code 2/);
	assert.match(doc, /Partial output before the failure:\n\nhalf done/);
	assert.ok(!doc.includes("### Deliverable"));
});

test("formatFleetReport is self-contained: summary table plus every lane", () => {
	const report = formatFleetReport(META, [
		lane(),
		lane({ id: "t2", status: "failed", error: "boom", result: undefined, role: "reviewer" }),
	]);
	assert.match(report, /^# agy_fleet — 1\/2 lanes succeeded/);
	assert.match(report, /\| lane \| status \| role \| model \|/);
	assert.match(report, /\| t1 \| done \|/);
	assert.match(report, /\| t2 \| failed \| reviewer \|/);
	assert.match(report, /## \[t1\] done/);
	assert.match(report, /## \[t2\] failed/);
	assert.match(report, /Token refresh lives in `refresh\.ts`/);
	// Markdown table cells must not carry newlines.
	const tableRow = report.split("\n").find((l) => l.startsWith("| t1 |"))!;
	assert.ok(!tableRow.includes("\n"));
});

test("table cells escape pipes", () => {
	const report = formatFleetReport(META, [lane({ id: "a|b" })]);
	assert.ok(report.includes("| a\\|b |"), report);
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test("writeFleetArtifacts writes report.md, manifest.json and one file per lane", () => {
	const root = tempRoot();
	try {
		const out = writeFleetArtifacts({
			root,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 2,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane(), lane({ id: "t2", task: "Review the tests" })],
			now: META.finishedAt,
		});

		assert.deepEqual(out.warnings, []);
		assert.ok(out.bytes > 0);
		assert.ok(existsSync(out.report));
		assert.ok(existsSync(out.manifest));
		assert.equal(readdirSync(join(out.dir, "lanes")).length, 2);

		const manifest = JSON.parse(readFileSync(out.manifest, "utf8"));
		assert.equal(manifest.schemaVersion, 1);
		assert.equal(manifest.fleetId, META.fleetId);
		assert.equal(manifest.totals.lanes, 2);
		assert.equal(manifest.lanes[0].file, "t1.md");
		assert.equal(manifest.lanes[0].conversation_id, "conv-1");
		assert.equal(manifest.lanes[1].task, "Review the tests");
		assert.match(readFileSync(out.lanes.t1!, "utf8"), /# \[t1\] done/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lane ids are made filesystem-safe and stay unique", () => {
	const root = tempRoot();
	try {
		const out = writeFleetArtifacts({
			root,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane({ id: "../../etc/passwd" }), lane({ id: "etc passwd" }), lane({ id: "t1" })],
		});
		const files = readdirSync(join(out.dir, "lanes")).sort();
		assert.deepEqual(files, ["etc-passwd-2.md", "etc-passwd.md", "t1.md"]);
		// Nothing escaped the fleet directory.
		assert.ok(!existsSync(join(root, "etc")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeFleetArtifacts never throws: a bad root becomes a warning", () => {
	const root = tempRoot();
	try {
		const blocked = join(root, "file-not-dir");
		writeFileSync(blocked, "x");
		const out = writeFleetArtifacts({
			root: blocked,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane()],
		});
		assert.equal(out.bytes, 0);
		assert.equal(out.warnings.length, 1);
		assert.match(out.warnings[0]!, /could not write the fleet report/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the default report root ignores itself in git", () => {
	const root = tempRoot();
	try {
		const out = writeFleetArtifacts({
			root,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane()],
			selfIgnore: true,
		});
		assert.equal(readFileSync(join(out.dir, "..", ".gitignore"), "utf8"), "*\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a user-chosen directory gets no .gitignore", () => {
	const root = tempRoot();
	try {
		writeFleetArtifacts({
			root,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane()],
		});
		assert.ok(!existsSync(join(root, ".gitignore")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("single-file mode writes the combined document plus a manifest", () => {
	const root = tempRoot();
	try {
		const file = join(root, "nested", "fleet-run.md");
		const out = writeFleetReportFile(file, META, [lane()], META.finishedAt);
		assert.deepEqual(out.warnings, []);
		assert.ok(readFileSync(file, "utf8").startsWith("# agy_fleet — 1/1 lanes succeeded"));
		assert.equal(out.manifest, join(root, "nested", "fleet-run.manifest.json"));
		assert.equal(JSON.parse(readFileSync(out.manifest, "utf8")).totals.done, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Retention and cleanup
// ---------------------------------------------------------------------------

test("writeFleetArtifacts prunes older fleets but keeps the one it just wrote", () => {
	const root = tempRoot();
	try {
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			const id = newFleetId(Date.parse("2025-01-01T12:00:00Z") + i * 60_000, `a${i}bc`);
			ids.push(id);
			writeFleetArtifacts({
				root,
				fleetId: id,
				cwd: META.cwd,
				concurrency: 1,
				aborted: false,
				startedAt: META.startedAt,
				lanes: [lane()],
				keep: 2,
			});
		}
		const remaining = listReports(root).map((f) => f.id);
		assert.deepEqual(remaining, [ids[3], ids[2]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pruneReports honours maxAgeDays", () => {
	const root = tempRoot();
	try {
		const old = newFleetId(Date.parse("2020-01-01T00:00:00Z"), "old0");
		const fresh = newFleetId(Date.parse("2025-01-01T00:00:00Z"), "new0");
		for (const id of [old, fresh]) {
			writeFleetArtifacts({ root, fleetId: id, cwd: META.cwd, concurrency: 1, aborted: false, startedAt: 0, lanes: [lane()] });
		}
		const removed = pruneReports({ root, maxAgeDays: 30, now: Date.parse("2025-01-02T00:00:00Z") });
		assert.deepEqual(removed, [old]);
		assert.deepEqual(listReports(root).map((f) => f.id), [fresh]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clearReports refuses to run without a selector", () => {
	const root = tempRoot();
	try {
		assert.throws(() => clearReports({ root }), /pick what to clear/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clearReports clears everything with all, and reports freed bytes", () => {
	const root = tempRoot();
	try {
		const ids = [newFleetId(1, "aaaa"), newFleetId(2, "bbbb")];
		for (const id of ids) {
			writeFleetArtifacts({ root, fleetId: id, cwd: META.cwd, concurrency: 1, aborted: false, startedAt: 0, lanes: [lane()] });
		}
		const result = clearReports({ root, all: true });
		assert.equal(result.removed.length, 2);
		assert.ok(result.bytes > 0);
		assert.deepEqual(listReports(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clearReports with keep removes only the oldest", () => {
	const root = tempRoot();
	try {
		const ids = [1, 2, 3].map((n) => newFleetId(n * 1000, `z00${n}`));
		for (const id of ids) {
			writeFleetArtifacts({ root, fleetId: id, cwd: META.cwd, concurrency: 1, aborted: false, startedAt: 0, lanes: [lane()] });
		}
		const result = clearReports({ root, keep: 1 });
		assert.deepEqual(result.removed.map((f) => f.id).sort(), [ids[0], ids[1]].sort());
		assert.deepEqual(listReports(root).map((f) => f.id), [ids[2]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clearReports dryRun deletes nothing", () => {
	const root = tempRoot();
	try {
		const id = newFleetId(1, "aaaa");
		writeFleetArtifacts({ root, fleetId: id, cwd: META.cwd, concurrency: 1, aborted: false, startedAt: 0, lanes: [lane()] });
		const result = clearReports({ root, all: true, dryRun: true });
		assert.equal(result.dryRun, true);
		assert.equal(result.removed.length, 1);
		assert.deepEqual(listReports(root).map((f) => f.id), [id]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("clearReports never touches files outside the report root or non-report entries", () => {
	const root = tempRoot();
	const outside = tempRoot();
	try {
		mkdirSync(join(root, "notes"), { recursive: true });
		writeFileSync(join(root, "notes", "keep.md"), "keep");
		writeFileSync(join(root, "manifest.json"), "{}");
		const outsideId = newFleetId(1, "aaaa");
		mkdirSync(join(outside, outsideId), { recursive: true });
		writeFileSync(join(outside, outsideId, "report.md"), "far away");

		const result = clearReports({ root, all: true });
		assert.equal(result.removed.length, 0);
		assert.ok(existsSync(join(root, "notes", "keep.md")));
		assert.ok(existsSync(join(root, "manifest.json")));
		assert.ok(existsSync(join(outside, outsideId, "report.md")));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("clearReports rejects an unknown report id instead of guessing", () => {
	const root = tempRoot();
	try {
		assert.throws(() => clearReports({ root, ids: ["fleet-20200101-000000-zzzz"] }), /no report matched/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Targets and helpers
// ---------------------------------------------------------------------------

test("resolveFleetOutput maps true/false/paths to a target", () => {
	assert.deepEqual(resolveFleetOutput(false, "/w", ".agy/fleet"), { mode: "off" });
	assert.deepEqual(resolveFleetOutput("off", "/w", ".agy/fleet"), { mode: "off" });
	assert.deepEqual(resolveFleetOutput(true, "/w", ".agy/fleet"), { mode: "dir", dir: "/w/.agy/fleet" });
	assert.deepEqual(resolveFleetOutput(undefined, "/w", ".agy/fleet"), { mode: "dir", dir: "/w/.agy/fleet" });
	assert.deepEqual(resolveFleetOutput(" reports ", "/w", ".agy/fleet"), { mode: "dir", dir: "/w/reports" });
	assert.deepEqual(resolveFleetOutput("docs/out.md", "/w", ".agy/fleet"), { mode: "file", file: "/w/docs/out.md" });
});

test("newFleetId matches the cleanup naming scheme", () => {
	assert.match(newFleetId(), /^fleet-\d{8}-\d{6}-[a-z0-9]{4}$/);
	// The timestamp is local time; only the sanitized suffix needs pinning.
	assert.match(newFleetId(Date.parse("2025-03-04T05:06:07Z"), "AB!/"), /^fleet-\d{8}-\d{6}-ab00$/);
});

test("parseAge reads day/hour/minute durations", () => {
	assert.equal(parseAge("7d"), 7);
	assert.equal(parseAge("36h"), 1.5);
	assert.equal(parseAge("1d"), 1);
	assert.equal(parseAge(undefined), undefined);
	assert.equal(parseAge("soon"), undefined);
});

test("formatBytes stays readable", () => {
	assert.equal(formatBytes(12), "12 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.equal(formatBytes(3.5 * 1024 * 1024), "3.5 MB");
});

test("a colliding fleet id gets a fresh directory instead of overwriting another report", () => {
	const root = tempRoot();
	try {
		const first = writeFleetArtifacts({
			root,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane({ id: "first" })],
			now: META.finishedAt,
		});
		const second = writeFleetArtifacts({
			root,
			fleetId: META.fleetId,
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: META.startedAt,
			lanes: [lane({ id: "second" })],
			now: META.finishedAt,
		});
		assert.notEqual(second.fleetId, first.fleetId);
		assert.match(second.fleetId, /^fleet-\d{8}-\d{6}-[a-z0-9]{4}$/);
		assert.equal(listReports(root).length, 2);
		assert.match(readFileSync(join(first.dir, "lanes", "first.md"), "utf8"), /lane: "first"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Single-run reports
// ---------------------------------------------------------------------------

test("resolveRunOutput is opt-in: omitted means no file", () => {
	assert.deepEqual(resolveRunOutput(undefined, "/w", ".agy/runs"), { mode: "off" });
	assert.deepEqual(resolveRunOutput(false, "/w", ".agy/runs"), { mode: "off" });
	assert.deepEqual(resolveRunOutput(true, "/w", ".agy/runs"), { mode: "dir", dir: "/w/.agy/runs" });
	assert.deepEqual(resolveRunOutput(" out ", "/w", ".agy/runs"), { mode: "dir", dir: "/w/out" });
	assert.deepEqual(resolveRunOutput("out/run.md", "/w", ".agy/runs"), { mode: "file", file: "/w/out/run.md" });
});

test("reportRoots skips disabled and single-file configurations", () => {
	assert.deepEqual(reportRoots("/w", ".agy/fleet", ".agy/runs"), ["/w/.agy/fleet", "/w/.agy/runs"]);
	assert.deepEqual(reportRoots("/w", "off", ".agy/runs"), ["/w/.agy/runs"]);
	assert.deepEqual(reportRoots("/w", "report.md", ".agy/runs"), ["/w/.agy/runs"]);
	assert.deepEqual(reportRoots("/w", ".agy/fleet", ".agy/fleet"), ["/w/.agy/fleet"]);
	assert.deepEqual(reportRoots("/w", "off", "off"), []);
});

test("writeRunReport writes report.md + manifest.json and no lane directory", () => {
	const root = tempRoot();
	try {
		const out = writeRunReport({
			root,
			runId: "run-20250101-120000-abcd",
			preset: "agy_role · reviewer",
			cwd: META.cwd,
			lane: lane({ id: "agy_role · reviewer", role: "reviewer" }),
			now: META.finishedAt,
		});
		assert.deepEqual(out.warnings, []);
		assert.ok(out.bytes > 0);
		assert.deepEqual(readdirSync(out.dir).sort(), ["manifest.json", "report.md"]);

		const report = readFileSync(out.report, "utf8");
		assert.match(report, /^---\nkind: "run"\nlane: "agy_role · reviewer"\nrun: "run-20250101-120000-abcd"/);
		assert.match(report, /### Deliverable\n\n# Auth/);

		const manifest = JSON.parse(readFileSync(out.manifest, "utf8"));
		assert.equal(manifest.kind, "run");
		assert.equal(manifest.preset, "agy_role · reviewer");
		assert.equal(manifest.totals.done, 1);
		assert.equal(listReports(root)[0]!.kind, "run");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeRunReport never throws and prunes older runs", () => {
	const root = tempRoot();
	try {
		for (let i = 0; i < 3; i++) {
			writeRunReport({
				root,
				runId: newReportId("run", Date.parse("2025-01-01T12:00:00Z") + i * 60_000, `r00${i}`),
				preset: "agy",
				cwd: META.cwd,
				lane: lane(),
				keep: 1,
			});
		}
		assert.equal(listReports(root).length, 1);

		const blocked = join(root, "file-not-dir");
		writeFileSync(blocked, "x");
		const failed = writeRunReport({ root: blocked, runId: "run-20250101-120000-abcd", preset: "agy", cwd: META.cwd, lane: lane() });
		assert.equal(failed.bytes, 0);
		assert.match(failed.warnings[0]!, /could not write the run report/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listAllReports and clearAllReports work across the fleet and run roots", () => {
	const fleetRoot = tempRoot();
	const runRoot = tempRoot();
	try {
		writeFleetArtifacts({
			root: fleetRoot,
			fleetId: "fleet-20250101-120000-aaaa",
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: 0,
			lanes: [lane()],
		});
		writeRunReport({ root: runRoot, runId: "run-20250101-120000-bbbb", preset: "agy", cwd: META.cwd, lane: lane() });

		const all = listAllReports([fleetRoot, runRoot]);
		assert.deepEqual(all.map((r) => r.kind).sort(), ["fleet", "run"]);
		assert.equal(new Set(all.map((r) => r.root)).size, 2);

		const cleared = clearAllReports([fleetRoot, runRoot], { all: true });
		assert.equal(cleared.removed.length, 2);
		assert.deepEqual(listAllReports([fleetRoot, runRoot]), []);
	} finally {
		rmSync(fleetRoot, { recursive: true, force: true });
		rmSync(runRoot, { recursive: true, force: true });
	}
});

test("clearAllReports finds an id in either root and still needs a selector", () => {
	const fleetRoot = tempRoot();
	const runRoot = tempRoot();
	try {
		writeFleetArtifacts({
			root: fleetRoot,
			fleetId: "fleet-20250101-120000-aaaa",
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: 0,
			lanes: [lane()],
		});
		writeRunReport({ root: runRoot, runId: "run-20250101-120000-bbbb", preset: "agy", cwd: META.cwd, lane: lane() });

		const cleared = clearAllReports([fleetRoot, runRoot], { ids: ["run-20250101-120000-bbbb"] });
		assert.deepEqual(cleared.removed.map((r) => r.id), ["run-20250101-120000-bbbb"]);
		assert.equal(listAllReports([fleetRoot, runRoot]).length, 1);

		assert.throws(() => clearAllReports([fleetRoot, runRoot], {}), /pick what to clear/);
		assert.throws(
			() => clearAllReports([fleetRoot, runRoot], { ids: ["run-20990101-000000-zzzz"] }),
			/no report matched/
		);
	} finally {
		rmSync(fleetRoot, { recursive: true, force: true });
		rmSync(runRoot, { recursive: true, force: true });
	}
});

test("a fleet and a run with the same suffix live side by side", () => {
	const root = tempRoot();
	try {
		writeFleetArtifacts({
			root,
			fleetId: "fleet-20250101-120000-aaaa",
			cwd: META.cwd,
			concurrency: 1,
			aborted: false,
			startedAt: 0,
			lanes: [lane()],
		});
		writeRunReport({ root, runId: "run-20250101-120000-aaaa", preset: "agy", cwd: META.cwd, lane: lane() });
		assert.deepEqual(listReports(root).map((r) => r.kind).sort(), ["fleet", "run"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
