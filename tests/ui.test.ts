import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ELLIPSIS,
	SPINNER_FRAMES,
	View,
	fitLine,
	fitParts,
	formatActivityAge,
	formatTokens,
	frameAt,
	pad,
	plural,
	row,
	spinnerGlyph,
	treeBranch,
	treeIndent,
	trunc,
	truncLine,
	type ThemeLike,
} from "../src/ui.ts";

const theme: ThemeLike = {
	fg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
};

// ---------------------------------------------------------------------------
// 1. SPINNER_FRAMES
// ---------------------------------------------------------------------------

test("SPINNER_FRAMES contains 10 braille frames with visible width 1", () => {
	assert.equal(SPINNER_FRAMES.length, 10);
	assert.deepEqual(SPINNER_FRAMES, [
		"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
	]);
	for (const frame of SPINNER_FRAMES) {
		assert.equal(visibleWidth(frame), 1);
	}
});

// ---------------------------------------------------------------------------
// 2. frameAt
// ---------------------------------------------------------------------------

test("frameAt calculates frame indices and defaults interval to 100ms", () => {
	assert.equal(frameAt(100, 0), 0);
	assert.equal(frameAt(100, 99), 0);
	assert.equal(frameAt(100, 100), 1);
	assert.equal(frameAt(100, 250), 2);
	assert.equal(frameAt(500, 1200), 2);
	// Default interval is 100ms
	assert.equal(frameAt(undefined, 250), 2);
	// Negative timestamps clamp to 0
	assert.equal(frameAt(100, -50), 0);
});

test("frameAt monotonicity with an injected now", () => {
	for (const interval of [50, 100, 250, 500]) {
		let prev = frameAt(interval, 0);
		for (let now = 1; now <= 5000; now += 19) {
			const current = frameAt(interval, now);
			assert.ok(
				current >= prev,
				`frameAt must be non-decreasing: prev=${prev}, current=${current} at now=${now}, interval=${interval}`
			);
			prev = current;
		}
	}
});

// ---------------------------------------------------------------------------
// 3. spinnerGlyph: static vs animated
// ---------------------------------------------------------------------------

test("spinnerGlyph static (no frame) behavior returns ●", () => {
	assert.equal(spinnerGlyph(), "●");
	assert.equal(spinnerGlyph(undefined), "●");
	assert.equal(spinnerGlyph(0), "●");
	assert.equal(spinnerGlyph(1), "●");
	assert.equal(spinnerGlyph(42), "●");
	assert.equal(spinnerGlyph(undefined, undefined), "●");
	assert.equal(spinnerGlyph(0, Number.NaN), "●");
});

test("spinnerGlyph animated (frame) behavior cycles braille frames with seed offset", () => {
	assert.equal(spinnerGlyph(0, 0), "⠋");
	assert.equal(spinnerGlyph(0, 1), "⠙");
	assert.equal(spinnerGlyph(0, 2), "⠹");
	assert.equal(spinnerGlyph(0, 9), "⠏");
	assert.equal(spinnerGlyph(0, 10), "⠋"); // wrap
	assert.equal(spinnerGlyph(undefined, 0), "⠋");

	// Seed offsets the animation so different lanes are not in lock-step
	assert.equal(spinnerGlyph(1, 0), "⠙");
	assert.equal(spinnerGlyph(2, 0), "⠹");
	assert.equal(spinnerGlyph(3, 0), "⠸");
	assert.equal(spinnerGlyph(10, 0), "⠋");

	// Both seed and frame increment together
	assert.equal(spinnerGlyph(2, 1), "⠸"); // (2 + 1) % 10 = 3 -> "⠸"
});

// ---------------------------------------------------------------------------
// 4. formatActivityAge boundaries
// ---------------------------------------------------------------------------

test("formatActivityAge handles boundaries accurately", () => {
	// < 1s -> "now"
	assert.equal(formatActivityAge(-500), "now");
	assert.equal(formatActivityAge(0), "now");
	assert.equal(formatActivityAge(500), "now");
	assert.equal(formatActivityAge(999), "now");
	assert.equal(formatActivityAge(Number.NaN), "now");

	// 1s .. 59s -> "<N>s"
	assert.equal(formatActivityAge(1000), "1s");
	assert.equal(formatActivityAge(1200), "1s");
	assert.equal(formatActivityAge(12000), "12s");
	assert.equal(formatActivityAge(45000), "45s");
	assert.equal(formatActivityAge(59999), "59s");

	// 60s .. 59m -> "<N>m"
	assert.equal(formatActivityAge(60000), "1m");
	assert.equal(formatActivityAge(65000), "1m");
	assert.equal(formatActivityAge(119999), "1m");
	assert.equal(formatActivityAge(120000), "2m");
	assert.equal(formatActivityAge(59 * 60000), "59m");

	// >= 1h -> "<N>h"
	assert.equal(formatActivityAge(3600000), "1h");
	assert.equal(formatActivityAge(2 * 3600000), "2h");

	// >= 24h -> "<N>d"
	assert.equal(formatActivityAge(86400000), "1d");
	assert.equal(formatActivityAge(3 * 86400000), "3d");
});

