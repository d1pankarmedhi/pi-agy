import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildVisionPrompt,
	isImagePath,
	NO_SHELL_GUIDE,
	normalizeImages,
	resolveVisionAllowCommands,
	VISION_GUIDE,
} from "../src/vision.ts";

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
