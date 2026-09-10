import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgyMeta } from "./render.ts";
import type { StreamResult } from "./runner.ts";
import { buildRunLog, type StepRecord } from "./status.ts";

/**
 * Turns a finished agy run into the tool result shown to pi: the agent's
 * response, any warnings, the run log of every tool step, and the evidence
 * (files written, commands run) the orchestrator verifies against.
 */
export interface BuildResultOptions {
	workspace: string;
	model: string;
	allowCommands: boolean;
	steps?: StepRecord[];
	/** Warnings produced by the caller (e.g. unresolved image paths). */
	extraWarnings?: readonly string[];
	/** Run metadata for the TUI card (preset, effort, timeout, …). */
	meta?: AgyMeta;
}

export function buildResult(
	r: StreamResult,
	opts: BuildResultOptions
): { content: AgentToolResult<unknown>["content"]; details: Record<string, unknown> } {
	const meta: string[] = [];
	if (r.conversation_id) meta.push(`conversation_id=${r.conversation_id}`);
	if (r.num_turns !== undefined) meta.push(`turns=${r.num_turns}`);
	if (r.duration_seconds !== undefined) meta.push(`duration=${r.duration_seconds.toFixed(1)}s`);
	if (r.usage?.total_tokens !== undefined) meta.push(`tokens=${r.usage.total_tokens}`);

	let text = r.response?.trim() || "(the agy agent returned no text)";
	const warnings = [...(opts.extraWarnings ?? []), ...(r.warnings ?? [])];
	if (warnings.length) {
		text += `\n\n⚠️ ${warnings.join(" ")}`;
	}

	// Run log: the terminal trail of every tool step the agent performed.
	const steps = opts.steps ?? [];
	const log = buildRunLog(steps);
	if (log.length) text += `\n\nRun log (${steps.length} steps):\n${log.join("\n")}`;

	// Evidence the orchestrator can verify against.
	const evidence: string[] = [];
	if (r.files_written?.length) evidence.push(`files written: ${r.files_written.join(", ")}`);
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
			warnings: warnings.length ? warnings : undefined,
			files_written: r.files_written,
			commands_run: r.commands_run,
			workspace: opts.workspace,
			toolSteps: r.tool_steps ?? 0,
			model: opts.model,
			allowCommands: opts.allowCommands,
			steps,
			meta: opts.meta,
		},
	};
}