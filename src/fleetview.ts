/**
 * The persistent agy FleetView.
 *
 * pi-subagents keeps a live widget under the editor that shows every active
 * child at a glance and expands into a selectable roster. This is the pi-agy
 * counterpart: a compact status line while agy work runs, which expands (down/
 * left on an empty editor) into one row per active agy run — single tool calls
 * and `agy_fleet` lanes alike — with the file/command each agent is touching,
 * its step count, and its elapsed time. Enter opens the full `/agy-fleet`
 * inspector.
 *
 * The widget is registered lazily: it appears the moment the first run starts
 * and removes itself once every run has finished, so a completed session
 * leaves no residual surface.
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { agyFleetRegistry, isActiveStatus, type AgyRunRecord, type FleetRegistry } from "./registry.ts";
import { formatDuration, toolDurationMs } from "./status.ts";
import {
	fitLine,
	formatTokens,
	frameAt,
	oneLine,
	row,
	spinnerGlyph,
	trunc,
	type ThemeLike,
} from "./ui.ts";

export const AGY_FLEET_WIDGET_KEY = "agy-fleet";
const REFRESH_MS = 500;
const MAX_AGENT_ROWS = 6;

type TuiLike = { requestRender(): void };

export interface AgyFleetViewOptions {
	refreshMs?: number;
	placement?: "aboveEditor" | "belowEditor";
	/** Registry to read from (defaults to the module singleton). */
	registry?: FleetRegistry;
}

function seedFromId(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}

function statusGlyph(record: AgyRunRecord, theme: ThemeLike, frame?: number): string {
	switch (record.status) {
		case "running":
			return theme.fg("accent", spinnerGlyph(seedFromId(record.id), frame));
		case "queued":
			return theme.fg("muted", "○");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
		case "aborted":
			return theme.fg("error", "✗");
	}
}

/** One-line description of what an agent is doing right now. */
export function fleetActivityText(record: AgyRunRecord): string {
	if (record.status === "queued") return "waiting";
	if (record.status === "failed" || record.status === "aborted") {
		return record.error ? trunc(record.error.replace(/\s+/g, " "), 48) : record.status;
	}
	if (record.status === "done") {
		const bits: string[] = [];
		if (record.filesWritten.length) bits.push(`${record.filesWritten.length} file${record.filesWritten.length === 1 ? "" : "s"}`);
		if (record.commandsRun.length) bits.push(`${record.commandsRun.length} cmd`);
		return bits.join(" · ") || "done";
	}
	const live = record.live;
	if (live.command) return `$ ${trunc(live.command.replace(/\s+/g, " "), 44)}`;
	if (live.file) return `✎ ${live.file}`;
	if (live.phase === "writing") return "writing response";
	if (live.tool && live.tool !== "run_command") return live.tool.replace(/_/g, " ");
	return "thinking";
}

function rightAlign(left: string, right: string, width: number): string {
	return fitLine(row(left, right, width), width);
}

/** Aggregate live progress across the active runs, for the collapsed line. */
export function activeFleetTotals(entries: AgyRunRecord[]): {
	agents: number;
	steps: number;
	files: number;
	tokens: number;
} {
	let steps = 0;
	let tokens = 0;
	const seen = new Set<string>();
	let agents = 0;
	for (const entry of entries) {
		if (!isActiveStatus(entry.status)) continue;
		agents++;
		steps += entry.live.stepsDone;
		for (const file of entry.live.filesTouched) seen.add(file);
		tokens += entry.live.tokens ?? entry.tokens ?? 0;
	}
	return { agents, steps, files: seen.size, tokens };
}

