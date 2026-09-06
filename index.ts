/**
 * pi-agy — Antigravity CLI (agy) worker extension for pi.
 *
 * Delegates low-level tasks (writing code, exploring a codebase, focused
 * research passes) to Google Antigravity's headless CLI (`agy`), which drives
 * a Gemini (or other) model agent with its own tool loop. Pi's main agent
 * stays in control as the ORCHESTRATOR and verifies the agent's work before
 * reporting success — that guidance is injected automatically on every agent
 * start, so installation is all users need.
 *
 * Requirements:
 *   - `agy` installed and authenticated once (`agy -p "hi"` works).
 *   - Headless mode uses cached credentials; no interactive login needed.
 *
 * Configuration (all optional — sensible defaults below):
 *   - Env vars:  AGY_BIN, AGY_MODEL, AGY_EFFORT, AGY_AGENT, AGY_TIMEOUT,
 *                AGY_ALLOW_CMDS, AGY_CONFIG
 *   - User file: ~/.pi/agy.json (path overridable via AGY_CONFIG)
 *   Order of precedence: built-in defaults < user file < env vars < tool params.
 *
 * The extension never writes to disk, so `pi remove` leaves no residue.
 *
 * Headless-mode permissions:
 *   File reads/writes inside the workspace are auto-allowed by agy. Shell
 *   commands are auto-denied unless allowCommands is true (passes
 *   --dangerously-skip-permissions) or matching allow rules exist in
 *   ~/.gemini/antigravity-cli/settings.json. When a tool call is denied, agy
 *   can finish with status SUCCESS but an empty response; this extension
 *   detects that and reports it so the orchestrator can retry with
 *   allowCommands.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgyConfig {
	bin: string;
	model: string;
	effort: "low" | "medium" | "high";
	agent?: string;
	timeout: string;
	defaultAllowCommands: boolean;
	configFile: string;
}

const DEFAULT_CONFIG: Omit<AgyConfig, "configFile"> = {
	bin: "agy",
	model: "gemini-3.8-flash-high",
	effort: "high",
	timeout: "10m",
	defaultAllowCommands: true,
};

function userConfigPath(): string {
	const env = process.env.AGY_CONFIG;
	return env ? resolve(env) : join(homedir(), ".pi", "agy.json");
}

function loadConfig(): AgyConfig {
	const filePath = userConfigPath();
	let file: Partial<AgyConfig> = {};
	try {
		if (existsSync(filePath)) file = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (e) {
		console.warn(`[pi-agy] could not read ${filePath}: ${(e as Error).message}`);
	}
	const envBool = (v: string | undefined, dflt: boolean) =>
		v === undefined ? dflt : v.toLowerCase() === "true" || v === "1";
	return {
		bin: process.env.AGY_BIN || file.bin || DEFAULT_CONFIG.bin,
		model: process.env.AGY_MODEL || file.model || DEFAULT_CONFIG.model,
		effort: ((process.env.AGY_EFFORT || file.effort || DEFAULT_CONFIG.effort) as AgyConfig["effort"]),
		agent: process.env.AGY_AGENT || file.agent,
		timeout: process.env.AGY_TIMEOUT || file.timeout || DEFAULT_CONFIG.timeout,
		defaultAllowCommands: envBool(process.env.AGY_ALLOW_CMDS, file.defaultAllowCommands ?? DEFAULT_CONFIG.defaultAllowCommands),
		configFile: filePath,
	};
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Model / effort helpers
// ---------------------------------------------------------------------------

/**
 * Keep the gemini model slug consistent with the requested effort. agy rejects
 * combinations like `--model gemini-3.8-flash-medium --effort high`, so a
 * gemini slug ending in -low/-medium/-high is rewritten to match `effort`.
 * Non-gemini models (claude, gpt-oss, ...) are returned unchanged; they do not
 * accept a --effort flag.
 */
export function matchEffort(model: string, effort: string | undefined): string {
	if (!effort) return model;
	const m = /^(gemini-[^-]+-[^-]+)-(low|medium|high)$/.exec(model);
	return m ? `${m[1]}-${effort}` : model;
}

