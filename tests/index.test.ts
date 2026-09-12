import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { config, effortFromModel, matchEffort } from "../index.ts";

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

test("matchEffort handles multi-segment gemini slugs", () => {
	assert.equal(matchEffort("gemini-2.5-pro-preview-low", "high"), "gemini-2.5-pro-preview-high");
	assert.equal(effortFromModel("gemini-2.5-pro-preview-low"), "low");
	assert.equal(effortFromModel("gemini-3.8-flash"), undefined);
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

function registerWithStub(flagValues: Record<string, string> = {}) {
	const tools = new Map<string, StubTool>();
	const handlers = new Map<string, StubHandler>();
	const commands = new Map<string, unknown>();
	const flags = new Map<string, unknown>();
	const api = {
		registerTool: (tool: StubTool) => tools.set(tool.name, tool),
		on: (event: string, handler: StubHandler) => handlers.set(event, handler),
		registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
		registerFlag: (name: string, definition: unknown) => flags.set(name, definition),
		getFlag: (name: string) => flagValues[name],
	};
	extension(api as never);
	return { tools, handlers, commands, flags };
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
// Terminal settings (/agy-model, /agy-effort)
// ---------------------------------------------------------------------------

interface StubUi {
	notices: { message: string; type?: string }[];
	ctx: { hasUI: boolean; cwd: string; ui: Record<string, unknown> };
}

function settingsContext(
	hasUI = true,
	select?: (title: string, options: string[]) => Promise<string | undefined>
): StubUi {
	const notices: { message: string; type?: string }[] = [];
	return {
		notices,
		ctx: {
			hasUI,
			cwd: process.cwd(),
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, type }),
				select: select ?? (async () => undefined),
				input: async () => undefined,
			},
		},
	};
}

type SettingsCommand = {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => Promise<{ value: string }[] | null> | { value: string }[] | null;
};

function settingsCommand(name: string): SettingsCommand {
	const { commands } = registerWithStub();
	const entry = commands.get(name) as SettingsCommand | undefined;
	assert.ok(entry, `${name} command was not registered`);
	return entry!;
}

test("the extension registers /agy-model and /agy-effort with argument completions", () => {
	const { commands } = registerWithStub();
	for (const name of ["agy-model", "agy-effort"]) {
		const entry = commands.get(name) as { handler?: unknown; getArgumentCompletions?: unknown } | undefined;
		assert.ok(entry, `${name} command was not registered`);
		assert.equal(typeof entry!.handler, "function");
		assert.equal(typeof entry!.getArgumentCompletions, "function");
	}
});

test("/agy-effort completes low/medium/high", async () => {
	const completions = settingsCommand("agy-effort").getArgumentCompletions!;
	assert.deepEqual((await completions(""))?.map((item) => item.value), ["low", "medium", "high"]);
	assert.deepEqual((await completions("m"))?.map((item) => item.value), ["medium"]);
	assert.equal(await completions("z"), null);
});

test("/agy-effort applies to the session and keeps a gemini slug in sync", async () => {
	const before = { model: config.model, effort: config.effort };
	const { notices, ctx } = settingsContext();
	try {
		config.model = "gemini-3.8-flash-high";
		config.effort = "high";
		await settingsCommand("agy-effort").handler("low --session", ctx);
		assert.equal(config.effort, "low");
		assert.equal(config.model, "gemini-3.8-flash-low");
		assert.match(notices.at(-1)!.message, /agy effort → low/);
		assert.match(notices.at(-1)!.message, /session only/);
	} finally {
		config.model = before.model;
		config.effort = before.effort;
	}
});

test("/agy-model follows the effort a gemini slug encodes", async () => {
	const before = { model: config.model, effort: config.effort };
	const { notices, ctx } = settingsContext();
	try {
		config.model = "gemini-3.8-flash-high";
		config.effort = "high";
		await settingsCommand("agy-model").handler("gemini-3.1-pro-low --session", ctx);
		assert.equal(config.model, "gemini-3.1-pro-low");
		assert.equal(config.effort, "low");
		assert.match(notices.at(-1)!.message, /agy model → gemini-3.1-pro-low \(effort low\)/);
	} finally {
		config.model = before.model;
		config.effort = before.effort;
	}
});

test("/agy-effort rejects an unknown level without touching the config", async () => {
	const before = config.effort;
	const { notices, ctx } = settingsContext();
	await settingsCommand("agy-effort").handler("extreme --session", ctx);
	assert.equal(config.effort, before);
	assert.equal(notices.at(-1)!.type, "error");
	assert.match(notices.at(-1)!.message, /Unknown effort "extreme"/);
});

test("/agy-model rejects extra arguments and prints usage on --help", async () => {
	const { notices, ctx } = settingsContext();
	const handler = settingsCommand("agy-model").handler;
	await handler("--session a b", ctx);
	assert.equal(notices.at(-1)!.type, "error");
	assert.match(notices.at(-1)!.message, /Unexpected extra arguments: b/);
	await handler("--help", ctx);
	assert.match(notices.at(-1)!.message, /Usage: \/agy-model/);
});

