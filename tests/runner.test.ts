import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { buildAgyArgs, extractOutputTail, runAgy, splitExistingFiles } from "../src/runner.ts";
import type { LiveActivity } from "../src/status.ts";

/** The arguments that follow `--add-dir`, in order. */
function addDirs(args: string[]): string[] {
	const out: string[] = [];
	args.forEach((a, i) => {
		if (a === "--add-dir") out.push(args[i + 1]!);
	});
	return out;
}

function base(over: Partial<Parameters<typeof buildAgyArgs>[0]> = {}) {
	return buildAgyArgs({
		prompt: "do it",
		workspace: "/ws",
		model: "gemini-3.8-flash-high",
		effort: "high",
		allowCommands: false,
		timeout: "5m",
		...over,
	});
}

test("buildAgyArgs always registers the workspace", () => {
	assert.deepEqual(addDirs(base()), ["/ws"]);
});

test("buildAgyArgs registers extra image directories (repeatable --add-dir)", () => {
	const args = base({ addDirs: ["/tmp/stage-a", "/tmp/stage-b"] });
	assert.deepEqual(addDirs(args), ["/ws", "/tmp/stage-a", "/tmp/stage-b"]);
});

test("buildAgyArgs does not duplicate the workspace or blank add-dirs", () => {
	const args = base({ addDirs: ["/ws", "", "/tmp/stage-a", "/tmp/stage-a"] });
	assert.deepEqual(addDirs(args), ["/ws", "/tmp/stage-a"]);
});

test("buildAgyArgs gates shell access behind allowCommands", () => {
	assert.ok(!base({ allowCommands: false }).includes("--dangerously-skip-permissions"));
	assert.ok(base({ allowCommands: true }).includes("--dangerously-skip-permissions"));
});

test("buildAgyArgs keeps the gemini model slug and effort consistent", () => {
	const args = base({ model: "gemini-3.8-flash-medium", effort: "high" });
	assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-high");
	assert.equal(args[args.indexOf("--effort") + 1], "high");
});

test("buildAgyArgs resumes an explicit conversation and only uses --continue otherwise", () => {
	const explicit = base({ conversation: "conv-1", continueConv: true });
	assert.equal(explicit[explicit.indexOf("--conversation") + 1], "conv-1");
	assert.ok(!explicit.includes("--continue"));

	const fresh = base({ continueConv: false });
	assert.ok(!fresh.includes("--continue") && !fresh.includes("--conversation"));
});

// ---------------------------------------------------------------------------
// Evidence verification: agy reports a permission-DENIED write_to_file with step
// state DONE and overall status SUCCESS, so the only trustworthy check is the
// filesystem. These tests pin that contract.
// ---------------------------------------------------------------------------

test("splitExistingFiles keeps real files and drops phantom ones", () => {
	const workspace = resolve("/ws");
	const real = resolve(workspace, "src/real.ts");
	const never = resolve(workspace, "never.ts");
	const { existing, missing } = splitExistingFiles(
		["src/real.ts", real, "src/denied.ts", never],
		workspace,
		(p) => p === real
	);
	assert.equal(existing.length, 2, "both the relative and absolute spelling of the real file count");
	assert.ok(existing.includes("src/real.ts") && existing.includes(real));
	assert.equal(missing.length, 2);
	// The returned entries keep the caller's original spelling.
	assert.ok(missing.includes("src/denied.ts") && missing.includes(never));
});

test("splitExistingFiles resolves relative paths against the workspace", () => {
	const workspace = resolve("E:/dev/proj");
	const seen: string[] = [];
	splitExistingFiles(["a/b.ts"], workspace, (p) => {
		seen.push(p);
		return true;
	});
	assert.deepEqual(seen, [resolve(workspace, "a/b.ts")], "relative claims must be checked inside the workspace");
});

test("splitExistingFiles reports a denied write as missing, never as evidence", () => {
	// The exact shape agy produced when a write was permission-denied: step state
	// DONE, status SUCCESS, but no file on disk.
	const claimed = resolve("E:/dev/pi-agy/.agy-review/registry.md");
	const { existing, missing } = splitExistingFiles([claimed, ""], resolve("E:/dev/pi-agy"), () => false);
	assert.deepEqual(existing, []);
	assert.deepEqual(missing, [claimed]);
});

// ---------------------------------------------------------------------------
// LiveActivity field derivation (§4.6)
// ---------------------------------------------------------------------------