function isGemini(model: string): boolean {
	return /^gemini-/.test(model);
}

// Last conversation id per workspace, so `continue` can resume real context.
const lastConversation = new Map<string, string>();

// ---------------------------------------------------------------------------
// Path helpers (Git Bash paths like /tmp/foo or ~/dev on Windows)
// ---------------------------------------------------------------------------

let cygpathWorks: boolean | null = null;

function toWindowsPath(p: string): string {
	if (cygpathWorks === false) return resolve(p);
	try {
		const out = execFileSync("cygpath", ["-w", p], { encoding: "utf8" }).trim();
		if (out) {
			cygpathWorks = true;
			return out;
		}
	} catch {
		cygpathWorks = false;
	}
	return resolve(p);
}

function resolveWorkspace(raw: string, cwd: string): string {
	let p = raw.trim();
	if (p === ".") return cwd;
	if (p.startsWith("~")) p = resolve(homedir(), p.slice(1));
	if (process.platform === "win32" && /^\/[^/]/.test(p) && !/^[A-Za-z]:/.test(p)) {
		return toWindowsPath(p);
	}
	return resolve(cwd, p);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RunOptions {
	prompt: string;
	workspace: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands: boolean;
	continueConv: boolean;
	conversation?: string;
	jsonSchema?: string;
	timeout: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
}

interface StreamResult {
	status: string;
	conversation_id: string;
	response: string;
	error?: string;
	usage?: Record<string, number>;
	duration_seconds?: number;
	num_turns?: number;
	denied_actions?: Array<{ action: string; display_name?: string }>;
	warnings?: string[];
	tool_steps?: number;
	files_written?: string[];
	commands_run?: string[];
}

function parseResult(raw: Record<string, unknown> | undefined): StreamResult | null {
	if (!raw || typeof raw !== "object") return null;
	const r: StreamResult = {
		status: String(raw.status ?? ""),
		conversation_id: String(raw.conversation_id ?? ""),
		response: String(raw.response ?? ""),
		error: raw.error ? String(raw.error) : undefined,
		usage: (raw.usage as Record<string, number>) || undefined,
		duration_seconds: typeof raw.duration_seconds === "number" ? raw.duration_seconds : undefined,
		num_turns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
		denied_actions: Array.isArray(raw.denied_actions) ? (raw.denied_actions as StreamResult["denied_actions"]) : undefined,
	};
	return r;
}

// Tool names whose parameters contain the path of a file the agent wrote.
const WRITE_TOOLS = new Set([
	"write_to_file",
	"replace_file_content",
	"multi_replace_file_content",
	"sed_file",
	"edit_file",
	"notebook_edit",
]);

function extractFilePath(parameters: unknown): string | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	const p = parameters as Record<string, unknown>;
	for (const key of ["TargetFile", "FilePath", "Path"]) {
		const v = p[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	for (const v of Object.values(p)) {
		if (typeof v === "string" && v.length > 4 && /[\\/]/.test(v)) return v;
	}
	return undefined;
}

function runAgy(opts: RunOptions): Promise<StreamResult> {
	return new Promise((resolvePromise, reject) => {
		const args = ["-p", opts.prompt, "--output-format", "stream-json"];

		// Register the workspace directory so agy treats it as the active
		// workspace (otherwise file writes fall back to the scratch dir).
		args.push("--add-dir", opts.workspace);

		const effort = opts.effort || config.effort;
		let model = opts.model || config.model;
		if (effort) model = matchEffort(model, effort);
		if (model) args.push("--model", model);
		if (effort && isGemini(model)) args.push("--effort", effort);
		const agent = opts.agent || config.agent;
		if (agent) args.push("--agent", agent);
		if (opts.jsonSchema) args.push("--json-schema", opts.jsonSchema);
		args.push("--print-timeout", opts.timeout);

		// Conversation continuity.
		if (opts.conversation) {
			args.push("--conversation", opts.conversation);
		} else if (opts.continueConv) {
			const prior = lastConversation.get(opts.workspace);
			if (prior) args.push("--conversation", prior);
			else args.push("--continue");
		}

		// File reads/writes inside the workspace are auto-allowed by agy.
		// Command execution needs explicit approval; gate it behind the flag.
		if (opts.allowCommands) args.push("--dangerously-skip-permissions");

		const child = spawn(config.bin, args, {
			cwd: opts.workspace,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let result: StreamResult | null = null;
		let stepText = "";
		let toolSteps = 0;
		const files = new Set<string>();
		const commands = new Set<string>();
		const warnings: string[] = [];

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			// stdout is NDJSON; process complete lines.
			let nl: number;
			while ((nl = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, nl).trim();
				stdout = stdout.slice(nl + 1);
				if (!line) continue;
				let ev: { event?: string; [k: string]: unknown };
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (ev.event === "step_update") {
					const s = ev.step_update as any;
					if (s?.step_type === "tool") {
						if (s.tool_name) toolSteps++;
						const info = s.tool_info as any;
						if (info?.name === "run_command") {
							const cl = info.parameters?.CommandLine ?? info.parameters?.Command;
							if (typeof cl === "string" && cl.trim()) commands.add(cl.trim());
						} else if (WRITE_TOOLS.has(info?.name)) {
							const fp = extractFilePath(info.parameters);
							if (fp) files.add(fp);
						}
					}
					if (s?.step_type === "agent_response" && typeof s.text_delta === "string" && s.text_delta) {
						stepText += s.text_delta;
						opts.onUpdate?.({
							content: [{ type: "text", text: stepText }],
							details: { streaming: true, toolSteps },
						});
					}
				} else if (ev.event === "result") {
					result = parseResult(ev.result as Record<string, unknown>);
					if (result?.conversation_id) {
						lastConversation.set(opts.workspace, result.conversation_id);
					}
				}
			}
		});

		child.stderr.on("data", (d: string) => {
			stderr += d;
		});

		const onAbort = () => child.kill();
		const sig =
			opts.signal && typeof (opts.signal as AbortSignal).addEventListener === "function"
				? (opts.signal as AbortSignal)
				: undefined;
		sig?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			sig?.removeEventListener("abort", onAbort);
			const exists = existsSync(opts.workspace);
			reject(
				new Error(
					`Failed to launch agy (${config.bin}) in ${opts.workspace}: ${err.message}` +
						(exists ? "" : " (workspace directory does not exist)")
				)
			);
		});

		child.on("close", (code) => {
			sig?.removeEventListener("abort", onAbort);
			if (sig?.aborted) {
				reject(new Error("agy run aborted"));
				return;
			}
			const r = result ?? {
				status: code === 0 ? "SUCCESS" : "ERROR",
				conversation_id: "",
				response: stepText,
				error: stderr.trim() || undefined,
			};

			// Detect the headless-mode trap: agy can finish SUCCESS with no
			// output because a tool call was auto-denied.
			if (r.status === "SUCCESS" && !r.response?.trim()) {
				const denied = r.denied_actions?.map((d) => d.action).join(", ");
				if (denied || /denied|permission/i.test(stderr)) {
					warnings.push(
						`the agy agent produced no output because its tool calls were auto-denied in ` +
							`headless mode${denied ? ` (denied: ${denied})` : ""}. ` +
							`Retry with allowCommands=true or add allow rules under ` +
							`permissions.allow in ~/.gemini/antigravity-cli/settings.json.`
					);
				} else if (stderr.trim()) {
					warnings.push(stderr.trim());
				}
			}
			r.warnings = warnings.length ? warnings : undefined;
			r.tool_steps = toolSteps;
			r.files_written = files.size ? [...files].sort() : undefined;
			r.commands_run = commands.size
				? [...commands].map((c) => (c.length > 160 ? c.slice(0, 157) + "..." : c))
				: undefined;

			if (r.status !== "SUCCESS") {
				const msg = r.error?.trim() || stderr.trim() || `agy exited with code ${code}`;
				reject(new Error(`agy ${r.status}: ${msg}`));
				return;
			}
			resolvePromise(r);
		});
	});
}

