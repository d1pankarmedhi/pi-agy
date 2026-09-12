/**
 * Small, dependency-light rendering toolkit for pi-agy's TUI cards.
 *
 * pi renders tool output inside a `Box` (padding + status background) and asks
 * the returned `Component` for lines at the current terminal width. We build
 * those lines from plain text and apply theme colors *after* truncation, so
 * every line is guaranteed to fit — no ANSI-aware slicing bugs.
 *
 * Only the two pure helpers `visibleWidth` and the optional `wrapTextWithAnsi`
 * are pulled from `@earendil-works/pi-tui` (which pi aliases to its bundled
 * copy for extensions). Everything else is local.
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
 * theme changes and resize free of stale caches. `truncLine` on the way
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
				truncLine(String(line).replace(/\r?\n/g, " "), w)
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

/** Braille spinner frames for live activity. */
export const SPINNER_FRAMES: readonly string[] = [
	"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const;

/**
 * Animation frame index for a tick interval. `frameAt()` uses Date.now();
 * pass `now` in tests. Always a non-negative integer.
 */
export function frameAt(intervalMs?: number, now?: number): number {
	const t = now !== undefined ? now : Date.now();
	const interval = intervalMs && intervalMs > 0 ? intervalMs : 100;
	return Math.max(0, Math.floor(t / interval));
}

/**
 * Spinner glyph. With a `frame`, returns the animated braille frame seeded by
 * `seed` (stable per run, so two lanes are not in lock-step). Without `frame`,
 * returns the static "●".
 */
export function spinnerGlyph(seed?: number, frame?: number): string {
	if (frame === undefined || Number.isNaN(frame)) {
		return "●";
	}
	const s = Math.floor(seed ?? 0);
	const f = Math.floor(frame);
	const len = SPINNER_FRAMES.length;
	const idx = ((f + s) % len + len) % len;
	return SPINNER_FRAMES[idx]!;
}

interface SgrState {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strikethrough: boolean;
	fg: string | null;
	bg: string | null;
}

function createSgrState(): SgrState {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		blink: false,
		inverse: false,
		hidden: false,
		strikethrough: false,
		fg: null,
		bg: null,
	};
}

function resetSgrState(s: SgrState): void {
	s.bold = false;
	s.dim = false;
	s.italic = false;
	s.underline = false;
	s.blink = false;
	s.inverse = false;
	s.hidden = false;
	s.strikethrough = false;
	s.fg = null;
	s.bg = null;
}

