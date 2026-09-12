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
import {
	activityFreshnessText,
	activityState,
	formatDuration,
	isWriteTool,
	toDisplayPath,
	toolDurationMs,
	type LiveActivity,
	type StepRecord,
} from "./status.ts";
import {
	compactNumber,
	divider,
	fitParts,
	formatTokens,
	frameAt,
	listSection,
	oneLine,
	pad,
	plural,
	row,
	spinnerGlyph,
	treeBranch,
	trunc,
	truncLine,
	View,
	visibleWidth,
	wrap,
	wrapCount,
	type RenderComponent,
	type ThemeLike,
} from "./ui.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type AgyPreset = "run" | "code" | "vision" | "role";

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
	/** Specialist role id, when the run used `agy_role`. */
	role?: string;
}

export interface AgyCallArgs {
	prompt?: string;
	/** agy_role: the specialist role id. */
	role?: string;
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
	lastActivityAt?: number;
	toolStartedAt?: number;
	outputTail?: string[];
	tokens?: number;
	turns?: number;
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
	warnings?: string[];
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
	code: { title: "agy_code", tag: "implement", readOnly: false },
	vision: { title: "agy_vision", tag: "image", readOnly: true },
	role: { title: "agy_role", tag: "specialist", readOnly: false },
};

const RESPONSE_COLLAPSED_LINES = 34;
const RECENT_STEPS = 5;
const LOG_COLLAPSED = 8;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Belt-and-braces width clamp for the pure builders.
 *
 * `View` already clamps on the way to the terminal, but `View` is not the only
 * consumer (tests and `renderShell: "self"` callers use the builders directly),
 * so every builder clamps its own output too: no caller can receive a line
 * wider than it asked for, at any width from 1 upward. `trunc` is
 * ANSI-preserving, so styling survives the clamp.
 */
function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => trunc(line.replace(/\r?\n/g, " "), width));
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

function stepGlyph(step: StepRecord): { icon: string; color: "accent" | "success" | "error" } {
	if (step.state === "active") return { icon: "▸", color: "accent" };
	if (step.state === "failed") return { icon: "✗", color: "error" };
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
	const terminal = (steps ?? []).filter((s) => s.state !== "active");
	if (!terminal.length) return [];
	const shown = expanded ? terminal : terminal.slice(-LOG_COLLAPSED);
	const out: string[] = [];
	for (const s of shown) {
		const where = trunc(stepWhat(s), Math.max(8, width - 10));
		out.push(
			"  " +
				theme.fg("dim", String(s.index).padStart(2, " ")) +
				theme.fg("borderMuted", "  ") +
				theme.fg(s.state === "failed" ? "error" : "success", s.state === "failed" ? "✗" : "✓") +
				" " +
				theme.fg("text", where)
		);
	}
	if (!expanded && terminal.length > shown.length) {
		out.unshift(theme.fg("dim", `  … ${terminal.length - shown.length} earlier steps`));
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
	// A role run is identified by its specialist, not by the generic preset.
	if (args.role) badges.unshift(theme.fg("accent", args.role));
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
	return clampLines(lines, width);
}

function formatToolDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	const sec = clamped / 1000;
	if (sec < 60) {
		return `${sec.toFixed(1)}s`;
	}
	return formatDuration(clamped);
}

function seedFromRun(d: SingleDetails): number {
	const id = d.conversation_id ?? d.meta?.conversation ?? d.meta?.agent;
	if (id) {
		let h = 0;
		for (let i = 0; i < id.length; i++) {
			h = (h * 31 + id.charCodeAt(i)) | 0;
		}
		return Math.abs(h);
	}
	return d.step ?? 0;
}

