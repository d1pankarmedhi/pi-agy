/**
 * Specialist roles — pi-agy's take on pi-subagents' named agents.
 *
 * pi-subagents defines a specialist as a markdown file with frontmatter: a
 * system prompt plus its access policy (tools, model, thinking). pi-agy
 * delegates to a one-shot CLI, so the equivalent is a *role*: a prompt shape
 * plus an access policy the wrapper enforces.
 *
 * Roles matter because the same Gemini model does very different quality work
 * when it is told "return compressed recon context in this exact shape" versus
 * "review this and report findings with evidence" versus "implement the
 * smallest correct change". They also encode the safety boundary: a read-only
 * role can never be widened into a writing one by a caller or the model.
 *
 * Built-ins are adapted from pi-subagents' scout/worker/reviewer/oracle
 * agents. Users can add or override roles in `~/.pi/agy.json` under `roles`.
 */

export type AgyEffort = "low" | "medium" | "high";

/** A named specialist: prompt shape + enforced access policy. */
export interface AgyRole {
	id: string;
	/** Short human label for cards and the fleet roster. */
	label: string;
	/** One-line description shown in tool results and `/agy-doctor`. */
	description: string;
	/** Prompt preamble prepended to the caller's task. */
	guidance: string;
	/** Default shell/write access for this role. */
	allowCommands: boolean;
	/**
	 * Read-only roles are ENFORCED: `allowCommands` is forced to false and a
	 * caller cannot raise it. This is the safety boundary pi-subagents encodes
	 * with its per-agent tool allowlists.
	 */
	readOnly: boolean;
	/** Default model for the role (falls back to the global model). */
	model?: string;
	/** Default effort for the role (falls back to the global effort). */
	effort?: AgyEffort;
	/** Structured-output schema hint applied to the role's final answer. */
	jsonSchema?: string;
	/** True for roles shipped with the package (user roles may override them). */
	builtin: boolean;
}

/** Fields a user may set when defining or overriding a role in config. */
export type AgyRoleOverride = Partial<Omit<AgyRole, "id" | "builtin">>;

/**
 * Built-in specialists. Prompts are intentionally short and shaped: a one-shot
 * CLI agent follows an explicit output contract far more reliably than a vague
 * instruction, and every role ends by demanding verifiable evidence.
 */
export const BUILTIN_ROLES: readonly Omit<AgyRole, "builtin">[] = [
	{
		id: "scout",
		label: "scout",
		description: "Fast read-only codebase recon that returns compressed context for handoff.",
		allowCommands: false,
		readOnly: true,
		effort: "low",
		guidance: [
			"You are a scouting agent. You have NO write or shell access: use only list_dir, view_file, grep_search, and read_resource.",
			"Move fast but never guess. Start from any paths, symbols, or filenames named in the task; use grep_search for discovery and view_file for targeted reading instead of reading whole files.",
			"Return the minimum context another agent needs to act. Cite exact file paths and line ranges.",
			"Answer in exactly this shape:",
			"# Code Context",
			"## Files Retrieved",
			"1. `path/to/file` (lines a-b) — why it matters",
			"## Key Code",
			"Critical types, functions, and small snippets.",
			"## Architecture",
			"How the pieces connect.",
			"## Start Here",
			"The first file another agent should open, and why.",
			"Do not speculate beyond what you read, and do not attempt to edit anything.",
		].join("\n"),
	},
	{
		id: "implementer",
		label: "implementer",
		description: "Implementation agent: narrow, correct edits plus validation.",
		allowCommands: true,
		readOnly: false,
		effort: "high",
		guidance: [
			"You are the implementation agent and the single writer thread. Execute the assigned task with narrow, coherent edits.",
			"First read the existing code at the named seams, then make the smallest correct change that follows the codebase's existing patterns.",
			"Do not add speculative scaffolding, placeholders, TODOs, or unrelated refactors.",
			"Validate your change with the project's own checks (typecheck, tests, linters) before finishing.",
			"If the task requires a product or architecture decision that was not approved, stop and report the decision instead of guessing.",
			"Finish with exactly this shape:",
			"Implemented: X.",
			"Changed files: Y (exact paths).",
			"Validation: the exact commands you ran and their result.",
			"Open risks/questions: R.",
		].join("\n"),
	},
	{
		id: "reviewer",
		label: "reviewer",
		description: "Read-only review of a diff, plan, or proposal, with evidence and severities.",
		allowCommands: false,
		readOnly: true,
		effort: "high",
		guidance: [
			"You are a disciplined review agent with NO write or shell access. Inspect the actual files; do not guess.",
			"Report only concrete, current problems you can justify from source evidence — a code path, a test result, or a stated contract. Do not invent issues.",
			"Grade each finding P0 (blocks), P1 (fix before release), or P2 (note). For every finding give the exact file and line, the evidence, and the smallest fix.",
			"Prefer citing what is already correct as well, with evidence, so the orchestrator can tell a real review from a rubber stamp.",
			"Use exactly this shape:",
			"## Review",
			"- Correct: what is already good (with file:line evidence)",
			"- Finding: P0/P1/P2 · issue · file:line · evidence · smallest fix",
			"- Merge verdict: BLOCK | OK | OK with notes",
			"If nothing qualifies, say exactly: No issues found.",
		].join("\n"),
	},
	{
		id: "verifier",
		label: "verifier",
		description: "Independently checks whether claimed evidence is actually supported.",
		allowCommands: false,
		readOnly: true,
		effort: "high",
		guidance: [
			"You are an evidence auditor with NO write or shell access. You are given claims together with the artefacts that are supposed to support them.",
			"For each claim, open the cited file and decide whether the claim is SUPPORTED, PARTIALLY SUPPORTED, or UNSUPPORTED, quoting the exact lines that justify your verdict.",
			"A path that does not exist, a symbol that is not there, or a test that does not cover the claim is UNSUPPORTED — say so plainly.",
			"Do not accept a summary as proof, and do not fill gaps with plausible assumptions. Absence of evidence is a finding.",
			"Use exactly this shape:",
			"## Verification",
			"- Claim: <claim>",
			"  - Verdict: SUPPORTED | PARTIALLY SUPPORTED | UNSUPPORTED",
			"  - Evidence: `path:lines` — quoted text",
			"  - Gap: what is missing, if anything",
			"End with an overall verdict line: `Overall: N/M claims supported.`",
		].join("\n"),
	},
	{
		id: "oracle",
		label: "oracle",
		description: "Second opinion before acting: challenges assumptions without editing anything.",
		allowCommands: false,
		readOnly: true,
		effort: "high",
		guidance: [
			"You are an advisory second opinion with NO write or shell access. Your job is to challenge the plan, not to please the caller.",
			"Read whatever the task points at, then attack the direction: what is assumed, what is untested, what will break, what is being ignored, and what a simpler alternative would look like.",
			"Be specific and concrete. Name files, functions, and failure modes. Do not restate the plan back approvingly, and do not edit anything.",
			"Use exactly this shape:",
			"## Assessment",
			"Overall: SOUND | RISKY | WRONG (one line)",
			"## Strongest objection",
			"The single most important problem, with evidence.",
			"## Other concerns",
			"- each with evidence",
			"## Safer alternative",
			"What you would do instead, and the tradeoff.",
			"## Recommended next step",
			"One concrete action.",
		].join("\n"),
	},
];