// ---------------------------------------------------------------------------
// 5. formatTokens boundaries
// ---------------------------------------------------------------------------

test("formatTokens handles compact number boundaries", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(Number.NaN), "—");
	assert.equal(formatTokens(980), "980");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(3400), "3.4k");
	assert.equal(formatTokens(9900), "9.9k");
	assert.equal(formatTokens(10000), "10k");
	assert.equal(formatTokens(48200), "48k");
	assert.equal(formatTokens(48231), "48k");
	assert.equal(formatTokens(999499), "999k");
	assert.equal(formatTokens(1000000), "1.0M");
	assert.equal(formatTokens(1200000), "1.2M");
});

// ---------------------------------------------------------------------------
// 6. treeBranch and treeIndent contracts at depths 0..3
// ---------------------------------------------------------------------------

test("treeBranch and treeIndent exact strings at depths 0..3 and both isLast values", () => {
	// Depth 0: empty
	assert.equal(treeBranch(0, false), "");
	assert.equal(treeBranch(0, true), "");
	assert.equal(treeIndent(0, false), "");
	assert.equal(treeIndent(0, true), "");
	assert.equal(treeBranch(-1, false), "");
	assert.equal(treeIndent(-1, false), "");

	// Depth 1
	assert.equal(treeBranch(1, false), "├─ ");
	assert.equal(treeBranch(1, true), "└─ ");
	assert.equal(treeIndent(1, false), "│  ");
	assert.equal(treeIndent(1, true), "   ");

	// Depth 2
	assert.equal(treeBranch(2, false), "│  ├─ ");
	assert.equal(treeBranch(2, true), "│  └─ ");
	assert.equal(treeIndent(2, false), "│  │  ");
	assert.equal(treeIndent(2, true), "│     ");

	// Depth 3
	assert.equal(treeBranch(3, false), "│  │  ├─ ");
	assert.equal(treeBranch(3, true), "│  │  └─ ");
	assert.equal(treeIndent(3, false), "│  │  │  ");
	assert.equal(treeIndent(3, true), "│  │     ");

	// Visible widths must match exactly at every depth
	for (let d = 0; d <= 4; d++) {
		const expectedWidth = d === 0 ? 0 : d * 3;
		assert.equal(visibleWidth(treeBranch(d, false)), expectedWidth);
		assert.equal(visibleWidth(treeBranch(d, true)), expectedWidth);
		assert.equal(visibleWidth(treeIndent(d, false)), expectedWidth);
		assert.equal(visibleWidth(treeIndent(d, true)), expectedWidth);
	}
});

// ---------------------------------------------------------------------------
// 7. truncLine contracts
// ---------------------------------------------------------------------------

test("truncLine returns '' for maxWidth <= 0", () => {
	assert.equal(truncLine("hello", 0), "");
	assert.equal(truncLine("hello", -1), "");
	assert.equal(truncLine("hello", -100), "");
	assert.equal(truncLine("\x1b[31mhello\x1b[0m", 0), "");
});

test("truncLine returns input unchanged when it already fits", () => {
	const plain = "hello world";
	assert.equal(truncLine(plain, 11), plain);
	assert.equal(truncLine(plain, 20), plain);

	const styled = "\x1b[31mhello\x1b[0m";
	assert.equal(truncLine(styled, 5), styled);
	assert.equal(truncLine(styled, 10), styled);
});

test("truncLine truncates plain strings with ellipsis and exact visible width", () => {
	const line = truncLine("hello world", 6);
	assert.equal(line, "hello…");
	assert.equal(visibleWidth(line), 6);
	assert.ok(line.endsWith(ELLIPSIS));
});

test("truncLine preserves ANSI styles and re-applies them before ellipsis", () => {
	// Truncated red text keeps red active on ellipsis, then resets
	const red = "\x1b[31mhello world\x1b[0m";
	const truncated = truncLine(red, 6);
	assert.equal(truncated, "\x1b[31mhello\x1b[31m…\x1b[0m");
	assert.equal(visibleWidth(truncated), 6);

	// Bold and colored text
	const boldBlue = "\x1b[1;34mBold Blue String\x1b[0m";
	const tb = truncLine(boldBlue, 8);
	assert.equal(visibleWidth(tb), 8);
	assert.ok(tb.includes("\x1b[1;34m…"));
	assert.ok(tb.endsWith("\x1b[0m"));
});