test("/agy-model persists model + effort and preserves unrelated config keys", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-index-"));
	const file = join(dir, "agy.json");
	writeFileSync(file, JSON.stringify({ timeout: "20m", roles: { scout: { effort: "low" } } }));
	const before = { model: config.model, effort: config.effort, configFile: config.configFile };
	const { notices, ctx } = settingsContext();
	try {
		config.configFile = file;
		await settingsCommand("agy-model").handler("gemini-3.1-pro-high", ctx);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
			timeout: "20m",
			roles: { scout: { effort: "low" } },
			model: "gemini-3.1-pro-high",
			effort: "high",
		});
		assert.deepEqual({ model: config.model, effort: config.effort }, { model: "gemini-3.1-pro-high", effort: "high" });
		assert.match(notices.at(-1)!.message, /saved to /);
	} finally {
		config.model = before.model;
		config.effort = before.effort;
		config.configFile = before.configFile;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("in non-UI mode a bare /agy-model prints usage instead of opening a picker", async () => {
	const before = { model: config.model, effort: config.effort };
	const logs: string[] = [];
	const original = console.log;
	console.log = (message?: unknown) => {
		logs.push(String(message));
	};
	try {
		await settingsCommand("agy-model").handler("", { hasUI: false, cwd: process.cwd(), ui: {} });
		assert.match(logs.at(-1)!, /Usage: \/agy-model/);
		assert.deepEqual({ model: config.model, effort: config.effort }, before);
	} finally {
		console.log = original;
	}
});

test("--agy-model / --agy-effort set the session defaults at startup", () => {
	const before = { model: config.model, effort: config.effort };
	try {
		const { flags } = registerWithStub({ "agy-model": "gemini-3.1-pro-low", "agy-effort": "medium" });
		assert.ok(flags.has("agy-model"));
		assert.ok(flags.has("agy-effort"));
		assert.equal(config.effort, "medium");
		assert.equal(config.model, "gemini-3.1-pro-medium");
	} finally {
		config.model = before.model;
		config.effort = before.effort;
	}
});

test("an invalid --agy-effort is ignored with a warning", () => {
	const before = config.effort;
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message?: unknown) => {
		warnings.push(String(message));
	};
	try {
		registerWithStub({ "agy-effort": "extreme" });
		assert.equal(config.effort, before);
		assert.match(warnings.join("\n"), /ignoring --agy-effort=extreme/);
	} finally {
		console.warn = original;
	}
});

test("/agy-effort with no value leaves the config alone when the picker is cancelled", async () => {
	const before = { model: config.model, effort: config.effort };
	const { ctx } = settingsContext(true, async () => undefined);
	await settingsCommand("agy-effort").handler("", ctx);
	assert.deepEqual({ model: config.model, effort: config.effort }, before);
});

test("--session never claims an env override", async () => {
	const before = { model: config.model, effort: config.effort };
	const previous = process.env.AGY_EFFORT;
	const { notices, ctx } = settingsContext();
	try {
		process.env.AGY_EFFORT = "low";
		await settingsCommand("agy-effort").handler("high --session", ctx);
		assert.match(notices.at(-1)!.message, /session only/);
		assert.doesNotMatch(notices.at(-1)!.message, /overrides the saved value/);
	} finally {
		if (previous === undefined) delete process.env.AGY_EFFORT;
		else process.env.AGY_EFFORT = previous;
		config.model = before.model;
		config.effort = before.effort;
	}
});

test("a saved change warns only about the env variable that actually overrides it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-index-"));
	const file = join(dir, "agy.json");
	const before = { model: config.model, effort: config.effort, configFile: config.configFile };
	const previousModel = process.env.AGY_MODEL;
	const previousEffort = process.env.AGY_EFFORT;
	try {
		config.configFile = file;
		process.env.AGY_MODEL = "gemini-3.1-pro-high";
		delete process.env.AGY_EFFORT;

		const irrelevant = settingsContext();
		await settingsCommand("agy-effort").handler("medium", irrelevant.ctx);
		assert.doesNotMatch(irrelevant.notices.at(-1)!.message, /overrides the saved value/);

		process.env.AGY_EFFORT = "low";
		const relevant = settingsContext();
		await settingsCommand("agy-effort").handler("medium", relevant.ctx);
		assert.match(relevant.notices.at(-1)!.message, /AGY_EFFORT is set and overrides the saved value/);
		assert.equal(relevant.notices.at(-1)!.type, "warning");
	} finally {
		if (previousModel === undefined) delete process.env.AGY_MODEL;
		else process.env.AGY_MODEL = previousModel;
		if (previousEffort === undefined) delete process.env.AGY_EFFORT;
		else process.env.AGY_EFFORT = previousEffort;
		config.model = before.model;
		config.effort = before.effort;
		config.configFile = before.configFile;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a launch flag is reported as overriding the saved value on the next launch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-index-"));
	const file = join(dir, "agy.json");
	const before = { model: config.model, effort: config.effort, configFile: config.configFile };
	const notices: { message: string; type?: string }[] = [];
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
			select: async () => undefined,
			input: async () => undefined,
		},
	};
	try {
		const { commands } = registerWithStub({ "agy-model": "gemini-3.1-pro-low" });
		config.configFile = file;
		await (commands.get("agy-model") as SettingsCommand).handler("gemini-3.1-pro-high", ctx);
		assert.match(notices.at(-1)!.message, /--agy-model is set and will override the saved value on the next launch/);
	} finally {
		config.model = before.model;
		config.effort = before.effort;
		config.configFile = before.configFile;
		rmSync(dir, { recursive: true, force: true });
	}
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
