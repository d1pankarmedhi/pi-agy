/**
 * Card renderers for pi-agy tools.
 *
 * Each tool exposes `renderCall` / `renderResult` built from the pure
 * `*Lines(...)` functions below. The builders are plain `(…, width, theme) =>
 * string[]` so they can be unit-tested without a terminal, and they adapt their
 * layout to the width pi hands them (wide table ⇄ stacked rows).
 *
 * Design goals: information-dense but calm — a status header, live activity,
 * a stat row, and the evidence (files, commands, run log) an orchestrator needs
 * to verify a delegated run, without opening the transcript.
 */

import type { Theme, ToolRenderResultOptions, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { formatDuration, isWriteTool, toDisplayPath, type LiveActivity, type StepRecord } from "./status.ts";
import {
	compactNumber,
	divider,
	fitParts,
	listSection,
	oneLine,
	pad,
	plural,
	row,
	trunc,
	View,
	visibleWidth,
	wrap,
	wrapCount,
	type ThemeLike,
} from "./ui.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type AgyPreset = "run" | "explore" | "code" | "vision";

export interface AgyMeta {
	preset: AgyPreset;
	model: string;
	effort?: string;
	workspace: string;
	allowCommands: boolean;
	timeout?: string;
	continueConv?: boolean;
	conversation?: string;
	agent?: string;
}

export interface AgyCallArgs {
	prompt?: string;
	/** agy_vision: image files to inspect. */
	images?: string[];
	/** agy_vision: page URL to screenshot before inspecting. */
	url?: string;
	workspace?: string;
	model?: string;
	effort?: string;
	agent?: string;
	allowCommands?: boolean;
	continueConv?: boolean;
	conversation?: string;
	jsonSchema?: string;
	timeout?: string;
}

export interface FleetTaskArgs extends AgyCallArgs {
	id?: string;
	task?: string;
}

export interface FleetCallArgs extends AgyCallArgs {
	tasks?: FleetTaskArgs[];
	concurrency?: number;
}

/** Details payload carried by `onUpdate` (live) and the final tool result. */
export interface SingleDetails {
	streaming?: boolean;
	status?: string;
	phase?: LiveActivity["phase"];
	step?: number;
	tool?: string;
	file?: string;
	command?: string;
	stepsDone?: number;
	filesTouched?: string[];
	elapsedMs?: number;
	recent?: StepRecord[];
	preview?: string;
	meta?: AgyMeta;
	// final-result fields
	steps?: StepRecord[];
	files_written?: string[];
	commands_run?: string[];
	warnings?: string[];
	response?: string;
	num_turns?: number;
	duration_seconds?: number;
	usage?: Record<string, number>;
	conversation_id?: string;
	toolSteps?: number;
	/** Error text from pi when the tool failed before/without a card result. */
	errorText?: string;
}

export interface FleetLaneDetails {
	id: string;
	task?: string;
	workspace?: string;
	status: "queued" | "running" | "done" | "failed" | "aborted";
	error?: string;
	activity?: LiveActivity;
	elapsedMs?: number;
	response?: string;
	files_written?: string[];
	commands_run?: string[];
	conversation_id?: string;
	num_turns?: number;
	duration_seconds?: number;
	usage?: Record<string, number>;
}

export interface FleetDetails {
	streaming?: boolean;
	status?: string;
	lanes?: FleetLaneDetails[];
	concurrency?: number;
	elapsedMs?: number;
	total?: number;
	succeeded?: number;
	failed?: number;
	aborted?: number;
	/** Error text from pi when the tool failed before/without a card result. */
	errorText?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const PRESETS: Record<AgyPreset, { title: string; tag: string; readOnly: boolean }> = {
	run: { title: "agy", tag: "delegate", readOnly: false },
	explore: { title: "agy_explore", tag: "read-only", readOnly: true },
	code: { title: "agy_code", tag: "implement", readOnly: false },
	vision: { title: "agy_vision", tag: "image", readOnly: true },
};

const RESPONSE_COLLAPSED_LINES = 34;
const RECENT_STEPS = 5;
const LOG_COLLAPSED = 8;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function phaseGlyph(phase: LiveActivity["phase"] | undefined): string {
	switch (phase) {
		case "tool":
			return "▸";
		case "writing":
			return "»";
		case "done":
			return "✓";
		default:
			return "…";
	}
}

function phaseColor(phase: LiveActivity["phase"] | undefined): "accent" | "success" | "muted" {
	if (phase === "done") return "success";
	if (phase === "tool" || phase === "writing") return "accent";
	return "muted";
}

/** Semantically honest glyph for an agy tool name (`✎` writes, `▤` reads, `⌕` searches). */
function toolIcon(tool: string | undefined): string {
	const t = (tool ?? "").toLowerCase();
	if (!t) return "⚙";
	if (t.includes("command") || t.includes("shell") || t.includes("exec")) return "$";
	if (isWriteTool(t)) return "✎";
	if (/(grep|search|find|query)/.test(t)) return "⌕";
	if (/(list|dir|glob)/.test(t)) return "⌂";
	if (/(read|view|open|cat|fetch)/.test(t)) return "▤";
	return "⚙";
}

function stateGlyph(status: FleetLaneDetails["status"]): string {
	switch (status) {
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "aborted":
			return "✗";
		case "running":
			return "▸";
		default:
			return "○";
	}
}

function stateColor(status: FleetLaneDetails["status"]): "success" | "error" | "warning" | "accent" | "muted" {
	switch (status) {
		case "done":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		case "running":
			return "accent";
		default:
			return "muted";
	}
}

function stateWord(status: FleetLaneDetails["status"]): string {
	return status === "queued" ? "waiting" : status;
}

/** `◆ title · subtitle…` with an optional right-aligned value. */
function titleLine(
	opts: {
		icon: string;
		color: "accent" | "success" | "error" | "warning" | "muted";
		title: string;
		subtitleParts?: (string | undefined)[];
		right?: string;
	},
	width: number,
	theme: ThemeLike
): string {
	const prefix = theme.fg(opts.color, opts.icon + " ") + theme.fg("toolTitle", theme.bold(opts.title));
	const right = opts.right ? theme.fg("dim", opts.right) : "";
	const sep = theme.fg("muted", " · ");
	const budget =
		width - visibleWidth(prefix) - visibleWidth(right) - (right ? 2 : 0) - visibleWidth(sep);
	const subtitle = opts.subtitleParts ? fitParts(opts.subtitleParts, Math.max(0, budget), sep) : "";
	const left = prefix + (subtitle ? sep + subtitle : "");
	return row(left, right, width);
}

/** Human label for the agent's current action, without color. */
function activityText(d: SingleDetails): string {
	if (d.command) return `$ ${oneLine(d.command)}`;
	if (d.file) return `${toolIcon(d.tool)} ${oneLine(d.file)}`;
	if (d.phase === "writing") return "writing response";
	if (d.phase === "done") return "done";
	if (d.tool && d.tool !== "run_command") return d.tool.replace(/_/g, " ");
	return "thinking";
}

function stepGlyph(step: StepRecord): { icon: string; color: "accent" | "success" } {
	if (step.state === "active") return { icon: "▸", color: "accent" };
	return { icon: "✓", color: "success" };
}

function stepWhat(step: StepRecord): string {
	if (step.command) return `$ ${oneLine(step.command)}`;
	if (step.file) return `${toolIcon(step.tool)} ${oneLine(step.file)}`;
	return (step.tool ?? "tool").replace(/_/g, " ");
}

/** `files` evidence, workspace-relative and deduped. */
function displayFiles(files: string[] | undefined, workspace: string | undefined): string[] {
	if (!files?.length) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of files) {
		const display = workspace ? toDisplayPath(f, workspace) : f;
		if (seen.has(display)) continue;
		seen.add(display);
		out.push(display);
	}
	return out;
}

function buildMetrics(d: SingleDetails, theme: ThemeLike, maxWidth = Number.POSITIVE_INFINITY): string {
	const steps = d.toolSteps ?? d.steps?.length ?? d.stepsDone ?? 0;
	const files = d.files_written?.length ?? d.filesTouched?.length ?? 0;
	const commands = d.commands_run?.length ?? 0;
	const parts: string[] = [];
	if (steps) parts.push(theme.fg("muted", "steps ") + theme.fg("accent", String(steps)));
	if (files) parts.push(theme.fg("muted", "files ") + theme.fg("accent", String(files)));
	if (commands) parts.push(theme.fg("muted", "commands ") + theme.fg("accent", String(commands)));
	if (d.num_turns) parts.push(theme.fg("muted", "turns ") + theme.fg("accent", String(d.num_turns)));
	const tokens = d.usage?.total_tokens;
	if (typeof tokens === "number" && tokens > 0) {
		parts.push(theme.fg("muted", "tokens ") + theme.fg("accent", compactNumber(tokens)));
	}
	const sep = theme.fg("borderMuted", " · ");
	if (!Number.isFinite(maxWidth)) return parts.join(sep);
	return fitParts(parts, maxWidth, sep);
}

function runLogLines(
	steps: StepRecord[] | undefined,
	width: number,
	theme: ThemeLike,
	expanded: boolean
): string[] {
	const done = (steps ?? []).filter((s) => s.state === "done");
	if (!done.length) return [];
	const shown = expanded ? done : done.slice(-LOG_COLLAPSED);
	const out: string[] = [];
	for (const s of shown) {
		const where = trunc(stepWhat(s), Math.max(8, width - 10));
		out.push(
			"  " +
				theme.fg("dim", String(s.index).padStart(2, " ")) +
				theme.fg("borderMuted", "  ") +
				theme.fg("success", "✓") +
				" " +
				theme.fg("text", where)
		);
	}
	if (!expanded && done.length > shown.length) {
		out.unshift(theme.fg("dim", `  … ${done.length - shown.length} earlier steps`));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Single-run card
// ---------------------------------------------------------------------------

export function singleCallLines(
	preset: AgyPreset,
	args: AgyCallArgs,
	width: number,
	theme: ThemeLike
): string[] {
	const def = PRESETS[preset] ?? PRESETS.run;
	const lines: string[] = [];
	const badges = [theme.fg("muted", def.tag)];
	if (args.allowCommands) badges.push(theme.fg("warning", "shell"));
	if (args.continueConv || args.conversation) badges.push(theme.fg("accent", "continue"));
	lines.push(
		titleLine(
			{
				icon: "◆",
				color: "accent",
				title: def.title,
				subtitleParts: badges,
			},
			width,
			theme
		)
	);

	const meta: string[] = [];
	if (args.model) meta.push(args.model);
	if (args.effort) meta.push(`${args.effort} effort`);
	if (args.agent) meta.push(`agent ${args.agent}`);
	if (args.images?.length) {
		const n = args.images.length;
		meta.push(`${n} image${n === 1 ? "" : "s"}`);
	}
	if (args.url) meta.push(`screenshot ${args.url}`);
	if (args.timeout) meta.push(`timeout ${args.timeout}`);
	if (args.workspace) meta.push(args.workspace);
	if (meta.length) {
		const fit = fitParts(meta, Math.max(0, width - 2), "  ·  ");
		if (fit) lines.push("  " + theme.fg("dim", fit));
	}

	const prompt = oneLine(args.prompt ?? "");
	if (prompt) {
		const preview = wrap(prompt, Math.max(1, width - 2), width >= 72 ? 2 : 1);
		for (const line of preview) lines.push("  " + theme.fg("text", line));
	}
	return lines;
}

export function singleActivityLines(
	_preset: AgyPreset,
	d: SingleDetails,
	width: number,
	theme: ThemeLike
): string[] {
	const phase = d.phase ?? "thinking";
	const lines: string[] = [];
	const elapsed = d.elapsedMs ?? 0;

	const target = activityText(d);
	const label =
		phase === "thinking" || phase === "writing" || phase === "done"
			? theme.fg("muted", target)
			: theme.fg("text", target);
	const left =
		theme.fg(phaseColor(phase), phaseGlyph(phase) + " ") +
		theme.fg("dim", `step ${d.step ?? 0}`) +
		theme.fg("borderMuted", "  ·  ") +
		label;
	lines.push(row(left, elapsed >= 1000 ? theme.fg("dim", formatDuration(elapsed)) : "", width));

	const metrics = buildMetrics(d, theme, Math.max(0, width - 2));
	if (metrics) lines.push("  " + metrics);

	const recent = (d.recent ?? []).slice(-RECENT_STEPS);
	if (recent.length) {
		lines.push(divider(width, theme));
		for (const s of recent) {
			const { icon, color } = stepGlyph(s);
			const where = trunc(stepWhat(s), Math.max(8, width - 10));
			lines.push(
				"  " +
					theme.fg(color, icon) +
					" " +
					theme.fg("dim", String(s.index).padStart(2, " ")) +
					"  " +
					theme.fg(s.state === "active" ? "text" : "toolOutput", where)
			);
		}
	}

	const preview = (d.preview ?? "").trim();
	if (d.phase === "writing" && preview) {
		lines.push(divider(width, theme));
		const tail = wrap(preview, Math.max(1, width - 2), 4);
		for (const line of tail) lines.push("  " + theme.fg("dim", line));
	}
	return lines;
}

export function singleResultLines(
	_preset: AgyPreset,
	d: SingleDetails,
	width: number,
	theme: ThemeLike,
	expanded: boolean
): string[] {
	const errorText = (d.errorText ?? "").trim();
	const failed = Boolean(errorText) || (Boolean(d.warnings?.length) && !d.response?.trim());
	const lines: string[] = [];
	const duration =
		typeof d.duration_seconds === "number"
			? formatDuration(d.duration_seconds * 1000)
			: d.elapsedMs
				? formatDuration(d.elapsedMs)
				: undefined;

	// The call card above already carries the tool title + model, so the result
	// card is a status continuation: `✓ done · 50 steps · 6 files · …`.
	const statusText = theme.fg(
		failed ? "error" : "success",
		(failed ? "✗ " : "✓ ") + (failed ? "failed" : "done")
	);
	const durationText = duration ? theme.fg("dim", duration) : "";
	// `left` is `statusText + " · " + metrics` and `row()` reserves a 2-col gap
	// before `durationText`; budget the metrics for exactly those 5 columns.
	const metricBudget =
		width - visibleWidth(statusText) - visibleWidth(durationText) - (durationText ? 2 : 0) - 3;
	const metrics = buildMetrics(d, theme, Math.max(0, metricBudget));
	const left = statusText + (metrics ? theme.fg("borderMuted", " · ") + metrics : "");
	lines.push(row(left, durationText, width));
	lines.push(divider(width, theme));

	if (errorText) {
		for (const line of wrap(errorText, Math.max(1, width - 2), expanded ? Number.POSITIVE_INFINITY : 6)) {
			lines.push("  " + theme.fg("error", line));
		}
	}

	if (d.warnings?.length) {
		for (const warning of d.warnings) {
			for (const line of wrap(`⚠ ${warning}`, Math.max(1, width - 2), 4)) {
				lines.push("  " + theme.fg("warning", line));
			}
		}
		lines.push("");
	}

	const response = (d.response ?? "").trim();
	if (response) {
		const maxLines = expanded ? Number.POSITIVE_INFINITY : RESPONSE_COLLAPSED_LINES;
		const shown = wrap(response, width, maxLines);
		for (const line of shown) lines.push(theme.fg("toolOutput", line));
		const total = wrapCount(response, width);
		if (total > shown.length) {
			lines.push(theme.fg("dim", `… +${total - shown.length} lines  ·  Ctrl+O to expand`));
		}
	} else if (!errorText) {
		lines.push("  " + theme.fg("dim", "(the agy agent returned no text)"));
	}

	const files = displayFiles(d.files_written, d.meta?.workspace);
	const commands = d.commands_run ?? [];
	const evidenceMax = expanded ? undefined : 4;
	const evidence: string[] = [];
	if (files.length) evidence.push(...listSection("files", files, width, theme, { max: evidenceMax }));
	if (commands.length) evidence.push(...listSection("ran", commands, width, theme, { max: evidenceMax }));
	if (evidence.length) {
		lines.push(divider(width, theme));
		lines.push(...evidence);
	}

	const log = runLogLines(d.steps, width, theme, expanded);
	if (log.length) {
		lines.push(divider(width, theme));
		const totalSteps = (d.steps ?? []).filter((s) => s.state === "done").length;
		lines.push(
			trunc(
				"  " +
					theme.fg("muted", "run log") +
					theme.fg("dim", `  ${expanded ? totalSteps : Math.min(totalSteps, LOG_COLLAPSED)} of ${totalSteps} steps`) +
					(!expanded && totalSteps > LOG_COLLAPSED ? theme.fg("dim", "  ·  Ctrl+O to expand") : ""),
				width
			)
		);
		lines.push(...log);
	}

	if (expanded && (d.meta?.workspace || d.conversation_id)) {
		lines.push(divider(width, theme));
		if (d.meta?.workspace) {
			lines.push(
				"  " +
					theme.fg("dim", "workspace  ") +
					theme.fg("text", trunc(d.meta.workspace, Math.max(0, width - 15)))
			);
		}
		if (d.conversation_id) {
			lines.push(
				"  " +
					theme.fg("dim", "conversation  ") +
					theme.fg("text", trunc(d.conversation_id, Math.max(0, width - 16)))
			);
		}
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Fleet card
// ---------------------------------------------------------------------------

export function fleetCallLines(args: FleetCallArgs, width: number, theme: ThemeLike): string[] {
	const tasks = args.tasks ?? [];
	const lines: string[] = [];
	lines.push(
		titleLine(
			{
				icon: "◆",
				color: "accent",
				title: "agy_fleet",
				subtitleParts: [
					`${tasks.length} lane${tasks.length === 1 ? "" : "s"}`,
					`concurrency ${args.concurrency ?? "auto"}`,
					args.allowCommands ? "shell" : undefined,
				].map((s) => (s ? theme.fg("muted", s) : undefined)),
			},
			width,
			theme
		)
	);

	const cap = width >= 96 ? 8 : width >= 64 ? 5 : 3;
	const idWidth = Math.min(12, Math.max(2, ...tasks.map((t) => (t.id ?? "").length)));
	for (let i = 0; i < Math.min(tasks.length, cap); i++) {
		const t = tasks[i]!;
		const id = trunc(t.id ?? `t${i + 1}`, idWidth);
		// Only show a workspace when it leaves room for a useful task preview.
		const wsBudget = Math.max(0, width - 4 - idWidth - 16);
		const wsText = t.workspace && wsBudget >= 8 ? trunc(t.workspace, Math.min(28, wsBudget)) : "";
		const ws = wsText ? theme.fg("dim", `  ${wsText}`) : "";
		const taskText = oneLine(t.task ?? "");
		const budget = Math.max(8, width - 4 - idWidth - (wsText ? visibleWidth(wsText) + 2 : 0));
		lines.push(
			"  " +
				theme.fg("accent", pad(id, idWidth)) +
				ws +
				"  " +
				theme.fg("text", trunc(taskText, budget))
		);
	}
	if (tasks.length > cap) lines.push("  " + theme.fg("dim", `… +${tasks.length - cap} more lanes`));
	return lines;
}

function laneElapsed(lane: FleetLaneDetails): string {
	if (lane.status === "queued") return "—";
	if (lane.duration_seconds != null) return formatDuration(lane.duration_seconds * 1000);
	if (lane.elapsedMs != null) return formatDuration(lane.elapsedMs);
	if (lane.activity?.elapsedMs) return formatDuration(lane.activity.elapsedMs);
	return "";
}

function laneActivity(lane: FleetLaneDetails): string {
	if (lane.status === "queued") return "waiting";
	if (lane.status === "failed" || lane.status === "aborted") {
		return lane.error ? trunc(oneLine(lane.error), 60) : lane.status;
	}
	if (lane.status === "done") {
		const bits: string[] = [];
		if (lane.files_written?.length) bits.push(plural(lane.files_written.length, "file"));
		if (lane.commands_run?.length) bits.push(plural(lane.commands_run.length, "cmd"));
		return bits.join(" · ") || "done";
	}
	const a: LiveActivity | undefined = lane.activity;
	if (!a) return "starting";
	if (a.command) return `$ ${oneLine(a.command)}`;
	if (a.file) return `${toolIcon(a.tool)} ${a.file}`;
	if (a.phase === "writing") return "writing response";
	if (a.tool && a.tool !== "run_command") return a.tool.replace(/_/g, " ");
	return "thinking";
}

export function fleetBoardLines(d: FleetDetails, width: number, theme: ThemeLike): string[] {
	const lanes = d.lanes ?? [];
	const done = lanes.filter((l) => l.status === "done").length;
	const failed = lanes.filter((l) => l.status === "failed" || l.status === "aborted").length;
	const active = lanes.filter((l) => l.status === "running" || l.status === "queued").length;
	const icon = failed ? "◐" : active ? "▸" : "✓";
	const color: "accent" | "success" | "warning" = failed ? "warning" : active ? "accent" : "success";
	const lines: string[] = [];
	const summary = [
		`${lanes.length} lanes`,
		active ? `${active} active` : undefined,
		`${done} done`,
		failed ? `${failed} failed` : undefined,
	]
		.filter(Boolean)
		.join(theme.fg("borderMuted", " · "));
	lines.push(
		row(
			theme.fg(color, icon + " ") + theme.fg("muted", summary),
			d.elapsedMs ? theme.fg("dim", formatDuration(d.elapsedMs)) : "",
			width
		)
	);
	lines.push(divider(width, theme));

	const wide = width >= 84;
	const idWidth = Math.min(14, Math.max(2, ...lanes.map((l) => (l.id ?? "").length)));
	for (const lane of lanes) {
		const glyph = theme.fg(stateColor(lane.status), stateGlyph(lane.status));
		const id = theme.fg("accent", pad(trunc(lane.id ?? "?", idWidth), idWidth));
		const elapsedText = laneElapsed(lane);
		if (wide) {
			const word = theme.fg(stateColor(lane.status), stateWord(lane.status).padEnd(8));
			const stepText =
				lane.status === "running" && lane.activity?.step != null
					? theme.fg("dim", `step ${lane.activity.step}`)
					: theme.fg("dim", "—");
			const left = `${glyph} ${id}  ${word}  ${stepText}  `;
			const target = trunc(laneActivity(lane), Math.max(4, width - 34 - idWidth));
			lines.push(row(left + theme.fg("text", target), theme.fg("dim", elapsedText), width));
		} else {
			const budget = Math.max(4, width - idWidth - 6 - visibleWidth(elapsedText) - (elapsedText ? 2 : 0));
			lines.push(
				row(
					`${glyph} ${id}  ` + theme.fg("text", trunc(laneActivity(lane), budget)),
					elapsedText ? theme.fg("dim", elapsedText) : "",
					width
				)
			);
		}
	}
	return lines;
}

export function fleetResultLines(
	d: FleetDetails,
	width: number,
	theme: ThemeLike,
	expanded: boolean
): string[] {
	const errorText = (d.errorText ?? "").trim();
	if (errorText) {
		return [
			row(theme.fg("error", "✗ ") + theme.fg("muted", "agy_fleet failed"), "", width),
			divider(width, theme),
			...wrap(errorText, Math.max(1, width - 2), 8).map((line) => "  " + theme.fg("error", line)),
		];
	}
	const lanes = d.lanes ?? [];
	const succeeded = d.succeeded ?? lanes.filter((l) => l.status === "done").length;
	const failedList = lanes.filter((l) => l.status !== "done");
	const failed = d.failed ?? failedList.filter((l) => l.status === "failed").length;
	const aborted = d.aborted ?? failedList.filter((l) => l.status === "aborted").length;
	const icon = failed + aborted ? (succeeded ? "◐" : "✗") : "✓";
	const color: "success" | "error" | "warning" =
		!failed && !aborted ? "success" : succeeded ? "warning" : "error";
	const lines: string[] = [];
	const summary = [
		`${succeeded}/${lanes.length} lanes`,
		failed ? `${failed} failed` : undefined,
		aborted ? `${aborted} aborted` : undefined,
		d.concurrency ? `concurrency ${d.concurrency}` : undefined,
	]
		.filter(Boolean)
		.join(theme.fg("borderMuted", " · "));
	lines.push(
		row(
			theme.fg(color, icon + " ") + theme.fg("muted", summary),
			d.elapsedMs ? theme.fg("dim", formatDuration(d.elapsedMs)) : "",
			width
		)
	);
	lines.push(divider(width, theme));

	for (const lane of lanes) {
		const glyph = theme.fg(stateColor(lane.status), stateGlyph(lane.status));
		const dur =
			lane.duration_seconds != null
				? formatDuration(lane.duration_seconds * 1000)
				: lane.elapsedMs != null
					? formatDuration(lane.elapsedMs)
					: lane.activity?.elapsedMs
						? formatDuration(lane.activity.elapsedMs)
						: undefined;
		const laneId = trunc(lane.id ?? "?", Math.max(4, Math.min(24, width - 10)));
		const bits: string[] = [];
		if (lane.files_written?.length) bits.push(plural(lane.files_written.length, "file"));
		if (lane.commands_run?.length) bits.push(plural(lane.commands_run.length, "command"));
		if (lane.num_turns) bits.push(plural(lane.num_turns, "turn"));
		if (dur) bits.push(dur);
		if (lane.status !== "done") {
			const why = lane.status === "aborted" ? "aborted" : lane.error ? trunc(oneLine(lane.error), 90) : lane.status;
			lines.push(
				row(
					`  ${glyph} ${theme.fg("accent", laneId)}  ${theme.fg("error", why)}`,
					dur ? theme.fg("dim", dur) : "",
					width
				)
			);
		} else {
			lines.push(
				row(
					`  ${glyph} ${theme.fg("accent", laneId)}  ${theme.fg("muted", bits.join(" · ") || "done")}`,
					"",
					width
				)
			);
		}
		if (lane.status === "done" && lane.response?.trim()) {
			const maxLines = expanded ? 10 : 3;
			for (const line of wrap(oneLine(lane.response), Math.max(1, width - 6), maxLines)) {
				lines.push("     " + theme.fg("toolOutput", line));
			}
		} else if (lane.status !== "done" && lane.task) {
			lines.push("     " + theme.fg("dim", trunc("task: " + oneLine(lane.task), Math.max(4, width - 6))));
		}
	}

	const evidence: string[] = [];
	for (const lane of lanes) {
		if (lane.status !== "done") continue;
		const files = displayFiles(lane.files_written, lane.workspace);
		const commands = lane.commands_run ?? [];
		const tag = trunc(lane.id ?? "?", 24);
		if (files.length) evidence.push(`[${tag}] files: ${files.slice(0, expanded ? 20 : 4).join(", ")}`);
		if (commands.length) evidence.push(`[${tag}] ran: ${commands.slice(0, expanded ? 10 : 3).join(" | ")}`);
	}
	if (evidence.length) {
		lines.push(divider(width, theme));
		lines.push("  " + theme.fg("muted", "evidence"));
		for (const line of evidence) lines.push("    " + theme.fg("text", trunc(line, Math.max(4, width - 4))));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Renderer factories (wired into the tool definitions)
// ---------------------------------------------------------------------------

function detailsOf<T>(details: unknown): T {
	return asRecord(details) as unknown as T;
}

/** Join the text blocks of a tool result (used for pi-generated error results). */
function resultText(result: AgentToolResult<unknown>): string {
	const blocks = Array.isArray(result.content) ? result.content : [];
	return blocks
		.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
		.map((b) => String((b as { text?: unknown }).text ?? ""))
		.join("\n")
		.trim();
}

/**
 * pi passes a tool's error flag on the render *context* (not the result it
 * builds for renderers), so read it there and surface the error text instead of
 * rendering a green success card.
 */
function errorOf(result: AgentToolResult<unknown>, context: unknown): string | undefined {
	if (!(asRecord(context) as { isError?: boolean }).isError) return undefined;
	return resultText(result) || "the agy tool failed";
}

/** renderCall / renderResult for the single-run presets. */
export function singleRenderers(preset: AgyPreset): {
	renderCall: (args: AgyCallArgs, theme: Theme, context: unknown) => Component;
	renderResult: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: unknown
	) => Component;
} {
	return {
		renderCall(args, theme) {
			return new View((width) => singleCallLines(preset, args ?? {}, width, theme));
		},
		renderResult(result, options, theme, context) {
			const errorText = errorOf(result, context);
			const details: SingleDetails = { ...detailsOf<SingleDetails>(result.details), errorText };
			const effective = details.meta?.preset ?? preset;
			return new View((width) =>
				options.isPartial
					? singleActivityLines(effective, details, width, theme)
					: singleResultLines(effective, details, width, theme, options.expanded)
			);
		},
	};
}

/** renderCall / renderResult for `agy_fleet`. */
export function fleetRenderers(): {
	renderCall: (args: FleetCallArgs, theme: Theme, context: unknown) => Component;
	renderResult: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: unknown
	) => Component;
} {
	return {
		renderCall(args, theme) {
			return new View((width) => fleetCallLines(args ?? {}, width, theme));
		},
		renderResult(result, options, theme, context) {
			const errorText = errorOf(result, context);
			const details: FleetDetails = { ...detailsOf<FleetDetails>(result.details), errorText };
			return new View((width) =>
				options.isPartial
					? fleetBoardLines(details, width, theme)
					: fleetResultLines(details, width, theme, options.expanded)
			);
		},
	};
}
