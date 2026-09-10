import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgyArgs } from "../src/runner.ts";

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
