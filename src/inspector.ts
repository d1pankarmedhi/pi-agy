/**
 * The `/agy-fleet` inspector.
 *
 * A keyboard-driven overlay over the session-wide registry: a roster of every
 * tracked agy run (live and recently finished) on the left, and the selected
 * run's detail — live activity, metrics, evidence, response, and run log — on
 * the right. This is the pi-agy counterpart to pi-subagents' fleet inspector,
 * and it is what the FleetView's Enter key opens.
 *
 * The pure `fleetDetailLines` builder is exported so card layout can be tested
 * without a terminal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { agyFleetRegistry, isActiveStatus, type AgyRunRecord, type FleetRegistry } from "./registry.ts";
import { activityFreshnessText, formatDuration, isWriteTool } from "./status.ts";
import {
	compactNumber,
	divider,
	fitLine,
	formatTokens,
	frameAt,
	row,
	spinnerGlyph,
	treeBranch,
	truncLine,
	wrap,
	type ThemeLike,
} from "./ui.ts";

const REFRESH_MS = 500;
const RESPONSE_MAX_LINES = 40;

export interface FleetDetailOptions {
	showTools?: boolean;
}

function statusGlyph(record: AgyRunRecord, theme: ThemeLike, frame?: number): string {
	switch (record.status) {
		case "running":
			return theme.fg("accent", spinnerGlyph(record.startedAt, frame));
		case "queued":
			return theme.fg("muted", "○");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "■");
	}
}

function statusColor(status: AgyRunRecord["status"]): "accent" | "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "running":
			return "accent";
		case "queued":
			return "muted";
		case "done":
			return "success";
		case "failed":
			return "error";
		case "aborted":
			return "warning";
	}
}

function activityText(record: AgyRunRecord): string {
	const live = record.live;
	if (record.status === "queued") return "waiting to start";
	if (record.status === "failed" || record.status === "aborted") return record.error ?? record.status;
	if (record.status === "done") return `finished in ${formatDuration((record.endedAt ?? Date.now()) - record.startedAt)}`;
	if (live.command) return `$ ${live.command}`;
	if (live.file) return `${isWriteTool(live.tool) ? "✎" : "▤"} ${live.file}`;
	if (live.phase === "writing") return "writing response";
	if (live.tool && live.tool !== "run_command") return live.tool.replace(/_/g, " ");
	return live.phase === "thinking" ? "thinking" : live.phase;
}

function metricParts(record: AgyRunRecord, theme: ThemeLike): string {
	const live = record.live;
	const steps = live.stepsDone;
	const files = Math.max(record.filesWritten.length, live.filesTouched.length);
	const commands = record.commandsRun.length;
	const parts: string[] = [];
	if (steps) parts.push(theme.fg("muted", "steps ") + theme.fg("accent", String(steps)));
	if (files) parts.push(theme.fg("muted", "files ") + theme.fg("accent", String(files)));
	if (commands) parts.push(theme.fg("muted", "commands ") + theme.fg("accent", String(commands)));
	if (record.numTurns || live.turns) {
		const turns = record.numTurns ?? live.turns;
		parts.push(theme.fg("muted", "turns ") + theme.fg("accent", String(turns)));
	}
	if (record.status === "running" && live.tokens) {
		parts.push(theme.fg("muted", "↓ ") + theme.fg("accent", formatTokens(live.tokens)) + theme.fg("muted", " tokens"));
	} else if (record.tokens) {
		parts.push(theme.fg("muted", "tokens ") + theme.fg("accent", compactNumber(record.tokens)));
	} else if (live.tokens) {
		parts.push(theme.fg("muted", "↓ ") + theme.fg("accent", formatTokens(live.tokens)) + theme.fg("muted", " tokens"));
	}
	return parts.join(theme.fg("borderMuted", " · "));
}

/** Full detail block for one tracked run. */
export function fleetDetailLines(
	record: AgyRunRecord,
	width: number,
	theme: ThemeLike,
	opts?: FleetDetailOptions | boolean,
): string[] {
	const lines: string[] = [];
	lines.push(
		truncLine(
			theme.fg(statusColor(record.status), "◆ ") +
				theme.fg("toolTitle", theme.bold(record.label)) +
				theme.fg("dim", ` · ${record.status}`),
			width,
		),
	);
	const meta: string[] = [];
	if (record.model) meta.push(record.model);
	if (record.kind === "lane" && record.laneId) meta.push(`lane ${record.laneId}`);
	meta.push(formatDuration((record.endedAt ?? Date.now()) - record.startedAt));
	if (meta.length) lines.push("  " + theme.fg("dim", truncLine(meta.join(" · "), Math.max(0, width - 2))));

	const task = record.task.replace(/\s+/g, " ").trim();
	if (task) {
		for (const line of wrap(`task  ${task}`, Math.max(1, width - 2), 3)) lines.push("  " + theme.fg("text", line));
	}
	if (record.workspace) {
		lines.push("  " + theme.fg("dim", truncLine(`cwd   ${record.workspace}`, Math.max(0, width - 2))));
	}

	lines.push(divider(width, theme));
	const elapsed = formatDuration((record.endedAt ?? Date.now()) - record.startedAt);
	const freshness = activityFreshnessText(record.live);
	const livenessParts: string[] = [
		theme.fg(isActiveStatus(record.status) ? "accent" : "muted", `step ${record.live.step}`),
		theme.fg("text", activityText(record)),
	];
	if (freshness) {
		livenessParts.push(theme.fg("dim", freshness));
	}
	const livenessLeft = "  " + livenessParts.join(theme.fg("borderMuted", " · "));
	const livenessRight = theme.fg("dim", elapsed);
	lines.push(row(livenessLeft, livenessRight, width));

	const metrics = metricParts(record, theme);
	if (metrics) lines.push(truncLine("  " + metrics, width));

	if (record.live.outputTail && record.live.outputTail.length) {
		lines.push(divider(width, theme));
		lines.push("  " + theme.fg("muted", "output"));
		for (const line of record.live.outputTail.slice(-8)) {
			const prefix = "  " + theme.fg("dim", "⎿ ");
			const prefixW = visibleWidth("  ⎿ ");
			const text = theme.fg("toolOutput", truncLine(line, Math.max(0, width - prefixW)));
			lines.push(truncLine(prefix + text, width));
		}
	}

	const showTools = typeof opts === "boolean" ? opts : (opts?.showTools ?? true);
	if (showTools && record.recent.length) {
		lines.push(divider(width, theme));
		lines.push("  " + theme.fg("muted", "recent steps"));
		const steps = record.recent.slice(-6);
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i]!;
			const isLast = i === steps.length - 1;
			const branch = treeBranch(1, isLast);
			const glyph = step.state === "active" ? "▸" : step.state === "failed" ? "✗" : "✓";
			const glyphColor = step.state === "active" ? "accent" : step.state === "failed" ? "error" : "success";
			const what = step.command
				? `$ ${step.command}`
				: step.file
					? `${isWriteTool(step.tool) ? "✎" : "▤"} ${step.file}`
					: step.tool.replace(/_/g, " ");
			const prefix =
				"  " +
				theme.fg("borderMuted", branch) +
				theme.fg(glyphColor, glyph) +
				" " +
				theme.fg("dim", String(step.index)) +
				"  ";
			const prefixW = visibleWidth(`  ${branch}${glyph} ${step.index}  `);
			const text = theme.fg("toolOutput", truncLine(what, Math.max(0, width - prefixW)));
			lines.push(truncLine(prefix + text, width));
		}
	}

	const files = record.filesWritten;
	const commands = record.commandsRun;
	if (showTools && (files.length || commands.length)) {
		lines.push(divider(width, theme));
		lines.push("  " + theme.fg("muted", "evidence"));
		for (const file of files.slice(0, 12)) {
			lines.push(truncLine("    " + theme.fg("text", truncLine(`files  ${file}`, Math.max(0, width - 4))), width));
		}
		for (const command of commands.slice(0, 8)) {
			lines.push(truncLine("    " + theme.fg("text", truncLine(`ran    ${command}`, Math.max(0, width - 4))), width));
		}
	}

	if (record.warnings.length) {
		lines.push(divider(width, theme));
		for (const warning of record.warnings) {
			for (const line of wrap(`⚠ ${warning}`, Math.max(1, width - 2), 3)) lines.push("  " + theme.fg("warning", line));
		}
	}

	if (record.error) {
		lines.push(divider(width, theme));
		for (const line of wrap(`✗ ${record.error}`, Math.max(1, width - 2), 6)) lines.push("  " + theme.fg("error", line));
	}

	const response = (record.response ?? "").trim();
	if (response) {
		lines.push(divider(width, theme));
		lines.push("  " + theme.fg("muted", "response"));
		for (const line of wrap(response, Math.max(1, width - 2), RESPONSE_MAX_LINES)) lines.push("  " + theme.fg("toolOutput", line));
	}

	return lines.map((line) => truncLine(line, width));
}