/** Compact single-run block shown when exactly one run is active (max 3 rows). */
export function fleetSingleRunLines(
	record: AgyRunRecord,
	width: number,
	theme: ThemeLike,
	opts?: { now?: number; frame?: number } | number,
): string[] {
	const now = typeof opts === "number" ? opts : opts?.now ?? Date.now();
	const frame = typeof opts === "object" && opts?.frame !== undefined ? opts.frame : frameAt(500, now);

	// Row 1: ⠹ agy_code · running · 12 steps · ↓ 4.2k tokens        1m 12s
	const glyph = statusGlyph(record, theme, frame);
	const label = theme.fg("toolTitle", record.label);
	const status = theme.fg("dim", record.status);
	const steps = record.live.stepsDone ? theme.fg("dim", `${record.live.stepsDone} steps`) : undefined;
	const tok = record.live.tokens ?? record.tokens;
	const tokens = tok ? theme.fg("dim", `↓ ${formatTokens(tok)} tokens`) : undefined;
	const leftParts = [label, status, steps, tokens].filter((p): p is string => Boolean(p));
	const left = `  ${glyph} ${leftParts.join(theme.fg("dim", " · "))}`;

	const elapsed = record.status === "queued" ? "—" : formatDuration(now - record.startedAt);
	const right = theme.fg("dim", elapsed);
	const row1 = fitLine(row(left, right, width), width);

	// Row 2: ⎿  ✎ src/fleetview.ts  3.4s
	const durMs = toolDurationMs(record.live, now);
	const durText = durMs !== undefined ? (durMs < 60_000 ? `${(durMs / 1000).toFixed(1)}s` : formatDuration(durMs)) : "";
	const actText = fleetActivityText(record);
	const durPart = durText ? `  ${theme.fg("dim", durText)}` : "";
	const row2 = fitLine(`    ${theme.fg("dim", "⎿")}  ${theme.fg("text", actText)}${durPart}`, width);

	// Row 3: task: Refactor the fleet widget rows
	const taskText = record.task ? oneLine(record.task) : "";
	const lines = [row1, row2];
	if (taskText) {
		lines.push(fitLine(`    ${theme.fg("dim", "task:")} ${theme.fg("text", taskText)}`, width));
	}
	return lines;
}

/** Summary shown while the FleetView is collapsed (single-run block if 1 active, else multi-run line). */
export function fleetCollapsedLines(
	entries: AgyRunRecord[],
	width: number,
	theme: ThemeLike,
	opts?: { now?: number; frame?: number } | number,
): string[] {
	const active = entries.filter((entry) => isActiveStatus(entry.status));
	if (active.length === 1) {
		return fleetSingleRunLines(active[0]!, width, theme, opts);
	}
	if (active.length === 0) {
		return [];
	}

	const now = typeof opts === "number" ? opts : opts?.now ?? Date.now();
	const frame = typeof opts === "object" && opts?.frame !== undefined ? opts.frame : frameAt(500, now);

	const totals = activeFleetTotals(active);
	const noun = totals.agents === 1 ? "agent" : "agents";
	const glyph = theme.fg("accent", spinnerGlyph(0, frame));
	const parts = [
		`${totals.agents} active ${noun}`,
		totals.steps ? `${totals.steps} steps` : undefined,
		totals.files ? `${totals.files} ${totals.files === 1 ? "file" : "files"}` : undefined,
		totals.tokens ? `↓ ${formatTokens(totals.tokens)} tokens` : undefined,
	].filter((p): p is string => Boolean(p));

	const label = parts.join(" · ");
	const inspectText = `${label ? " · " : ""}↓/← to inspect`;
	const content = `  ${glyph} ${theme.fg("muted", label)}${theme.fg("dim", inspectText)}`;
	return [fitLine(content, width)];
}

/** One roster row in the pi-subagents shape. */
export function fleetRosterLine(
	record: AgyRunRecord,
	selected: boolean,
	width: number,
	theme: ThemeLike,
	opts?: { now?: number; frame?: number } | number,
): string {
	const now = typeof opts === "number" ? opts : opts?.now ?? Date.now();
	const frame = typeof opts === "object" && opts?.frame !== undefined ? opts.frame : frameAt(500, now);
	const marker = selected ? theme.fg("accent", ">") : " ";
	const glyph = statusGlyph(record, theme, frame);
	const label = theme.fg("toolTitle", record.label);

	let left: string;
	let right: string;

	if (record.status === "queued") {
		const actText = fleetActivityText(record);
		const act = actText ? ` ${theme.fg("dim", `· ${actText}`)}` : "";
		left = `    ${marker} ${glyph} ${label}${act}`;
		right = theme.fg("dim", "— · queued");
	} else {
		const status = theme.fg("dim", `· ${record.status}`);
		const actText = fleetActivityText(record);
		const activity = actText ? ` ${theme.fg("text", `· ${actText}`)}` : "";
		left = `    ${marker} ${glyph} ${label} ${status}${activity}`;

		const elapsed = formatDuration((record.endedAt ?? now) - record.startedAt);
		const steps = record.live.stepsDone ? `${record.live.stepsDone} steps` : undefined;
		const tok = record.live.tokens ?? record.tokens;
		const tokens = tok ? formatTokens(tok) : undefined;
		const details = [elapsed, steps, tokens].filter(Boolean).join(" · ");
		right = theme.fg("dim", details);
	}

	return fitLine(row(left, right, width), width);
}

function formatOverflow(records: AgyRunRecord[]): string {
	const running = records.filter((r) => r.status === "running").length;
	const queued = records.filter((r) => r.status === "queued").length;
	const finished = records.filter((r) => !isActiveStatus(r.status)).length;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (queued > 0) parts.push(`${queued} queued`);
	if (finished > 0) parts.push(`${finished} finished`);
	return parts.join(", ");
}