function createMockChild() {
	const child = new EventEmitter() as any;
	child.stdout = new EventEmitter() as any;
	child.stdout.setEncoding = () => {};
	child.stderr = new EventEmitter() as any;
	child.stderr.setEncoding = () => {};
	child.kill = () => {
		child.emit("close", 0);
		return true;
	};
	return child;
}

function emitLine(child: any, obj: Record<string, unknown>) {
	child.stdout.emit("data", JSON.stringify(obj) + "\n");
}

test("extractOutputTail drops blanks, trims lines, and bounds to max 8 newest-last", () => {
	assert.deepEqual(extractOutputTail(""), []);
	assert.deepEqual(extractOutputTail("   \n\n\t  \n"), []);
	assert.deepEqual(extractOutputTail("hello\nworld"), ["hello", "world"]);
	assert.deepEqual(extractOutputTail("  first  \n\n  second  \r\n  third  "), ["first", "second", "third"]);

	const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
	const tail = extractOutputTail(tenLines);
	assert.equal(tail.length, 8);
	assert.deepEqual(tail, [
		"line 3",
		"line 4",
		"line 5",
		"line 6",
		"line 7",
		"line 8",
		"line 9",
		"line 10",
	]);
	assert.deepEqual(extractOutputTail("a\nb\nc", 2), ["b", "c"]);
});

test("runAgy sets lastActivityAt on step_update and inside pushStream", async () => {
	const child = createMockChild();
	const activities: LiveActivity[] = [];
	const updates: any[] = [];
	const before = Date.now();

	const runPromise = runAgy({
		prompt: "test prompt",
		workspace: resolve("E:/dev/pi-agy"),
		allowCommands: true,
		timeout: "1m",
		continueConv: false,
		spawnChild: () => child,
		onActivity: (live) => activities.push({ ...live }),
		onUpdate: (update) => updates.push(update),
	});

	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 0,
			step_type: "tool",
			state: "ACTIVE",
			tool_info: { name: "read_file", parameters: { TargetFile: "src/index.ts" } },
		},
	});

	assert.ok(activities.length > 0);
	const last = activities[activities.length - 1]!;
	assert.ok(typeof last.lastActivityAt === "number");
	assert.ok(last.lastActivityAt >= before && last.lastActivityAt <= Date.now() + 100);

	assert.ok(updates.length > 0);
	const update = updates[updates.length - 1]!;
	assert.equal(update.details.lastActivityAt, last.lastActivityAt);

	child.emit("close", 0);
	await runPromise;
});

test("runAgy sets toolStartedAt when tool is ACTIVE and clears it on terminal state", async () => {
	const child = createMockChild();
	const activities: LiveActivity[] = [];
	const updates: any[] = [];
	const before = Date.now();

	const runPromise = runAgy({
		prompt: "test toolStartedAt",
		workspace: resolve("E:/dev/pi-agy"),
		allowCommands: true,
		timeout: "1m",
		continueConv: false,
		spawnChild: () => child,
		onActivity: (live) => activities.push({ ...live }),
		onUpdate: (update) => updates.push(update),
	});

	// Tool ACTIVE
	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 1,
			step_type: "tool",
			state: "ACTIVE",
			tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } },
		},
	});

	const activeLive = activities[activities.length - 1]!;
	assert.ok(typeof activeLive.toolStartedAt === "number");
	assert.ok(activeLive.toolStartedAt >= before && activeLive.toolStartedAt <= Date.now() + 100);
	assert.equal(updates[updates.length - 1]?.details.toolStartedAt, activeLive.toolStartedAt);

	// Tool terminal DONE
	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 1,
			step_type: "tool",
			state: "DONE",
			tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } },
		},
	});

	const terminalLive = activities[activities.length - 1]!;
	assert.equal(terminalLive.toolStartedAt, undefined);
	assert.equal("toolStartedAt" in updates[updates.length - 1]?.details, false);

	child.emit("close", 0);
	await runPromise;
});