/** Plain-text fleet summary for non-interactive modes. */
export function formatFleetText(registry: FleetRegistry): string {
	const entries = registry.all();
	if (!entries.length) return "No agy runs tracked in this session yet.";
	const counts = registry.counts();
	const lines = [
		`agy fleet: ${counts.total} tracked · ${counts.active} active · ${counts.done} done · ${counts.failed + counts.aborted} failed`,
		"",
	];
	for (const entry of entries) {
		const elapsed = formatDuration((entry.endedAt ?? Date.now()) - entry.startedAt);
		lines.push(`- [${entry.status}] ${entry.label} · ${elapsed} · ${activityText(entry)}`);
		lines.push(`  task: ${entry.task.replace(/\s+/g, " ").slice(0, 120)}`);
		if (entry.filesWritten.length) lines.push(`  files: ${entry.filesWritten.join(", ")}`);
		if (entry.commandsRun.length) lines.push(`  ran: ${entry.commandsRun.join(" | ")}`);
	}
	return lines.join("\n");
}

function rightAlign(left: string, right: string, width: number): string {
	// Must PAD when there is no right-hand text: the result is placed between
	// border glyphs, so an unpadded return collapses the frame.
	if (!right) return fitLine(left, width);
	const rightWidth = visibleWidth(right);
	const leftClamped = truncLine(left, Math.max(0, width - rightWidth - 1));
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncLine(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

/** Overlay component: roster + detail. */
export class FleetInspectorComponent implements Component {
	private selected = 0;
	private scroll = 0;
	private autoFollow = true;
	private detailLineCount = 0;
	private viewportHeight = 10;
	private bodyHeight = 10;
	private disposed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	public showTools = true;
	private readonly registry: FleetRegistry;
	private readonly tui: { requestRender(): void; terminal?: { rows: number } };
	private readonly theme: ThemeLike;
	private readonly done: (result: undefined) => void;

	constructor(
		tui: { requestRender(): void; terminal?: { rows: number } },
		theme: ThemeLike,
		registry: FleetRegistry,
		done: (result: undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.registry = registry;
		this.done = done;
		this.refresh();
		this.timer = setInterval(() => this.refresh(), REFRESH_MS);
		this.timer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private refresh(): void {
		if (this.disposed) return;
		const entries = this.registry.all();
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, entries.length - 1)));
		this.tui.requestRender();
	}

	private close(): void {
		this.dispose();
		this.done(undefined);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const entries = this.registry.all();
		const maxIndex = Math.max(0, entries.length - 1);
		// Entries can shrink under us (a run finishes and is trimmed); re-clamp
		// before every mutation so `selected` can never point outside the list.
		this.selected = Math.max(0, Math.min(this.selected, maxIndex));
		if (matchesKey(data, "escape") || data === "escape") {
			this.close();
			return;
		}
		if (matchesKey(data, "shift+k") || data === "shift+k" || data === "K") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.autoFollow = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+j") || data === "shift+j" || data === "J") {
			const maxScroll = Math.max(0, this.detailLineCount - this.viewportHeight);
			this.scroll = Math.min(maxScroll, this.scroll + 1);
			this.autoFollow = this.scroll >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.autoFollow = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(maxIndex, this.selected + 1);
			this.autoFollow = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - this.viewportHeight);
			this.autoFollow = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxScroll = Math.max(0, this.detailLineCount - this.viewportHeight);
			this.scroll = Math.min(maxScroll, this.scroll + this.viewportHeight);
			this.autoFollow = this.scroll >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (data === "x" || matchesKey(data, "ctrl+o") || data === "ctrl+o" || data === "\x0f") {
			this.showTools = !this.showTools;
			this.tui.requestRender();
			return;
		}
		if (data === "g") {
			this.scroll = 0;
			this.autoFollow = false;
			this.tui.requestRender();
			return;
		}
		if (data === "G") {
			this.autoFollow = true;
			this.tui.requestRender();
			return;
		}
		if (data === "r") {
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		if (width < 40) return [truncLine("agy fleet inspector needs at least 40 columns. Esc closes.", width)];
		const entries = this.registry.all();
		const innerWidth = width - 2;
		// Keep the selection valid even if the registry shrank since last render.
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, entries.length - 1)));
		const rows = this.tui.terminal?.rows ?? 32;
		this.bodyHeight = Math.max(4, Math.floor(rows * 0.85) - 6);
		const rosterWidth = Math.max(24, Math.min(44, Math.floor((innerWidth - 1) * 0.4)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);

		const frame = frameAt(REFRESH_MS);
		const selected = entries[this.selected];
		const roster = this.rosterLines(entries, this.selected, rosterWidth, theme, this.bodyHeight, frame);
		const detail = selected
			? fleetDetailLines(selected, detailWidth, theme, { showTools: this.showTools })
			: [theme.fg("dim", "No tracked agy runs.")];
		this.detailLineCount = detail.length;
		this.viewportHeight = Math.max(1, this.bodyHeight);
		const maxScroll = Math.max(0, detail.length - this.viewportHeight);
		if (this.autoFollow) this.scroll = maxScroll;
		else this.scroll = Math.min(this.scroll, maxScroll);
		const visibleDetail = detail.slice(this.scroll, this.scroll + this.viewportHeight);

		const lines: string[] = [];
		lines.push(theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		const counts = this.registry.counts();
		let totalTokens = counts.tokens;
		for (const entry of entries) {
			if (!entry.tokens && entry.live.tokens) {
				totalTokens += entry.live.tokens;
			}
		}
		const tokensPart = totalTokens ? ` · ↓ ${formatTokens(totalTokens)} tokens` : "";
		const title = ` ${theme.bold("agy fleet")} ${theme.fg("dim", `· ${counts.active} active · ${counts.total} tracked${tokensPart}`)}`;
		const right = selected ? `${statusGlyph(selected, theme, frame)} ${selected.label} · ${selected.status} ` : "";
		lines.push(theme.fg("border", "│") + rightAlign(title, right, innerWidth) + theme.fg("border", "│"));
		lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
		for (let index = 0; index < this.bodyHeight; index++) {
			lines.push(
				theme.fg("border", "│") +
					fitLine(roster[index] ?? "", rosterWidth) +
					theme.fg("border", "│") +
					fitLine(visibleDetail[index] ?? "", detailWidth) +
					theme.fg("border", "│"),
			);
		}
		lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
		const position = entries.length ? `${this.selected + 1}/${entries.length}` : "0/0";
		const scrollHint = maxScroll > 0 ? ` · ${this.scroll}/${maxScroll} scroll` : "";
		// Trim optional key hints (never `Esc close` or the position) so a narrow
		// overlay degrades gracefully instead of swallowing the status.
		const keys = ["↑/↓ select", "Shift+J/K line", "PgUp/PgDn page", "x tools", "g/G", "r refresh", "Esc close"];
		const status = `${position}${scrollHint}`;
		const footerText = () => ` ${keys.join(" · ")} · ${status}`;
		while (keys.length > 2 && visibleWidth(footerText()) > innerWidth) keys.splice(keys.length - 2, 1);
		lines.push(theme.fg("border", "│") + fitLine(theme.fg("dim", footerText()), innerWidth) + theme.fg("border", "│"));
		lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncLine(line, width));
	}

	private rosterLines(
		entries: AgyRunRecord[],
		selected: number,
		width: number,
		theme: ThemeLike,
		height: number,
		frame?: number,
	): string[] {
		if (!entries.length) return [theme.fg("dim", " no runs")];
		const start = Math.max(0, Math.min(selected - height + 1, entries.length - height));
		const out: string[] = [];
		for (let index = start; index < Math.min(entries.length, start + height); index++) {
			const entry = entries[index]!;
			const marker = index === selected ? theme.fg("accent", "›") : " ";
			const elapsed = formatDuration((entry.endedAt ?? Date.now()) - entry.startedAt);
			const left = `${marker} ${statusGlyph(entry, theme, frame)} ${theme.fg("toolTitle", truncLine(entry.label, Math.max(6, width - elapsed.length - 8)))}`;
			out.push(rightAlign(left, theme.fg("dim", elapsed), width));
		}
		return out;
	}

	invalidate(): void {
		/* stateless: rebuilt on every render */
	}
}

/**
 * Open the fleet inspector. In interactive sessions this is a full overlay; in
 * print/RPC modes it degrades to a text summary notification.
 */
export async function openFleetInspector(ctx: ExtensionContext, registry: FleetRegistry = agyFleetRegistry): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(formatFleetText(registry), "info");
		return;
	}
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => new FleetInspectorComponent(tui, theme, registry, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 } },
	);
}