/** Expanded roster lines (help line, main row, running, queued summary, finished, overflow). */
export function fleetRosterLines(
	entries: AgyRunRecord[],
	selectedId: string | undefined,
	width: number,
	theme: ThemeLike,
	maxRows: number | { now?: number; frame?: number } = MAX_AGENT_ROWS,
	opts?: { now?: number; frame?: number } | number,
): string[] {
	const rowsLimit = typeof maxRows === "number" ? maxRows : MAX_AGENT_ROWS;
	const resolvedOpts = typeof maxRows === "object" ? maxRows : opts;

	const running = entries.filter((e) => e.status === "running");
	const queued = entries.filter((e) => e.status === "queued");
	const finished = entries.filter((e) => !isActiveStatus(e.status));

	const lines: string[] = [
		fitLine(`  ${theme.fg("dim", "↑↓/jk select · enter inspect · esc back")}`, width),
		"",
		fitLine(`    ${selectedId === "main" ? theme.fg("accent", ">") : " "} ${theme.fg("muted", "main")}`, width),
	];

	interface RosterItem {
		id: string;
		records: AgyRunRecord[];
		line: string;
	}

	const items: RosterItem[] = [];

	// 1. Running runs first
	for (const r of running) {
		items.push({
			id: r.id,
			records: [r],
			line: fleetRosterLine(r, selectedId === r.id, width, theme, resolvedOpts),
		});
	}

	// 2. Queued summary row
	if (queued.length === 1) {
		const q = queued[0]!;
		items.push({
			id: q.id,
			records: [q],
			line: fleetRosterLine(q, selectedId === q.id, width, theme, resolvedOpts),
		});
	} else if (queued.length > 1) {
		const isSelected = queued.some((q) => q.id === selectedId);
		const marker = isSelected ? theme.fg("accent", ">") : " ";
		const left = `    ${marker} ${theme.fg("muted", "○")} ${theme.fg("muted", `${queued.length} queued`)}`;
		const right = theme.fg("dim", "— · queued");
		items.push({
			id: isSelected ? selectedId! : queued[0]!.id,
			records: queued,
			line: fitLine(row(left, right, width), width),
		});
	}

	// 3. Finished rows
	for (const f of finished) {
		items.push({
			id: f.id,
			records: [f],
			line: fleetRosterLine(f, selectedId === f.id, width, theme, resolvedOpts),
		});
	}

	if (items.length <= rowsLimit) {
		for (const item of items) {
			lines.push(item.line);
		}
		return lines;
	}

	// Window rows so the selection stays visible
	const selectedIndex = selectedId && selectedId !== "main" ? items.findIndex((item) => item.id === selectedId) : -1;
	const start = selectedIndex < rowsLimit ? 0 : selectedIndex - rowsLimit + 1;
	const visible = items.slice(start, start + rowsLimit);

	if (start > 0) {
		lines.push(fitLine(`      ${theme.fg("dim", `↑ ${start} more`)}`, width));
	}
	for (const item of visible) {
		lines.push(item.line);
	}

	const hiddenBelowItems = items.slice(start + visible.length);
	const hiddenBelowRecords: AgyRunRecord[] = [];
	for (const item of hiddenBelowItems) {
		hiddenBelowRecords.push(...item.records);
	}

	if (hiddenBelowRecords.length > 0) {
		const breakdown = formatOverflow(hiddenBelowRecords);
		const detail = breakdown ? ` (${breakdown})` : "";
		lines.push(fitLine(`      ${theme.fg("dim", `+${hiddenBelowRecords.length} more${detail}`)}`, width));
	}

	return lines;
}

