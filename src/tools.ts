import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { config, MAX_FLEET_CONCURRENCY, roles } from "./config.ts";
import { executeAgy, executeFleet, type FleetTaskParams } from "./executors.ts";
import { resolveWorkspace } from "./paths.ts";
import { fleetRenderers, singleRenderers } from "./render.ts";
import { applyRole, findRole, roleIds } from "./roles.ts";
import { buildVisionPrompt, resolveVisionAllowCommands, stageLocalImages } from "./vision.ts";

/**
 * Tool definitions (schemas + labels) wired to the shared executors.
 * Descriptions intentionally carry the load for the LLM, mirroring what pi
 * shows the model for each tool.
 *
 * Read-only exploration deliberately has no dedicated tool: `agy_role` with the
 * `scout` role (read-only, enforced) is the sanctioned path, and read-only
 * `agy_fleet` lanes fan recon out in parallel. That keeps one prompt contract
 * and one access policy for exploration instead of a second, weaker copy.
 */

// The general-purpose worker: delegate a low-level task to the agy/Gemini agent.
export const agyRun = defineTool({
	name: "agy",
	label: "Agy (Antigravity)",
	description:
		"OPT-IN: call this only when the user explicitly asks to use agy / the Antigravity agent for the current task; otherwise do the work yourself. " +
		"Delegate a low-level task to the Antigravity (agy) CLI agent running a Gemini model. " +
		"Use for focused work the user has asked to hand off: writing/editing a file, exploring or " +
		"summarizing part of a codebase, running a quick research pass, drafting code, or " +
		"performing a multi-step task in a dedicated workspace. " +
		"The agy agent runs with its own tool loop. File reads inside the workspace are " +
		"auto-allowed, but shell commands AND file writes are denied unless allowCommands " +
		"is true (default comes from pi-agy config). A denied call may still report success, " +
		"so if the agent returns no text or the result warns about missing files, retry with " +
		"allowCommands=true. " +
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
	...singleRenderers("run"),
});

// Code-writing preset: implementation tasks in a workspace.
export const agyCode = defineTool({
	name: "agy_code",
	label: "Agy Code",
	description:
		"OPT-IN: call this only when the user explicitly asks to use agy / the Antigravity agent for the current task. " +
		"Delegate a code-writing/implementation task to the Antigravity (agy) agent (Gemini). " +
		"Use for writing or editing files, implementing a feature, or generating code in the workspace. " +
		"File reads are always allowed; writes and shell commands are both granted by allowCommands, which is on by default " +
		`(allowCommands defaults to ${config.defaultAllowCommands}; set false only for a task that must not touch the disk). ` +
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
			{ ...params, allowCommands: params.allowCommands ?? config.defaultAllowCommands, preset: "code" },
			signal,
			onUpdate,
			ctx
		),
	...singleRenderers("code"),
});

// Image preset: inspect screenshots/diagrams/photos with the multimodal agent,
// read-only by default, with an optional headless-Chrome screenshot step.
export const agyVision = defineTool({
	name: "agy_vision",
	label: "Agy Vision",
	description:
		"OPT-IN: call this only when the user explicitly asks to use agy / the Antigravity agent for the current task. " +
		"Delegate an image task to the Antigravity (agy) agent (Gemini, multimodal). " +
		"Use to inspect screenshots, UI mockups, diagrams, charts, scanned pages or photos: pass the " +
		"image file path(s) in `images` and the question in `prompt`. The agent opens the actual " +
		"pixels with its image-viewing tool and answers from what it sees. Paths may be relative to " +
		"the workspace, absolute, or `~/…` (Windows, Git-Bash `/c/…` forms, and file:// URLs are " +
		"accepted); files outside the workspace are copied into a temporary directory for the run so " +
		"the agent can read them, and the copy is removed afterwards. Read-only by default " +
		"(no shell commands). Pass `url` to have it capture a headless-Chrome screenshot of a web " +
		"page first (this implies allowCommands=true) — good for reviewing a running dev server. " +
		"Images cannot be attached inline: they must exist as files on disk. Combine with " +
		"`jsonSchema` for structured extraction (e.g. UI review findings). " +
		"Note: files produced by shell commands do not appear in the files_written evidence, so " +
		"verify generated screenshots yourself.",
	parameters: Type.Object({
		prompt: Type.String({
			description: "What to determine from the image(s), e.g. 'List every layout bug and contrast issue you can see'.",
		}),
		images: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Image file path(s) to inspect — workspace-relative, absolute, or ~/… (Git-Bash /c/… and file:// also work), e.g. [\"shot.png\", \"C:/Users/me/Downloads/mock.png\"].",
			})
		),
		url: Type.Optional(
			Type.String({
				description:
					"Optional web page URL: the agent screenshots it with headless Chrome first, then inspects it. Implies allowCommands.",
			})
		),
		workspace: Type.Optional(Type.String({ description: "Directory to run in (defaults to cwd)." })),
		model: Type.Optional(
			Type.String({
				description: `Model slug — use a gemini-* slug for vision (default: ${config.model}).`,
			})
		),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		allowCommands: Type.Optional(
			Type.Boolean({
				description:
					"Allow shell commands (needed for screenshots or image generation). " +
					"Default: false, or true when `url` is set.",
			})
		),
		continueConv: Type.Optional(
			Type.Boolean({ description: "Continue the previous agy conversation for this workspace." })
		),
		jsonSchema: Type.Optional(
			Type.String({ description: "JSON schema string to constrain the agent's structured output." })
		),
		timeout: Type.Optional(Type.String({ description: `Max wait (default: ${config.timeout}).` })),
	}),
	execute: (id, params, signal, onUpdate, ctx) => {
		const allowCommands = resolveVisionAllowCommands(params.allowCommands, params.url);
		const workspace = params.workspace ? resolveWorkspace(params.workspace, ctx.cwd) : ctx.cwd;
		// Resolve local paths; stage anything outside the workspace so the agent
		// can read it without allowNonWorkspaceAccess in its own settings.
		const staged = stageLocalImages(params.images, workspace);
		if (!staged.images.length && !params.url?.trim()) {
			staged.cleanup();
			throw new Error(
				params.images?.length
					? `agy_vision: no readable image — not found on disk: ${staged.missing.join(", ")}`
					: "agy_vision: provide image file path(s) in `images` or a page `url`"
			);
		}
		const extraWarnings: string[] = [];
		if (staged.missing.length) extraWarnings.push(`image(s) not found, skipped: ${staged.missing.join(", ")}.`);
		if (staged.staged.length)
			extraWarnings.push(
				`copied ${staged.staged.length} image(s) from outside the workspace into a temporary staging directory for this run (removed afterwards).`
			);
		return executeAgy(
			id,
			{
				prompt: buildVisionPrompt({
					prompt: params.prompt,
					images: staged.images,
					url: params.url,
					allowCommands,
				}),
				workspace,
				model: params.model,
				effort: params.effort,
				allowCommands,
				addDirs: staged.addDirs,
				extraWarnings,
				continueConv: params.continueConv,
				jsonSchema: params.jsonSchema,
				timeout: params.timeout,
				preset: "vision",
			},
			signal,
			onUpdate,
			ctx
		).finally(staged.cleanup);
	},
	...singleRenderers("vision"),
});