function seedFromLane(lane: FleetLaneDetails): number {
	const id = lane.id;
	if (!id) return 0;
	let h = 0;
	for (let i = 0; i < id.length; i++) {
		h = (h * 31 + id.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

function asLiveActivity(d: SingleDetails): LiveActivity {
	return {
		step: d.step ?? 0,
		phase: d.phase ?? "thinking",
		tool: d.tool,
		file: d.file,
		command: d.command,
		stepsDone: d.stepsDone ?? 0,
		filesTouched: d.filesTouched ?? [],
		elapsedMs: d.elapsedMs ?? 0,
		lastActivityAt: d.lastActivityAt,
		toolStartedAt: d.toolStartedAt,
		outputTail: d.outputTail,
		tokens: d.tokens ?? (typeof d.usage?.total_tokens === "number" ? d.usage.total_tokens : undefined),
		turns: d.turns ?? d.num_turns,
	};
}

export function singleActivityLines(
	_preset: AgyPreset,
	d: SingleDetails,
	width: number,
	theme: ThemeLike,
	frame?: number,
	now?: number
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

	const live = asLiveActivity(d);
	const animFrame = frame ?? frameAt(100, now);
	const spinner = spinnerGlyph(seedFromRun(d), animFrame);
	const spinnerStr = theme.fg("accent", spinner);

	const parts: string[] = [];
	const freshness = activityFreshnessText(live, now);
	if (freshness) {
		const state = activityState(live, now);
		const fColor = state === "needs_attention" ? "warning" : "muted";
		parts.push(theme.fg(fColor, freshness));
	}

	const steps = d.toolSteps ?? d.steps?.length ?? d.stepsDone ?? 0;
	const files = d.files_written?.length ?? d.filesTouched?.length ?? 0;
	const commands = d.commands_run?.length ?? 0;
	if (steps) parts.push(theme.fg("muted", "steps ") + theme.fg("accent", String(steps)));
	if (files) parts.push(theme.fg("muted", "files ") + theme.fg("accent", String(files)));
	if (commands) parts.push(theme.fg("muted", "commands ") + theme.fg("accent", String(commands)));
	const turns = live.turns ?? d.num_turns;
	if (turns) parts.push(theme.fg("muted", "turns ") + theme.fg("accent", String(turns)));
	const tokenCount = live.tokens ?? (typeof d.usage?.total_tokens === "number" ? d.usage.total_tokens : undefined);
	if (typeof tokenCount === "number" && tokenCount > 0) {
		parts.push(theme.fg("muted", "↓ ") + theme.fg("accent", `${formatTokens(tokenCount)} tokens`));
	}

	const sep = theme.fg("borderMuted", " · ");
	const prefix = "  " + spinnerStr + (parts.length ? " " : "");
	const budget = Math.max(0, width - visibleWidth(prefix));
	const metricsStr = fitParts(parts, budget, sep);
	lines.push(trunc(prefix + metricsStr, width));

	const recent = (d.recent ?? []).slice(-RECENT_STEPS);
	for (let i = 0; i < recent.length; i++) {
		const s = recent[i]!;
		const isLast = i === recent.length - 1;
		const branch = treeBranch(1, isLast);
		const { icon, color } = stepGlyph(s);
		const pre =
			"  " +
			theme.fg("borderMuted", branch) +
			theme.fg(color, icon) +
			" " +
			theme.fg("dim", String(s.index).padStart(2, " ")) +
			"  ";
		const preW = visibleWidth(pre);
		const whereBudget = Math.max(0, width - preW);
		const where = trunc(stepWhat(s), whereBudget);
		lines.push(trunc(pre + theme.fg(s.state === "active" ? "text" : "toolOutput", where), width));
	}

	const durMs = toolDurationMs(live, now);
	const durStr = durMs !== undefined ? ` ${formatToolDuration(durMs)}` : "";
	const tailLines = (d.outputTail ?? []).map((l) => oneLine(l)).filter(Boolean).slice(-3);

	if (tailLines.length > 0) {
		for (let i = 0; i < tailLines.length; i++) {
			const isLast = i === tailLines.length - 1;
			const dur = isLast ? durStr : "";
			const p = "  " + theme.fg("borderMuted", "⎿  ");
			const durPart = dur ? theme.fg("dim", dur) : "";
			const b = Math.max(0, width - visibleWidth(p) - visibleWidth(durPart));
			const content = theme.fg("dim", trunc(tailLines[i]!, b)) + durPart;
			lines.push(trunc(p + content, width));
		}
	} else if (d.preview && d.preview.trim()) {
		const previewLines = wrap(d.preview.trim(), Math.max(1, width - 5), 3);
		for (let i = 0; i < previewLines.length; i++) {
			const isLast = i === previewLines.length - 1;
			const dur = isLast ? durStr : "";
			const p = "  " + theme.fg("borderMuted", "⎿  ");
			const durPart = dur ? theme.fg("dim", dur) : "";
			const b = Math.max(0, width - visibleWidth(p) - visibleWidth(durPart));
			const content = theme.fg("dim", trunc(previewLines[i]!, b)) + durPart;
			lines.push(trunc(p + content, width));
		}
	} else {
		const detail = d.command
			? `$ ${oneLine(d.command)}`
			: d.file
				? `${toolIcon(d.tool)} ${oneLine(d.file)}`
				: d.tool && d.tool !== "run_command"
					? d.tool.replace(/_/g, " ")
					: "";
		if (detail || durStr) {
			const p = "  " + theme.fg("borderMuted", "⎿  ");
			const durPart = durStr ? theme.fg("dim", durStr) : "";
			const b = Math.max(0, width - visibleWidth(p) - visibleWidth(durPart));
			const content = theme.fg("dim", trunc(detail, b)) + durPart;
			lines.push(trunc(p + content, width));
		}
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
		const totalSteps = (d.steps ?? []).filter((s) => s.state !== "active").length;
		const failedSteps = (d.steps ?? []).filter((s) => s.state === "failed").length;
		lines.push(
			trunc(
				"  " +
					theme.fg("muted", "run log") +
					theme.fg("dim", `  ${expanded ? totalSteps : Math.min(totalSteps, LOG_COLLAPSED)} of ${totalSteps} steps`) +
					(failedSteps ? theme.fg("error", `  ·  ${failedSteps} failed`) : "") +
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
	return clampLines(lines, width);
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
	return clampLines(lines, width);
}

function laneElapsed(lane: FleetLaneDetails): string {
	if (lane.status === "queued") return "—";
	if (lane.duration_seconds != null) return formatDuration(lane.duration_seconds * 1000);
	if (lane.elapsedMs != null) return formatDuration(lane.elapsedMs);
	if (lane.activity?.elapsedMs) return formatDuration(lane.activity.elapsedMs);
	return "";
}

function laneActivity(lane: FleetLaneDetails, now?: number): string {
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
	const freshness = activityFreshnessText(a, now);
	const target = a.command
		? `$ ${oneLine(a.command)}`
		: a.file
			? `${toolIcon(a.tool)} ${a.file}`
			: a.phase === "writing"
				? "writing response"
				: a.tool && a.tool !== "run_command"
					? a.tool.replace(/_/g, " ")
					: "thinking";
	return freshness ? `${target} · ${freshness}` : target;
}

export function fleetBoardLines(
	d: FleetDetails,
	width: number,
	theme: ThemeLike,
	frame?: number,
	now?: number
): string[] {
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

	const animFrame = frame ?? frameAt(100, now);
	const wide = width >= 84;
	const idWidth = Math.min(14, Math.max(2, ...lanes.map((l) => (l.id ?? "").length)));
	for (const lane of lanes) {
		const glyph =
			lane.status === "running"
				? theme.fg("accent", spinnerGlyph(seedFromLane(lane), animFrame))
				: theme.fg(stateColor(lane.status), stateGlyph(lane.status));
		const id = theme.fg("accent", pad(trunc(lane.id ?? "?", idWidth), idWidth));
		const elapsedText = laneElapsed(lane);
		const act = laneActivity(lane, now);
		if (wide) {
			const word = theme.fg(stateColor(lane.status), stateWord(lane.status).padEnd(8));
			const stepText =
				lane.status === "running" && lane.activity?.step != null
					? theme.fg("dim", `step ${lane.activity.step}`)
					: theme.fg("dim", "—");
			const left = `${glyph} ${id}  ${word}  ${stepText}  `;
			const target = trunc(act, Math.max(4, width - 34 - idWidth));
			lines.push(row(left + theme.fg("text", target), theme.fg("dim", elapsedText), width));
		} else {
			const budget = Math.max(4, width - idWidth - 6 - visibleWidth(elapsedText) - (elapsedText ? 2 : 0));
			lines.push(
				row(
					`${glyph} ${id}  ` + theme.fg("text", trunc(act, budget)),
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
	return clampLines(lines, width);
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

export type AgyRenderState = { animationTimer?: ReturnType<typeof setInterval> };

interface ContextWithState {
	invalidate?: () => void;
	state?: AgyRenderState;
	isError?: boolean;
}

/**
 * Animated component wrapper: rebuilds lines on every render(width) using a
 * time-derived frame, and repaints via context.invalidate() every 100 ms while
 * the result is partial. The timer is stored on context.state so a replaced
 * component's timer is cleared, and cleared on final render or dispose/invalidate.
 */
export class LiveView implements RenderComponent {
	private readonly build: (width: number, frame: number) => string[];
	private readonly isPartial: boolean;
	private readonly ctx?: ContextWithState;
	private timer?: ReturnType<typeof setInterval>;

	constructor(
		build: (width: number, frame: number) => string[],
		isPartial: boolean,
		context?: unknown
	) {
		this.build = build;
		this.isPartial = isPartial;
		if (context && typeof context === "object") {
			const rec = context as Record<string, unknown>;
			if (!rec.state || typeof rec.state !== "object") {
				rec.state = {};
			}
			this.ctx = rec as ContextWithState;
		}
	}

	private clearTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.ctx?.state?.animationTimer) {
			clearInterval(this.ctx.state.animationTimer);
			this.ctx.state.animationTimer = undefined;
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		this.clearTimer();

		if (this.isPartial && this.ctx?.invalidate) {
			const timer = setInterval(() => {
				this.ctx?.invalidate?.();
			}, 100);
			if (typeof timer.unref === "function") {
				timer.unref();
			}
			this.timer = timer;
			if (this.ctx.state) {
				this.ctx.state.animationTimer = timer;
			}
		}

		const frame = frameAt(100);
		try {
			return this.build(w, frame).map((line) =>
				truncLine(String(line).replace(/\r?\n/g, " "), w)
			);
		} catch {
			return [];
		}
	}

	invalidate(): void {
		this.clearTimer();
	}

	dispose(): void {
		this.clearTimer();
	}
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
			return new LiveView(
				(width, frame) =>
					options.isPartial
						? singleActivityLines(effective, details, width, theme, frame)
						: singleResultLines(effective, details, width, theme, options.expanded),
				options.isPartial,
				context
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
			return new LiveView(
				(width, frame) =>
					options.isPartial
						? fleetBoardLines(details, width, theme, frame)
						: fleetResultLines(details, width, theme, options.expanded),
				options.isPartial,
				context
			);
		},
	};
}

