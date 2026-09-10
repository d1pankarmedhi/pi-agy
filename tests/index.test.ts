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

type BeforeAgentStart = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string }> | { systemPrompt: string };

function registerWithStub() {
	const tools = new Map<string, StubTool>();
	const handlers = new Map<string, BeforeAgentStart>();
	const commands = new Map<string, unknown>();
	const api = {
		registerTool: (tool: StubTool) => tools.set(tool.name, tool),
		on: (event: string, handler: BeforeAgentStart) => handlers.set(event, handler),
		registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
	};
	extension(api as never);
	return { tools, handlers, commands };
}

test("the extension registers all four agy tools with custom TUI cards", () => {
	const { tools } = registerWithStub();
	for (const name of ["agy", "agy_explore", "agy_code", "agy_fleet"]) {
		const tool = tools.get(name);
		assert.ok(tool, `tool ${name} was not registered`);
		assert.equal(typeof tool!.execute, "function", `${name} needs execute`);
		assert.equal(typeof tool!.renderCall, "function", `${name} needs renderCall`);
		assert.equal(typeof tool!.renderResult, "function", `${name} needs renderResult`);
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
	// The old unconditional "you are the orchestrator, use agy" instruction must be gone.
	assert.doesNotMatch(out.systemPrompt, /You are the orchestrator\. Use agy/);
});