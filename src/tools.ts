import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { config, MAX_FLEET_CONCURRENCY } from "./config.ts";
import { executeAgy, executeFleet, type FleetTaskParams } from "./executors.ts";

/**
 * Tool definitions (schemas + labels) wired to the shared executors.
 * Descriptions intentionally carry the load for the LLM, mirroring what pi
 * shows the model for each tool.
 */

// The general-purpose worker: delegate a low-level task to the agy/Gemini agent.
export const agyRun = defineTool({
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
		"While it runs, live status shows the current step, the file being written/edited, and " +
		"commands being run; the result includes a full run log plus evidence (files, commands). " +
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

export const agyExplore = defineTool({
	name: "agy_explore",
	label: "Agy Explore",
	description:
		"Delegate a read-only exploration task to the Antigravity (agy) agent (Gemini). " +
		"Use to map, explain, or investigate a codebase, a directory, or a chunk of code without " +
		"modifying anything. Shell commands are never enabled for this tool; file reads inside " +
		"the workspace are allowed. Live status shows the step and file it is inspecting; the " +
		"result includes a run log. Returns the agent's findings.",
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
export const agyCode = defineTool({
	name: "agy_code",
	label: "Agy Code",
	description:
		"Delegate a code-writing/implementation task to the Antigravity (agy) agent (Gemini). " +
		"Use for writing or editing files, implementing a feature, or generating code in the workspace. " +
		"File reads/writes in the workspace are allowed. Shell commands are enabled by default " +
		`(allowCommands defaults to ${config.defaultAllowCommands}; set false for pure file tasks). ` +
		"Live status shows the step and file the agent is writing/editing in real time; the " +
		"result includes a run log plus evidence. If the agent returns no text it was probably " +
		"denied permission — retry with allowCommands=true.",
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

const fleetTaskSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Lane id shown in status/results (default: t1, t2, …)." })),
	task: Type.String({ description: "The prompt/instruction for this agy lane." }),
	workspace: Type.Optional(
		Type.String({ description: "Directory to run this lane in (defaults to cwd)." })
	),
	model: Type.Optional(Type.String({ description: `Model slug (default: ${config.model}).` })),
	effort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	agent: Type.Optional(Type.String({ description: "agy agent to use for this lane." })),
	allowCommands: Type.Optional(
		Type.Boolean({ description: `Allow shell commands for this lane (default: ${config.defaultAllowCommands}).` })
	),
	continueConv: Type.Optional(
		Type.Boolean({ description: "Continue the most recent conversation in this lane's workspace." })
	),
	jsonSchema: Type.Optional(Type.String({ description: "JSON schema string to constrain this lane's output." })),
	timeout: Type.Optional(Type.String({ description: `Max wait for this lane (default: ${config.timeout}).` })),
});

// Fan-out preset: run several agy agents in parallel with a live per-lane board.
export const agyFleet = defineTool({
	name: "agy_fleet",
	label: "Agy Fleet (fan-out)",
	description:
		"Fan out multiple Antigravity (agy) agents on a list of tasks and run them in parallel " +
		"with bounded concurrency. Each lane is its own agy agent with its own tool loop and " +
		"workspace. A live board in the conversation shows every lane: current step, the file " +
		"being written/edited, the command running, and done/failed state — then the final " +
		"result reports per-lane status, response, files, and commands so the orchestrator can " +
		"verify each lane. Use to parallelize independent subtasks (edit several modules, run " +
		"separate research passes, scaffold multiple components). All lanes sharing one " +
		"workspace write to the same directory — prefer distinct workspaces (or distinct files) " +
		"to avoid conflicting edits.",
	parameters: Type.Object({
		tasks: Type.Array(fleetTaskSchema, {
			description: "One entry per agy lane (2–24). Each needs a self-contained `task` prompt.",
		}),
		concurrency: Type.Optional(
			Type.Integer({
				description: `Max parallel agy agents (default: ${config.fleetConcurrency}, range 1–${MAX_FLEET_CONCURRENCY}).`,
			})
		),
		model: Type.Optional(Type.String({ description: `Default model for all lanes (default: ${config.model}).` })),
		effort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
		agent: Type.Optional(Type.String({ description: "Default agy agent for all lanes." })),
		allowCommands: Type.Optional(
			Type.Boolean({ description: `Default allowCommands for all lanes (default: ${config.defaultAllowCommands}).` })
		),
		timeout: Type.Optional(Type.String({ description: `Default max wait per lane (default: ${config.timeout}).` })),
	}),
	execute: executeFleet,
});

export type { FleetTaskParams };