test("runAgy derives outputTail bounded to 8 newest-last lines from stepText", async () => {
	const child = createMockChild();
	const activities: LiveActivity[] = [];
	const updates: any[] = [];

	const runPromise = runAgy({
		prompt: "test outputTail",
		workspace: resolve("E:/dev/pi-agy"),
		allowCommands: true,
		timeout: "1m",
		continueConv: false,
		spawnChild: () => child,
		onActivity: (live) => activities.push({ ...live }),
		onUpdate: (update) => updates.push(update),
	});

	const lines = [
		"First line",
		"",
		"Second line",
		"Third line",
		"Fourth line",
		"Fifth line",
		"Sixth line",
		"Seventh line",
		"Eighth line",
		"Ninth line",
		"Tenth line",
	].join("\n");

	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 0,
			step_type: "agent_response",
			text_delta: lines,
		},
	});

	// Trigger a synchronous pushStream via ACTIVE tool step
	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 1,
			step_type: "tool",
			state: "ACTIVE",
			tool_info: { name: "view_file", parameters: { FilePath: "a.ts" } },
		},
	});

	const last = activities[activities.length - 1]!;
	assert.ok(Array.isArray(last.outputTail));
	assert.equal(last.outputTail.length, 8);
	assert.deepEqual(last.outputTail, [
		"Third line",
		"Fourth line",
		"Fifth line",
		"Sixth line",
		"Seventh line",
		"Eighth line",
		"Ninth line",
		"Tenth line",
	]);

	const update = updates[updates.length - 1]!;
	assert.deepEqual(update.details.outputTail, last.outputTail);

	child.emit("close", 0);
	await runPromise;
});

test("runAgy populates tokens and turns when reported by stream or result", async () => {
	const child = createMockChild();
	const activities: LiveActivity[] = [];

	const runPromise = runAgy({
		prompt: "test metrics",
		workspace: resolve("E:/dev/pi-agy"),
		allowCommands: true,
		timeout: "1m",
		continueConv: false,
		spawnChild: () => child,
		onActivity: (live) => activities.push({ ...live }),
	});

	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 0,
			step_type: "agent_response",
			text_delta: "hello",
			usage: { total_tokens: 1250 },
			num_turns: 2,
		},
	});

	emitLine(child, {
		event: "result",
		result: {
			status: "SUCCESS",
			conversation_id: "conv-1",
			response: "hello",
			usage: { total_tokens: 4200 },
			num_turns: 5,
		},
	});

	child.emit("close", 0);
	const res = await runPromise;
	assert.equal(res.status, "SUCCESS");

	const finalLive = activities[activities.length - 1]!;
	assert.equal(finalLive.tokens, 4200);
	assert.equal(finalLive.turns, 5);
});

test("runAgy leaves tokens and turns undefined when not reported", async () => {
	const child = createMockChild();
	const activities: LiveActivity[] = [];

	const runPromise = runAgy({
		prompt: "test no metrics",
		workspace: resolve("E:/dev/pi-agy"),
		allowCommands: true,
		timeout: "1m",
		continueConv: false,
		spawnChild: () => child,
		onActivity: (live) => activities.push({ ...live }),
	});

	emitLine(child, {
		event: "step_update",
		step_update: {
			step_index: 0,
			step_type: "agent_response",
			text_delta: "plain response without usage",
		},
	});

	emitLine(child, {
		event: "result",
		result: {
			status: "SUCCESS",
			conversation_id: "conv-2",
			response: "plain response without usage",
		},
	});

	child.emit("close", 0);
	await runPromise;

	const finalLive = activities[activities.length - 1]!;
	assert.equal(finalLive.tokens, undefined);
	assert.equal(finalLive.turns, undefined);
});


// ---------------------------------------------------------------------------
// extractRecentTail (bounded window over the growing live buffer)
// ---------------------------------------------------------------------------

test("extractRecentTail bounds the scan window and drops a partial first line", async () => {
	const { extractOutputTail, extractRecentTail } = await import("../src/runner.ts");

	assert.deepEqual(extractRecentTail("", 8), []);
	assert.deepEqual(extractRecentTail("one\ntwo\nthree", 8), ["one", "two", "three"]);
	// Newest-last and capped.
	assert.deepEqual(extractRecentTail("a\nb\nc\nd", 2), ["c", "d"]);

	// A buffer longer than the window: only the window is scanned, and the
	// first (mid-line) fragment after the cut is not surfaced.
	const filler = "x".repeat(500) + "\n";
	const text = filler.repeat(20) + "tail-line-1\ntail-line-2";
	const windowed = extractRecentTail(text, 8, 4000);
	assert.deepEqual(windowed.slice(-2), ["tail-line-1", "tail-line-2"]);
	assert.ok(windowed.every((line) => line.length <= 4000), "windowed lines stay bounded");

	// Identical to the unbounded helper when the buffer already fits.
	assert.deepEqual(extractRecentTail("one\ntwo", 8, 4000), extractOutputTail("one\ntwo", 8));
});
