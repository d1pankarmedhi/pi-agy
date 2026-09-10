import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	buildVisionPrompt,
	isImagePath,
	NO_SHELL_GUIDE,
	normalizeImages,
	resolveVisionAllowCommands,
	stageLocalImages,
	VISION_GUIDE,
} from "../src/vision.ts";
import { resolveLocalPath } from "../src/paths.ts";

test("normalizeImages trims, drops empties, and de-duplicates in order", () => {
	assert.deepEqual(normalizeImages([" a.png ", "", "  ", "a.png", "b/c.jpg"]), ["a.png", "b/c.jpg"]);
	assert.deepEqual(normalizeImages(undefined), []);
	assert.deepEqual(normalizeImages([]), []);
});

test("isImagePath recognizes common image extensions", () => {
	for (const p of ["a.png", "B.JPEG", "c.webp", "d.svg", "e.tif", "f.avif", "g.bmp"])
		assert.equal(isImagePath(p), true, `${p} should be an image`);
	for (const p of ["a.ts", "b.txt", "c", "d.md", "e.json"]) assert.equal(isImagePath(p), false);
});

test("buildVisionPrompt always leads with the inspect-the-pixels guide and the task", () => {
	const out = buildVisionPrompt({ prompt: "  What colour is the button?  " });
	assert.ok(out.startsWith(VISION_GUIDE));
	assert.match(out, /Task: What colour is the button\?/);
	assert.doesNotMatch(out, /Images to inspect/);
});

test("buildVisionPrompt lists every image and asks for inspectable evidence", () => {
	const out = buildVisionPrompt({ prompt: "Find layout bugs", images: ["shot.png", "shot.png", " C:\\tmp\\ui.png "] });
	assert.match(out, /Images to inspect/);
	assert.match(out, /- shot\.png/);
	assert.match(out, /- C:\\tmp\\ui\.png/);
	assert.equal(out.split("- shot.png").length - 1, 1, "duplicate images must not be listed twice");
	assert.match(out, /list the image file\(s\) you inspected/);
});

test("buildVisionPrompt adds a headless-Chrome screenshot step when a url is given", () => {
	const out = buildVisionPrompt({ prompt: "Review the landing page", url: " http://localhost:3000 " });
	assert.match(out, /capture a screenshot of this page/);
	assert.match(out, /- http:\/\/localhost:3000/);
	assert.match(out, /--headless=new/);
	assert.match(out, /--screenshot=<file>\.png/);
	assert.match(out, /locate a Chromium browser/);
});

test("buildVisionPrompt ignores a blank url and needs no evidence note without images", () => {
	const out = buildVisionPrompt({ prompt: "Describe this", url: "   " });
	assert.doesNotMatch(out, /capture a screenshot/);
	assert.doesNotMatch(out, /list the image file/);
});

test("buildVisionPrompt adds the read-only guard when shell access is off", () => {
	const readOnly = buildVisionPrompt({ prompt: "Describe", images: ["a.png"], allowCommands: false });
	assert.match(readOnly, /Shell commands are DENIED/);
	assert.ok(readOnly.includes(NO_SHELL_GUIDE));
	// Absent when shell is allowed (or unspecified).
	assert.doesNotMatch(buildVisionPrompt({ prompt: "Describe", allowCommands: true }), /DENIED/);
	assert.doesNotMatch(buildVisionPrompt({ prompt: "Describe" }), /DENIED/);
});

test("vision stays read-only unless shell access is needed or requested", () => {
	assert.equal(resolveVisionAllowCommands(undefined, undefined), false);
	assert.equal(resolveVisionAllowCommands(undefined, ""), false);
	assert.equal(resolveVisionAllowCommands(undefined, "   "), false);
	assert.equal(resolveVisionAllowCommands(undefined, "http://localhost:3000"), true);
	// An explicit choice always wins over the url-derived default.
	assert.equal(resolveVisionAllowCommands(true, undefined), true);
	assert.equal(resolveVisionAllowCommands(false, "http://localhost:3000"), false);
});

// ---------------------------------------------------------------------------
// Local path resolution + staging (files outside the workspace)
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function makeImage(dir: string, name: string): string {
	const p = join(dir, name);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	return p;
}