function updateSgrState(state: SgrState, ansiCode: string): void {
	if (!ansiCode.startsWith("\x1b[") || !ansiCode.endsWith("m")) return;
	const body = ansiCode.slice(2, -1);
	if (body === "" || body === "0") {
		resetSgrState(state);
		return;
	}
	const parts = body.split(";");
	let i = 0;
	while (i < parts.length) {
		const num = Number.parseInt(parts[i]!, 10);
		if (Number.isNaN(num) || num === 0) {
			resetSgrState(state);
			i++;
			continue;
		}
		if (num === 38 || num === 48) {
			if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
				const color = `${num};5;${parts[i + 2]}`;
				if (num === 38) state.fg = color;
				else state.bg = color;
				i += 3;
				continue;
			} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
				const color = `${num};2;${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
				if (num === 38) state.fg = color;
				else state.bg = color;
				i += 5;
				continue;
			}
		}
		switch (num) {
			case 1: state.bold = true; break;
			case 2: state.dim = true; break;
			case 3: state.italic = true; break;
			case 4: state.underline = true; break;
			case 5: state.blink = true; break;
			case 7: state.inverse = true; break;
			case 8: state.hidden = true; break;
			case 9: state.strikethrough = true; break;
			case 21: state.bold = false; break;
			case 22: state.bold = false; state.dim = false; break;
			case 23: state.italic = false; break;
			case 24: state.underline = false; break;
			case 25: state.blink = false; break;
			case 27: state.inverse = false; break;
			case 28: state.hidden = false; break;
			case 29: state.strikethrough = false; break;
			case 39: state.fg = null; break;
			case 49: state.bg = null; break;
			default:
				if ((num >= 30 && num <= 37) || (num >= 90 && num <= 97)) {
					state.fg = String(num);
				} else if ((num >= 40 && num <= 47) || (num >= 100 && num <= 107)) {
					state.bg = String(num);
				}
				break;
		}
		i++;
	}
}

function getActiveSgrCode(s: SgrState): string {
	const c: string[] = [];
	if (s.bold) c.push("1");
	if (s.dim) c.push("2");
	if (s.italic) c.push("3");
	if (s.underline) c.push("4");
	if (s.blink) c.push("5");
	if (s.inverse) c.push("7");
	if (s.hidden) c.push("8");
	if (s.strikethrough) c.push("9");
	if (s.fg) c.push(s.fg);
	if (s.bg) c.push(s.bg);
	return c.length > 0 ? `\x1b[${c.join(";")}m` : "";
}

function hasActiveStyles(s: SgrState): boolean {
	return (
		s.bold ||
		s.dim ||
		s.italic ||
		s.underline ||
		s.blink ||
		s.inverse ||
		s.hidden ||
		s.strikethrough ||
		s.fg !== null ||
		s.bg !== null
	);
}

const ANSI_REGEX = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\)/y;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function matchAnsiCode(text: string, pos: number): string | null {
	if (pos >= text.length || text.charCodeAt(pos) !== 0x1b) return null;
	ANSI_REGEX.lastIndex = pos;
	const m = ANSI_REGEX.exec(text);
	return m ? m[0] : null;
}

/**
 * ANSI-style-preserving truncate. Keeps active SGR styles and re-applies them
 * before the "…" (pi-tui's truncateToWidth resets styling, which bleeds the
 * box background). Splits on grapheme clusters (Intl.Segmenter), never inside
 * a grapheme. Returns "" for maxWidth <= 0, and the input unchanged when it
 * already fits.
 */
export function truncLine(text: string, maxWidth: number): string {
	if (!Number.isFinite(maxWidth) || maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	const ellipsisWidth = visibleWidth(ELLIPSIS);
	const targetWidth = Math.max(0, maxWidth - ellipsisWidth);

	const sgrState = createSgrState();
	let hasHyperlink = false;
	let result = "";
	let currentWidth = 0;
	let i = 0;

	while (i < text.length) {
		const ansiCode = matchAnsiCode(text, i);
		if (ansiCode) {
			updateSgrState(sgrState, ansiCode);
			if (ansiCode.startsWith("\x1b]8;")) {
				hasHyperlink = !ansiCode.startsWith("\x1b]8;;\x07") && !ansiCode.startsWith("\x1b]8;;\x1b\\");
			}
			result += ansiCode;
			i += ansiCode.length;
			continue;
		}

		let nextAnsi = i;
		while (nextAnsi < text.length) {
			if (text.charCodeAt(nextAnsi) === 0x1b && matchAnsiCode(text, nextAnsi)) {
				break;
			}
			nextAnsi++;
		}

		const plainText = text.slice(i, nextAnsi);
		let stopped = false;
		for (const { segment } of graphemeSegmenter.segment(plainText)) {
			const w = visibleWidth(segment);
			if (currentWidth + w <= targetWidth) {
				result += segment;
				currentWidth += w;
			} else {
				stopped = true;
				break;
			}
		}

		if (stopped) break;
		i = nextAnsi;
	}

	const activeSgr = getActiveSgrCode(sgrState);
	const hasStyles = hasActiveStyles(sgrState);
	const linkClose = hasHyperlink ? "\x1b]8;;\x1b\\" : "";
	const styleClose = hasStyles ? "\x1b[0m" : "";

	return `${result}${activeSgr}${ELLIPSIS}${linkClose}${styleClose}`;
}

/** `truncLine` then right-pad with spaces to exactly `width` visible columns. */
export function fitLine(text: string, width: number): string {
	const w = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
	if (w <= 0) return "";
	const line = truncLine(text, w);
	const lineW = visibleWidth(line);
	return lineW >= w ? line : line + " ".repeat(w - lineW);
}

/** Human liveness age: "now" | "12s" | "1m". */
export function formatActivityAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return "now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	const d = Math.floor(hr / 24);
	return `${d}d`;
}

/** Compact token count: 980 | 3.4k | 1.2M. (May delegate to compactNumber.) */
export function formatTokens(n: number): string {
	return compactNumber(n);
}

/** Tree branch prefix: depth 0 → "", depth 1 → "└─ " | "├─ ". */
export function treeBranch(depth: number, isLast: boolean): string {
	if (depth <= 0) return "";
	return "│  ".repeat(depth - 1) + (isLast ? "└─ " : "├─ ");
}

/** Tree continuation indent matching `treeBranch`: "   " | "│  ". */
export function treeIndent(depth: number, isLast: boolean): string {
	if (depth <= 0) return "";
	return "│  ".repeat(depth - 1) + (isLast ? "   " : "│  ");
}

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
	return truncLine(s, width);
}

/** Right-pad to an exact visible width (truncating if needed). */
export function pad(s: string, width: number): string {
	return fitLine(s, width);
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