function isEffort(value: unknown): value is AgyEffort {
	return value === "low" || value === "medium" || value === "high";
}

/**
 * Merge built-in roles with user overrides from config.
 *
 * A user entry whose id matches a builtin overrides only the fields it sets,
 * so `{"reviewer": {"effort": "low"}}` keeps the built-in reviewer prompt.
 * New ids become additional roles.
 */
export function resolveRoles(overrides: Record<string, AgyRoleOverride> | undefined): AgyRole[] {
	const byId = new Map<string, AgyRole>();
	for (const role of BUILTIN_ROLES) byId.set(role.id, { ...role, builtin: true });
	for (const [rawId, override] of Object.entries(overrides ?? {})) {
		const id = rawId.trim().toLowerCase();
		if (!id) continue;
		const base = byId.get(id);
		const merged: AgyRole = {
			id,
			label: override.label ?? base?.label ?? id,
			description: override.description ?? base?.description ?? "Custom role.",
			guidance: override.guidance ?? base?.guidance ?? "",
			allowCommands: override.allowCommands ?? base?.allowCommands ?? false,
			// A role that declares a prompt but not an access level is read-only
			// by default: silence must never grant write access.
			readOnly: override.readOnly ?? (override.allowCommands === true ? false : base?.readOnly ?? true),
			model: override.model ?? base?.model,
			effort: isEffort(override.effort) ? override.effort : base?.effort,
			jsonSchema: override.jsonSchema ?? base?.jsonSchema,
			builtin: base?.builtin ?? false,
		};
		// Read-only always wins over a contradicting allowCommands.
		if (merged.readOnly) merged.allowCommands = false;
		byId.set(id, merged);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Look up a role by id (case-insensitive). */
export function findRole(roles: readonly AgyRole[], id: string | undefined): AgyRole | undefined {
	if (!id) return undefined;
	return roles.find((role) => role.id === id.trim().toLowerCase());
}

/** Caller-supplied values that a role may tighten or fill in. */
export interface RoleInput {
	prompt: string;
	allowCommands?: boolean;
	model?: string;
	effort?: AgyEffort;
	jsonSchema?: string;
}

/** The effective run policy after applying a role. */
export interface RoleResolution {
	prompt: string;
	allowCommands: boolean;
	model?: string;
	effort?: AgyEffort;
	jsonSchema?: string;
}

/**
 * Apply a role to a caller's request.
 *
 * The role supplies defaults; the caller may override the model and effort. The
 * role's access policy is authoritative: a read-only role forces
 * `allowCommands: false`, and a writing role defaults to true.
 */
export function applyRole(role: AgyRole, input: RoleInput): RoleResolution {
	const allowCommands = role.readOnly ? false : input.allowCommands ?? role.allowCommands;
	return {
		prompt: role.guidance ? `${role.guidance}\n\n---\n\nTask:\n${input.prompt}` : input.prompt,
		allowCommands,
		model: input.model ?? role.model,
		effort: input.effort ?? role.effort,
		jsonSchema: input.jsonSchema ?? role.jsonSchema,
	};
}

/** Compact list of role ids, for error messages. */
export function roleIds(roles: readonly AgyRole[]): string {
	return roles.map((role) => role.id).join(", ");
}