function buildResult(
	r: StreamResult,
	opts: { workspace: string; model: string; allowCommands: boolean }
): { content: AgentToolResult<unknown>["content"]; details: Record<string, unknown> } {
	const meta: string[] = [];
	if (r.conversation_id) meta.push(`conversation_id=${r.conversation_id}`);
	if (r.num_turns !== undefined) meta.push(`turns=${r.num_turns}`);
	if (r.duration_seconds !== undefined) meta.push(`duration=${r.duration_seconds.toFixed(1)}s`);
	if (r.usage?.total_tokens !== undefined) meta.push(`tokens=${r.usage.total_tokens}`);

	let text = r.response?.trim() || "(the agy agent returned no text)";
	if (r.warnings?.length) {
		text += `\n\n⚠️ ${r.warnings.join(" ")}`;
	}

	// Evidence the orchestrator can verify against.
	const evidence: string[] = [];
	if (r.files_written?.length) evidence.push(`files: ${r.files_written.join(", ")}`);
	if (r.commands_run?.length) evidence.push(`commands: ${r.commands_run.join(" | ")}`);
	if (evidence.length) text += `\n\nEvidence — ${evidence.join("   ")}`;

	return {
		content: [
			{
				type: "text",
				text: text + (meta.length ? `\n\n(${meta.join("  ")})` : ""),
			},
		],
		details: {
			response: r.response,
			status: r.status,
			conversation_id: r.conversation_id,
			usage: r.usage,
			duration_seconds: r.duration_seconds,
			num_turns: r.num_turns,
			denied_actions: r.denied_actions,
			warnings: r.warnings,
			files_written: r.files_written,
			commands_run: r.commands_run,
			workspace: opts.workspace,
			toolSteps: r.tool_steps ?? 0,
			model: opts.model,
			allowCommands: opts.allowCommands,
		},
	};
}

