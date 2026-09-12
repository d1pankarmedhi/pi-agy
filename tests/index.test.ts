import { test } from "node:test";
import assert from "node:assert/strict";
import extension, { matchEffort } from "../index.ts";

test("matchEffort rewrites gemini slugs to the requested effort", () => {
	assert.equal(matchEffort("gemini-3.8-flash-medium", "high"), "gemini-3.8-flash-high");
	assert.equal(matchEffort("gemini-3.8-flash-high", "high"), "gemini-3.8-flash-high");
	assert.equal(matchEffort("gemini-3.1-pro-high", "low"), "gemini-3.1-pro-low");
});

test("matchEffort leaves already-matching slugs unchanged", () => {
	assert.equal(matchEffort("gemini-3.8-flash-high", "high"), "gemini-3.8-flash-high");
});

test("matchEffort leaves non-gemini models unchanged", () => {
	assert.equal(matchEffort("claude-sonnet-4-6", "high"), "claude-sonnet-4-6");
	assert.equal(matchEffort("gpt-oss-120b-medium", "high"), "gpt-oss-120b-medium");
});

test("matchEffort with no effort returns the model unchanged", () => {
	assert.equal(matchEffort("gemini-3.8-flash-medium", undefined), "gemini-3.8-flash-medium");
});

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

interface StubTool {
	name: string;
	renderCall?: unknown;
	renderResult?: unknown;
	execute?: unknown;
}

type StubHandler = (...args: any[]) => any;

function registerWithStub() {
	const tools = new Map<string, StubTool>();
	const handlers = new Map<string, StubHandler>();
	const commands = new Map<string, unknown>();
	const api = {
		registerTool: (tool: StubTool) => tools.set(tool.name, tool),
		on: (event: string, handler: StubHandler) => handlers.set(event, handler),
		registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
	};
	extension(api as never);
	return { tools, handlers, commands };
}

test("the extension registers all five agy tools with custom TUI cards", () => {
	const { tools } = registerWithStub();
	for (const name of ["agy", "agy_code", "agy_vision", "agy_role", "agy_fleet"]) {
		const tool = tools.get(name);
		assert.ok(tool, `tool ${name} was not registered`);
		assert.equal(typeof tool!.execute, "function", `${name} needs execute`);
		assert.equal(typeof tool!.renderCall, "function", `${name} needs renderCall`);
		assert.equal(typeof tool!.renderResult, "function", `${name} needs renderResult`);
	}
});

test("no dedicated exploration tool is registered", () => {
	const { tools } = registerWithStub();
	for (const name of ["agy_explore", "agyExplore", "explore"]) {
		assert.equal(tools.has(name), false, `${name} must not be registered`);
	}
});

test("injected guidance makes the agy tools opt-in", async () => {
	const { handlers } = registerWithStub();
	const handler = handlers.get("before_agent_start");
	assert.ok(handler, "before_agent_start handler was not registered");
	const out = await handler!({ systemPrompt: "BASE PROMPT" });
	assert.ok(out.systemPrompt.startsWith("BASE PROMPT"), "guidance must be appended, not replace the prompt");
	assert.match(out.systemPrompt, /opt-in only/i);
	assert.match(out.systemPrompt, /do NOT call any agy tool/i);
	assert.match(out.systemPrompt, /explicitly asks/i);
	assert.match(out.systemPrompt, /off by default/i);
	assert.match(out.systemPrompt, /agy_vision/);
	assert.match(out.systemPrompt, /agy_role/);
	assert.match(out.systemPrompt, /scout \(read-only recon\)/);
	// Exploration is routed through the read-only scout role, not a second tool.
	assert.match(out.systemPrompt, /agy_role\(\{ role: "scout"/);
	assert.doesNotMatch(out.systemPrompt, /agy_explore/);
	// The old unconditional "you are the orchestrator, use agy" instruction must be gone.
	assert.doesNotMatch(out.systemPrompt, /You are the orchestrator\. Use agy/);
});

// ---------------------------------------------------------------------------
// Fleet surface wiring
// ---------------------------------------------------------------------------

test("the extension registers the /agy-fleet inspector command", () => {
	const { commands } = registerWithStub();
	const command = commands.get("agy-fleet") as { handler?: unknown } | undefined;
	assert.ok(command, "agy-fleet command was not registered");
	assert.equal(typeof command!.handler, "function");
});

test("the extension registers the /agy-doctor command", () => {
	const { commands } = registerWithStub();
	const command = commands.get("agy-doctor") as { handler?: unknown } | undefined;
	assert.ok(command, "agy-doctor command was not registered");
	assert.equal(typeof command!.handler, "function");
});

test("session_start binds the fleet view and session_shutdown disposes it", async () => {
	const { handlers } = registerWithStub();
	const start = handlers.get("session_start");
	const shutdown = handlers.get("session_shutdown");
	assert.ok(start, "session_start handler was not registered");
	assert.ok(shutdown, "session_shutdown handler was not registered");

	// Non-UI contexts must be tolerated (RPC/print mode): setContext clears state.
	await start!({ type: "session_start", reason: "startup" }, { hasUI: false });
	await shutdown!({ type: "session_shutdown", reason: "quit" });
});
// ---------------------------------------------------------------------------
// Public surface: the live-TUI primitives stay importable from the root
// ---------------------------------------------------------------------------

test("the root export exposes the live-TUI primitives", async () => {
	const root = await import("../index.ts");
	for (const name of [
		// ui
		"SPINNER_FRAMES", "frameAt", "spinnerGlyph", "truncLine", "fitLine",
		"formatActivityAge", "formatTokens", "treeBranch", "treeIndent",
		// status / liveness
		"ACTIVITY_LONG_RUNNING_MS", "ACTIVITY_NEEDS_ATTENTION_MS",
		"activityAgeMs", "activityState", "activityFreshnessText", "toolDurationMs",
		// render / surfaces
		"LiveView", "fleetSingleRunLines",
		// runner
		"extractOutputTail",
	]) {
		assert.ok(name in root, `index.ts must re-export ${name}`);
	}
	assert.equal(root.SPINNER_FRAMES.length, 10);
	assert.equal(typeof root.truncLine("hello world", 6), "string");
});