test("stageLocalImages passes workspace files through untouched", () => {
	const ws = tmpDir("pi-agy-ws-");
	const file = makeImage(join(ws, "shots"), "home.png");
	const out = stageLocalImages(["shots/home.png"], ws);
	try {
		assert.deepEqual(out.images, [file]);
		assert.deepEqual(out.addDirs, []);
		assert.deepEqual(out.staged, []);
		assert.deepEqual(out.missing, []);
	} finally {
		out.cleanup();
		rmSync(ws, { recursive: true, force: true });
	}
});

test("stageLocalImages copies images from outside the workspace and cleans up", () => {
	const ws = tmpDir("pi-agy-ws-");
	const outside = tmpDir("pi-agy-out-");
	const file = makeImage(outside, "desktop-shot.png");
	const out = stageLocalImages([file], ws);
	try {
		assert.equal(out.staged.length, 1);
		assert.equal(out.staged[0]!.from, file);
		assert.equal(out.addDirs.length, 1);
		const stagedPath = out.images[0]!;
		assert.ok(existsSync(stagedPath), "staged copy must exist for the agent");
		assert.equal(basename(stagedPath), "desktop-shot.png");
		assert.notEqual(dirname(stagedPath), outside, "must not copy next to the original");
		assert.ok(stagedPath.startsWith(out.addDirs[0]!), "staged file must live in the registered dir");
		// The path handed to the agent in the prompt is the staged copy.
		const prompt = buildVisionPrompt({ prompt: "Describe it", images: out.images });
		assert.ok(prompt.includes(stagedPath), "prompt must list the staged path");
		assert.ok(!prompt.includes(file), "prompt must not point the agent at an unreadable path");
		out.cleanup();
		assert.equal(existsSync(out.addDirs[0]!), false, "staging dir is removed after the run");
	} finally {
		out.cleanup();
		rmSync(ws, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("stageLocalImages de-duplicates same-named images from different directories", () => {
	const ws = tmpDir("pi-agy-ws-");
	const a = tmpDir("pi-agy-a-");
	const b = tmpDir("pi-agy-b-");
	const one = makeImage(a, "shot.png");
	const two = makeImage(b, "shot.png");
	// The same file passed twice in different forms stages only one copy.
	const out = stageLocalImages([one, two, one.split("\\").join("/")], ws);
	try {
		assert.equal(out.images.length, 2);
		assert.equal(basename(out.images[0]!), "shot.png");
		assert.equal(basename(out.images[1]!), "shot-2.png");
		assert.ok(existsSync(out.images[0]!) && existsSync(out.images[1]!));
	} finally {
		out.cleanup();
		rmSync(ws, { recursive: true, force: true });
		rmSync(a, { recursive: true, force: true });
		rmSync(b, { recursive: true, force: true });
	}
});

test("stageLocalImages reports missing paths, accepts ~/file://, and skips URLs", () => {
	const ws = tmpDir("pi-agy-ws-");
	const outside = tmpDir("pi-agy-out-");
	const file = makeImage(outside, "ui.png");
	const out = stageLocalImages(
		["nope/missing.png", `file://${file.split("\\").join("/")}`, "https://example.com/shot.png"],
		ws
	);
	try {
		assert.deepEqual(out.missing, ["nope/missing.png"]);
		assert.equal(out.images.length, 2);
		assert.equal(out.images[1], "https://example.com/shot.png");
		assert.equal(out.staged.length, 1, "the file:// image is staged like any local path");
		assert.equal(out.staged[0]!.from, file);
	} finally {
		out.cleanup();
		rmSync(ws, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("stageLocalImages is a no-op without images", () => {
	const out = stageLocalImages(undefined, tmpDir("pi-agy-ws-"));
	assert.deepEqual(out.images, []);
	assert.deepEqual(out.addDirs, []);
	assert.deepEqual(out.missing, []);
	assert.doesNotThrow(() => out.cleanup());
});

test("resolveLocalPath resolves relative paths and expands ~", () => {
	const base = tmpDir("pi-agy-base-");
	assert.equal(resolveLocalPath("shots/a.png", base), join(base, "shots", "a.png"));
	assert.equal(resolveLocalPath("./a.png", base), join(base, "a.png"));
	const home = resolveLocalPath("~/pics/a.png", base);
	assert.equal(home, join(homedir(), "pics", "a.png"));
	assert.equal(resolveLocalPath(join(base, "abs.png"), tmpDir("pi-agy-other-")), join(base, "abs.png"));
});