test("truncLine does not split grapheme clusters (emojis and CJK)", () => {
	// Emoji with width 2: cannot fit in 1 column before ellipsis when maxWidth = 2
	const emoji = "👋world";
	assert.equal(truncLine(emoji, 2), "…"); // "👋" (2) + "…" (1) = 3 > 2, so cannot fit "👋"
	assert.equal(truncLine(emoji, 3), "👋…"); // "👋" (2) + "…" (1) = 3 <= 3
	assert.equal(visibleWidth(truncLine(emoji, 3)), 3);

	// CJK with width 2
	const cjk = "你好世界";
	assert.equal(truncLine(cjk, 4), "你…"); // width 3 <= 4
	assert.equal(visibleWidth(truncLine(cjk, 4)), 3);
	assert.equal(truncLine(cjk, 5), "你好…"); // width 5 <= 5
	assert.equal(visibleWidth(truncLine(cjk, 5)), 5);

	// Complex ZWJ sequence (woman technologist)
	const zwj = "👩🏽‍💻 coding";
	const tzwj = truncLine(zwj, 6);
	assert.equal(visibleWidth(tzwj), 6);
	assert.ok(tzwj.includes("👩🏽‍💻"));
});

// ---------------------------------------------------------------------------
// 8. fitLine contracts
// ---------------------------------------------------------------------------

test("fitLine produces exact visible width for every valid width", () => {
	assert.equal(fitLine("hello", 0), "");
	assert.equal(fitLine("hello", -5), "");

	// Shorter string is padded with spaces
	assert.equal(fitLine("hello", 10), "hello     ");
	assert.equal(visibleWidth(fitLine("hello", 10)), 10);

	// Longer string is truncated and right-padded if wide char boundary caused shortfall
	assert.equal(fitLine("hello world", 6), "hello…");
	assert.equal(visibleWidth(fitLine("hello world", 6)), 6);

	assert.equal(fitLine("你好世界", 4), "你… "); // truncLine gave width 3, padded to 4
	assert.equal(visibleWidth(fitLine("你好世界", 4)), 4);
});

// ---------------------------------------------------------------------------
// 9. Width invariants at widths 1..160
// ---------------------------------------------------------------------------

test("width invariants for truncLine and fitLine across widths 1..160", () => {
	const testInputs = [
		"The quick brown fox jumps over the lazy dog and runs through the forest.",
		"\x1b[31mRed \x1b[32mGreen \x1b[1;34mBold Blue \x1b[43mYellow BG\x1b[0m trailing plain text.",
		"🔥🚀✨🎉 👩🏽‍💻 👨‍👩‍👧‍👦 emoji string that exceeds regular column budgets.",
		"日本語と中文の長いテスト文字列です。宽字符测试字符串。",
		"\x1b[32m✓ 47\x1b[0m \x1b[1m你好 🚀\x1b[0m worker/src/lib/schema.ts — an extensive file path.",
	];

	for (const input of testInputs) {
		for (let width = 1; width <= 160; width++) {
			const truncated = truncLine(input, width);
			const truncatedWidth = visibleWidth(truncated);
			assert.ok(
				truncatedWidth <= width,
				`truncLine exceeded width ${width} (got ${truncatedWidth}): ${JSON.stringify(truncated)}`
			);

			const fitted = fitLine(input, width);
			const fittedWidth = visibleWidth(fitted);
			assert.equal(
				fittedWidth,
				width,
				`fitLine did not reach exact width ${width} (got ${fittedWidth}): ${JSON.stringify(fitted)}`
			);
		}
	}
});

// ---------------------------------------------------------------------------
// 10. Existing helper contracts (trunc, pad, row, View)
// ---------------------------------------------------------------------------

test("trunc, pad, row, and View preserve existing observable behavior", () => {
	// trunc
	assert.equal(trunc("hello", 10), "hello");
	assert.equal(visibleWidth(trunc("hello world", 6)), 6);
	assert.ok(trunc("hello world", 6).includes("…"));
	assert.equal(trunc("hello", 0), "");

	// pad
	assert.equal(pad("hello", 10), "hello     ");
	assert.equal(visibleWidth(pad("hello world", 6)), 6);

	// row
	const r = row("left", "right", 20);
	assert.equal(visibleWidth(r), 20);
	assert.ok(r.startsWith("left"));
	assert.ok(r.endsWith("right"));

	// fitParts
	const parts = ["a", "b", "c"];
	assert.equal(fitParts(parts, 10, " · "), "a · b · c");

	// plural
	assert.equal(plural(1, "file"), "1 file");
	assert.equal(plural(2, "file"), "2 files");

	// View
	const view = new View(() => ["a".repeat(50), "short"]);
	const rendered = view.render(10);
	assert.deepEqual(rendered.map(visibleWidth), [10, 5]);
	assert.ok(rendered[0]!.endsWith("…"));

	// View survives throwing builder
	const broken = new View(() => {
		throw new Error("error");
	});
	assert.deepEqual(broken.render(20), []);
});
