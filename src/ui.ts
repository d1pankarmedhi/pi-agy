/**
 * Small, dependency-light rendering toolkit for pi-agy's TUI cards.
 *
 * pi renders tool output inside a `Box` (padding + status background) and asks
 * the returned `Component` for lines at the current terminal width. We build
 * those lines from plain text and apply theme colors *after* truncation, so
 * every line is guaranteed to fit — no ANSI-aware slicing bugs.
 *
 * Only the two pure helpers `visibleWidth`/`truncateToWidth` and the optional
 * `wrapTextWithAnsi` are pulled from `@earendil-works/pi-tui` (which pi aliases
 * to its bundled copy for extensions). Everything else is local.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** The slice of pi's `Theme` the cards use. A real `Theme` satisfies this. */
export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

/** Structural twin of pi-tui's `Component`. */
export interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
}

/**
 * A stateless component: it rebuilds its lines on every render, which keeps
 * theme changes and resize free of stale caches. `truncateToWidth` on the way
 * out is a hard guarantee that no line overflows the terminal.
 */
export class View implements RenderComponent {
	private readonly build: (width: number) => string[];
	constructor(build: (width: number) => string[]) {
		this.build = build;
	}
	render(width: number): string[] {
		const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		try {
			return this.build(w).map((line) =>
				truncateToWidth(String(line).replace(/\r?\n/g, " "), w, ELLIPSIS)
			);
		} catch {
			return [];
		}
	}
	invalidate(): void {
		/* stateless — nothing to clear */
	}
}

export const ELLIPSIS = "…";

/** Re-exported so renderers can reason about column budgets. */
export { visibleWidth };

/**
 * Greedily join as many parts as fit in `width` (separator included), so
 * optional subtitle fields drop at token boundaries instead of mid-word.
 */
export function fitParts(parts: (string | undefined)[], width: number, separator: string): string {
	if (width <= 0) return "";
	const kept: string[] = [];
	for (const part of parts) {
		if (!part) continue;
		const candidate = kept.length ? kept.join(separator) + separator + part : part;
		if (kept.length && visibleWidth(candidate) > width) break;
		kept.push(part);
	}
	return kept.join(separator);
}

/** `1 file` / `2 files` — tiny pluralization helper. */
export function plural(n: number, singular: string, pluralForm?: string): string {
	return `${n} ${n === 1 ? singular : (pluralForm ?? singular + "s")}`;
}

/** Truncate to a visible width, appending an ellipsis when clipped. */
export function trunc(s: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(s) <= width ? s : truncateToWidth(s, width, ELLIPSIS);
}

/** Right-pad to an exact visible width (truncating if needed). */
export function pad(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return trunc(s, width);
	return s + " ".repeat(width - w);
}

/** `left … right` on one line, right-aligned, never wider than `width`. */
export function row(left: string, right: string, width: number, gap = 2): string {
	if (!right) return trunc(left, width);
	const rw = visibleWidth(right);
	const l = trunc(left, Math.max(0, width - rw - gap));
	const fill = Math.max(gap, width - visibleWidth(l) - rw);
	return trunc(l + " ".repeat(fill) + right, width);
}

/** A full-width horizontal rule in the muted border color. */
export function divider(width: number, theme: ThemeLike, color: ThemeColor = "borderMuted"): string {
	return theme.fg(color, "─".repeat(Math.max(1, Math.floor(width))));
}

/** Wrap text (respecting existing newlines) into at most `maxLines` lines. */
export function wrap(text: string, width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
	if (!text) return [];
	const w = Math.max(1, Math.floor(width));
	const out: string[] = [];
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (out.length >= maxLines) break;
		if (raw.trim() === "") {
			if (out.length) out.push("");
			continue;
		}
		for (const line of wrapTextWithAnsi(raw, w)) {
			if (out.length >= maxLines) break;
			out.push(line);
		}
	}
	return out;
}

/** Total wrapped line count, without materializing (cheap enough for cards). */
export function wrapCount(text: string, width: number): number {
	const w = Math.max(1, Math.floor(width));
	let total = 0;
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (raw.trim() === "") {
			if (total) total++;
			continue;
		}
		total += wrapTextWithAnsi(raw, w).length;
	}
	return total;
}

/** Collapse all whitespace runs into single spaces (for one-line previews). */
export function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** `48.2k` / `1.3M` — compact token/byte counts for stat rows. */
export function compactNumber(n: number): string {
	if (!Number.isFinite(n)) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

/**
 * A labeled list rendered as `label  item` lines, capped with a `+N more`
 * footer unless expanded. Returns [] for empty input.
 */
export function listSection(
	label: string,
	items: string[],
	width: number,
	theme: ThemeLike,
	opts: { max?: number; itemColor?: ThemeColor; indent?: number } = {}
): string[] {
	if (!items.length) return [];
	const indent = opts.indent ?? 2;
	const shown = items.slice(0, opts.max ?? items.length);
	const col = label.length + 2; // fixed label column: `files  `
	const out: string[] = [];
	for (let i = 0; i < shown.length; i++) {
		const prefix =
			" ".repeat(indent) +
			(i === 0 ? theme.fg("muted", pad(label, col)) : " ".repeat(col));
		out.push(trunc(prefix + theme.fg(opts.itemColor ?? "text", shown[i]!), width));
	}
	if (items.length > shown.length) {
		out.push(
			" ".repeat(indent + col) +
				theme.fg("dim", `+${items.length - shown.length} more`)
		);
	}
	return out;
}