// Specialist roles (pi-agy's take on pi-subagents' named agents): a prompt
// shape plus an enforced access policy. Read-only roles cannot be widened.
export const agyRole = defineTool({
	name: "agy_role",
	label: "Agy Role (specialist)",
	description:
		"OPT-IN: call this only when the user explicitly asks to use agy / Antigravity for the current task. " +
		"Delegate to a named specialist role on the Antigravity (agy) agent. A role bundles a shaped " +
		"prompt contract with an access policy, which produces much better results than an unstructured " +
		"prompt: " +
		roles.map((r) => `${r.id} (${r.description.replace(/\.$/, "")}${r.readOnly ? ", read-only" : ""})`).join("; ") + ". " +
		"Read-only roles are enforced — a caller cannot grant them write or shell access. " +
		"Use it to scout before planning, review a diff, independently verify claimed evidence, or get a " +
		"second opinion before acting. The result includes evidence (files written, commands run) that " +
		"the orchestrator must still verify.",
	parameters: Type.Object({
		role: Type.String({
			description: `Specialist role id. One of: ${roleIds(roles)}.`,
		}),
		prompt: Type.String({
			description:
				"The task for the specialist. Include the diff, plan, paths, or claims it needs; the role supplies the output contract.",
		}),
		workspace: Type.Optional(Type.String({ description: "Directory to work in (defaults to cwd)." })),
		model: Type.Optional(Type.String({ description: "Override the role's model." })),
		effort: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
		),
		allowCommands: Type.Optional(
			Type.Boolean({
				description:
					"Request write/shell access for a writing role. Ignored (always false) for read-only roles.",
			})
		),
		continueConv: Type.Optional(Type.Boolean({ description: "Continue the previous agy conversation for this workspace." })),
		conversation: Type.Optional(Type.String({ description: "Resume a specific conversation_id." })),
		jsonSchema: Type.Optional(Type.String({ description: "JSON schema to constrain the role's final structured output." })),
		timeout: Type.Optional(Type.String({ description: `Max wait (default: ${config.timeout}).` })),
	}),
	execute: (id, params, signal, onUpdate, ctx) => {
		const role = findRole(roles, params.role);
		if (!role) {
			throw new Error(`agy_role: unknown role "${params.role}"; known roles: ${roleIds(roles)}`);
		}
		const policy = applyRole(role, {
			prompt: params.prompt,
			allowCommands: params.allowCommands,
			model: params.model,
			effort: params.effort,
			jsonSchema: params.jsonSchema,
		});
		return executeAgy(
			id,
			{
				prompt: policy.prompt,
				workspace: params.workspace,
				model: policy.model,
				effort: policy.effort,
				allowCommands: policy.allowCommands,
				continueConv: params.continueConv,
				conversation: params.conversation,
				jsonSchema: policy.jsonSchema,
				timeout: params.timeout,
				preset: "role",
				role: role.id,
			},
			signal,
			onUpdate,
			ctx
		);
	},
	...singleRenderers("role"),
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
	role: Type.Optional(
		Type.String({
			description:
				`Specialist role id (${roleIds(roles)}). Applies that role's prompt contract and access policy to this lane; read-only roles cannot be widened.`,
		})
	),
});

// Fan-out preset: run several agy agents in parallel with a live per-lane board.
export const agyFleet = defineTool({
	name: "agy_fleet",
	label: "Agy Fleet (fan-out)",
	description:
		"OPT-IN: call this only when the user explicitly asks to use agy_fleet / Antigravity for the current task. " +
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
	...fleetRenderers(),
});

export type { FleetTaskParams };