// Shared execute used by all three tools.
async function executeAgy(
	_toolCallId: string,
	params: {
		prompt: string;
		workspace?: string;
		model?: string;
		effort?: "low" | "medium" | "high";
		agent?: string;
		allowCommands?: boolean;
		continueConv?: boolean;
		conversation?: string;
		jsonSchema?: string;
		timeout?: string;
	},
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext
): Promise<AgentToolResult<Record<string, unknown>>> {
	const workspace = params.workspace ? resolveWorkspace(params.workspace, ctx.cwd) : ctx.cwd;
	if (ctx.hasUI) ctx.ui.setStatus("agy", `agy: ${params.prompt.slice(0, 40)}…`);
	try {
		const r = await runAgy({
			prompt: params.prompt,
			workspace,
			model: params.model || config.model,
			effort: params.effort,
			agent: params.agent,
			allowCommands: params.allowCommands ?? config.defaultAllowCommands,
			continueConv: params.continueConv ?? false,
			conversation: params.conversation,
			jsonSchema: params.jsonSchema,
			timeout: params.timeout || config.timeout,
			signal,
			onUpdate,
		});
		return buildResult(r, {
			workspace,
			model: params.model || config.model,
			allowCommands: params.allowCommands ?? config.defaultAllowCommands,
		});
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("agy", "");
	}
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// The general-purpose worker: delegate a low-level task to the agy/Gemini agent.
const agyRun = defineTool({
	name: "agy",
	label: "Agy (Antigravity)",
	description:
		"Delegate a low-level task to the Antigravity (agy) CLI agent running a Gemini model. " +
		"Use for focused work the main agent can hand off: writing/editing a file, exploring or " +
		"summarizing part of a codebase, running a quick research pass, drafting code, or " +
		"performing a multi-step task in a dedicated workspace. " +
		"The agy agent runs with its own tool loop. File reads/writes inside the workspace are " +
		"auto-allowed; shell commands are enabled only when allowCommands is true (default comes " +
		"from pi-agy config). If the agent returns no text, it usually means a tool call was " +
		"auto-denied — retry with allowCommands=true. " +
		"Returns the agent's response plus metadata (conversation_id, usage, evidence). " +
		"Set continueConv true or pass conversation to keep the same agent conversation going.",
	parameters: Type.Object({
		prompt: Type.String({
			description: "The task/instruction to give the agy agent. Be specific and self-contained.",
		}),
		workspace: Type.Optional(
			Type.String({
				description:
					"Directory to run in (defaults to the current working directory). Accepts Windows or Git-Bash paths (/tmp/foo, ~/dev). The agent may only read/write inside this workspace unless its own settings allow more.",
			})
		),
		model: Type.Optional(
			Type.String({
				description: `Model slug, e.g. gemini-3.8-flash-high (default: ${config.model}). Run 'agy models' to list.`,
			})
		),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		agent: Type.Optional(
			Type.String({
				description: "agy agent to use (run 'agy agents' to list).",
			})
		),
		allowCommands: Type.Optional(
			Type.Boolean({
				description:
					"Allow the agy agent to run shell commands (passes --dangerously-skip-permissions). " +
					`Default: ${config.defaultAllowCommands}. Enable when the task requires running tests, builds, git, etc.`,
			})
		),
		continueConv: Type.Optional(
			Type.Boolean({
				description:
					"Continue the most recent agy conversation for this workspace, preserving context from earlier calls.",
			})
		),
		conversation: Type.Optional(
			Type.String({
				description: "Resume a specific agy conversation by its conversation_id (overrides continueConv).",
			})
		),
		jsonSchema: Type.Optional(
			Type.String({
				description: "JSON schema (string) to constrain the agent's final structured output.",
			})
		),
		timeout: Type.Optional(
			Type.String({
				description: `Max wait for a response, e.g. "10m" (default: ${config.timeout}).`,
			})
		),
	}),
	execute: executeAgy,
});

// Read-only exploration preset: never passes --dangerously-skip-permissions and
// steers the agent toward agy's native read-only tools instead of shell commands.
const EXPLORE_GUIDE =
	"IMPORTANT: shell commands (run_command) are DENIED in this environment. " +
	"Use only these built-in read-only tools: list_dir, view_file, grep_search, read_resource. " +
	"Never attempt run_command — it will be auto-denied and the task will fail.";

const agyExplore = defineTool({
	name: "agy_explore",
	label: "Agy Explore",
	description:
		"Delegate a read-only exploration task to the Antigravity (agy) agent (Gemini). " +
		"Use to map, explain, or investigate a codebase, a directory, or a chunk of code without " +
		"modifying anything. Shell commands are never enabled for this tool; file reads inside " +
		"the workspace are allowed. Returns the agent's findings.",
	parameters: Type.Object({
		prompt: Type.String({
			description:
				"The exploration question/instruction, e.g. 'Map the modules in src/ and explain how they connect'.",
		}),
		workspace: Type.Optional(Type.String({ description: "Directory to explore (defaults to cwd)." })),
		model: Type.Optional(Type.String({ description: `Model slug (default: ${config.model}).` })),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		timeout: Type.Optional(Type.String({ description: `Max wait (default: ${config.timeout}).` })),
	}),
	execute: (id, params, signal, onUpdate, ctx) =>
		executeAgy(
			id,
			{ ...params, prompt: `${params.prompt}\n\n${EXPLORE_GUIDE}`, allowCommands: false },
			signal,
			onUpdate,
			ctx
		),
});

// Code-writing preset: implementation tasks in a workspace.
const agyCode = defineTool({
	name: "agy_code",
	label: "Agy Code",
	description:
		"Delegate a code-writing/implementation task to the Antigravity (agy) agent (Gemini). " +
		"Use for writing or editing files, implementing a feature, or generating code in the workspace. " +
		"File reads/writes in the workspace are allowed. Shell commands are enabled by default " +
		`(allowCommands defaults to ${config.defaultAllowCommands}; set false for pure file tasks). ` +
		"If the agent returns no text it was probably denied permission — retry with allowCommands=true.",
	parameters: Type.Object({
		prompt: Type.String({
			description:
				"The implementation task. Be concrete: what to create/modify, file names, and expected behavior.",
		}),
		workspace: Type.Optional(Type.String({ description: "Directory to work in (defaults to cwd)." })),
		model: Type.Optional(Type.String({ description: `Model slug (default: ${config.model}).` })),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		allowCommands: Type.Optional(
			Type.Boolean({
				description:
					"Allow the agent to run shell commands (e.g. to run tests). " +
					`Default: ${config.defaultAllowCommands}.`,
			})
		),
		continueConv: Type.Optional(
			Type.Boolean({ description: "Continue the previous agy conversation for this workspace." })
		),
		timeout: Type.Optional(Type.String({ description: `Max wait (default: ${config.timeout}).` })),
	}),
	execute: (id, params, signal, onUpdate, ctx) =>
		executeAgy(
			id,
			{ ...params, allowCommands: params.allowCommands ?? config.defaultAllowCommands },
			signal,
			onUpdate,
			ctx
		),
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(agyRun);
	pi.registerTool(agyExplore);
	pi.registerTool(agyCode);

	// Pi is the orchestrator: when it delegates work to the agy agent tools, it
	// must verify the outcome itself before reporting success. This guidance is
	// injected automatically on every agent start — installation is all users
	// need; there is nothing to configure manually.
	const ORCHESTRATOR_GUIDE = [
		"## Orchestration with the agy tools",
		"You are the orchestrator. Use agy, agy_code, and agy_explore to delegate low-level subtasks (writing code, exploring a codebase, research passes) to the Antigravity Gemini agent instead of doing them inline.",
		"After a delegated agy run, VERIFY the outcome yourself before reporting success:",
		"- files the agent claims to have written exist and contain what was asked (use read / ls / grep),",
		"- commands or tests the agent claims to have run actually pass (re-run them with bash when cheap),",
		"- exploration answers are grounded in the actual files (spot-check with read/grep).",
		"If verification fails, or the agy agent returned no output because its tool calls were auto-denied, iterate: retry with allowCommands=true when shell access is needed, or send a follow-up agy call with continueConv=true to fix the remaining issues.",
		"Report what was done with concrete evidence: files changed and verification results.",
	].join("\n");

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + ORCHESTRATOR_GUIDE };
	});

	// Quick sanity check / model list.
	pi.registerCommand("agy-models", {
		description: "List Antigravity (agy) models and show the pi-agy config",
		handler: async (_args, ctx) => {
			const { execFile } = await import("node:child_process");
			const models = await new Promise<string>((res) => {
				execFile(config.bin, ["models"], { windowsHide: true }, (err, stdout) =>
					res(err ? `(could not list models: ${err.message})` : stdout)
				);
			});
			const msg =
				`agy bin=${config.bin}\nmodel=${config.model}\neffort=${config.effort}\n` +
				`allowCommands=${config.defaultAllowCommands}\n` +
				`timeout=${config.timeout}\nconfig=${config.configFile}\n\n${models}`;
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});

	// One-off quick prompt through the agy agent, prints result.
	pi.registerCommand("agy", {
		description: "Run a one-off prompt through the agy (Antigravity) agent",
		handler: async (args, ctx) => {
			const prompt = args || (ctx.hasUI ? await ctx.ui.input("Prompt for agy:", "e.g. refactor the auth module") : undefined);
			if (!prompt) return;
			if (ctx.hasUI) ctx.ui.notify("Running agy…", "info");
			try {
				const r = await runAgy({
					prompt,
					workspace: ctx.cwd,
					allowCommands: config.defaultAllowCommands,
					continueConv: false,
					timeout: config.timeout,
				});
				if (ctx.hasUI) ctx.ui.notify(r.response?.trim() || "(no response)", "info");
			} catch (e) {
				if (ctx.hasUI) ctx.ui.notify(`agy failed: ${(e as Error).message}`, "error");
			}
		},
	});
}