/** Structural editor check (pi-tui has no focus getter; instanceof breaks across jiti). */
function editorHasFocus(tui: unknown): boolean {
	try {
		const focused = (tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (!focused || typeof focused !== "object") return false;
		const candidate = focused as Record<string, unknown>;
		return (
			typeof candidate.render === "function" &&
			typeof candidate.invalidate === "function" &&
			typeof candidate.handleInput === "function" &&
			typeof candidate.getText === "function" &&
			typeof candidate.setText === "function"
		);
	} catch {
		// A throwing getter on a foreign component must not break key handling.
		return false;
	}
}

export class AgyFleetView {
	private readonly registry: FleetRegistry;
	private readonly openInspector: (ctx: ExtensionContext) => Promise<void> | void;
	private readonly refreshMs: number;
	private readonly placement: "aboveEditor" | "belowEditor";
	private ctx: ExtensionContext | undefined;
	private ui: ExtensionUIContext | undefined;
	private tui: TuiLike | undefined;
	private unsubInput: (() => void) | undefined;
	private unsubRegistry: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private expanded = false;
	private selectedId: string | undefined;

	constructor(openInspector: (ctx: ExtensionContext) => Promise<void> | void, options: AgyFleetViewOptions = {}) {
		this.registry = options.registry ?? agyFleetRegistry;
		this.openInspector = openInspector;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.placement = options.placement ?? "belowEditor";
	}

	/** Bind to the current session's UI context (called on session start). */
	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			this.clearUiRegistration();
			return;
		}
		if (this.ui === ctx.ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.clearUiRegistration();
		this.ctx = ctx;
		this.ui = ctx.ui;
		this.unsubInput = ctx.ui.onTerminalInput((data) => this.handleKey(data));
		this.unsubRegistry = this.registry.subscribe(() => this.refresh());
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
	}

	/** Recompute the widget: register it while runs are active, clear it otherwise. */
	refresh(): void {
		const ctx = this.ctx;
		if (!ctx || !this.ui) return;
		const active = this.registry.active();
		if (active.length === 0) {
			this.expanded = false;
			this.selectedId = undefined;
			this.stopTimer();
			this.clearWidget();
			return;
		}
		// Only tick while work is live; an idle session must not wake up twice a
		// second just to discover there is nothing to draw.
		this.ensureTimer();
		// Keep the selection valid as runs appear and finish.
		const all = this.registry.all();
		const ids = new Set(all.map((entry) => entry.id));
		if (!this.selectedId || (this.selectedId !== "main" && !ids.has(this.selectedId))) {
			this.selectedId = "main";
		}
		if (!this.widgetRegistered) {
			const ui = this.ui;
			ui.setWidget(
				AGY_FLEET_WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui as unknown as TuiLike;
					return {
						render: (width: number) => this.render(width, theme),
						invalidate: () => { /* stateless: rebuilt on every render */ },
						dispose: () => {
							if (this.tui === (tui as unknown as TuiLike)) {
								this.widgetRegistered = false;
								this.tui = undefined;
							}
						},
					};
				},
				{ placement: this.placement },
			);
			this.widgetRegistered = true;
			return;
		}
		this.tui?.requestRender();
	}

	private render(width: number, theme: ThemeLike): string[] {
		const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		const active = this.registry.active();
		if (active.length === 0) return [];
		const now = Date.now();
		const frame = frameAt(500, now);
		if (!this.expanded) return fleetCollapsedLines(active, w, theme, { now, frame });
		return fleetRosterLines(this.registry.all(), this.selectedId, w, theme, MAX_AGENT_ROWS, { now, frame });
	}

	handleKey(data: string): { consume?: boolean } | undefined {
		if (!this.widgetRegistered || isKeyRelease(data)) return undefined;
		const ctx = this.ctx;
		if (!ctx || this.registry.active().length === 0) return undefined;
		if (!editorHasFocus(this.tui)) {
			if (this.expanded) this.collapse();
			return undefined;
		}
		if (!this.expanded) {
			const activates = matchesKey(data, "down") || matchesKey(data, "left");
			if (!activates || ctx.ui.getEditorText() !== "") return undefined;
			this.expanded = true;
			this.selectedId = "main";
			this.refresh();
			return { consume: true };
		}
		const roster = this.rosterIds();
		const index = Math.max(0, roster.indexOf(this.selectedId ?? "main"));
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedId = roster[Math.min(roster.length - 1, index + 1)] ?? "main";
			this.tui?.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (index === 0) {
				this.collapse();
				return { consume: true };
			}
			this.selectedId = roster[index - 1] ?? "main";
			this.tui?.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.collapse();
			return { consume: true };
		}
		if (matchesKey(data, "return")) {
			if (!this.selectedId || this.selectedId === "main") {
				this.collapse();
				return { consume: true };
			}
			void Promise.resolve()
				.then(() => this.openInspector(ctx))
				.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
			return { consume: true };
		}
		this.collapse();
		return undefined;
	}

	private rosterIds(): string[] {
		return ["main", ...this.registry.all().map((entry) => entry.id)];
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.refresh(), this.refreshMs);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private collapse(): void {
		this.expanded = false;
		this.selectedId = "main";
		this.tui?.requestRender();
	}

	private clearWidget(): void {
		if (!this.widgetRegistered) return;
		try {
			this.ui?.setWidget(AGY_FLEET_WIDGET_KEY, undefined);
		} catch {
			/* context may be stale during reload; ignore */
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private clearUiRegistration(): void {
		this.stopTimer();
		this.unsubInput?.();
		this.unsubInput = undefined;
		this.unsubRegistry?.();
		this.unsubRegistry = undefined;
		this.clearWidget();
		this.ui = undefined;
	}
}

