import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelEffort } from "../src/config.ts";

const base = { defaultModel: "gemini-3.8-flash-high", defaultEffort: "high" as const };

test("resolveModelEffort keeps the built-in defaults", () => {
	assert.deepEqual(resolveModelEffort({ ...base }), { model: "gemini-3.8-flash-high", effort: "high" });
});

test("an env model's encoded effort beats the default effort", () => {
	assert.deepEqual(resolveModelEffort({ ...base, envModel: "gemini-3.8-flash-low" }), {
		model: "gemini-3.8-flash-low",
		effort: "low",
	});
});

test("an env model beats a file-level effort (no precedence inversion)", () => {
	assert.deepEqual(
		resolveModelEffort({
			...base,
			envModel: "gemini-3.8-flash-high",
			fileModel: "gemini-3.8-flash-low",
			fileEffort: "low",
		}),
		{ model: "gemini-3.8-flash-high", effort: "high" }
	);
});

test("an env effort beats a file model and rewrites its slug", () => {
	assert.deepEqual(
		resolveModelEffort({
			...base,
			envEffort: "low",
			fileModel: "gemini-3.8-flash-high",
			fileEffort: "high",
		}),
		{ model: "gemini-3.8-flash-low", effort: "low" }
	);
});

test("a same-level file model + effort keeps the explicit effort", () => {
	assert.deepEqual(resolveModelEffort({ ...base, fileModel: "gemini-3.8-flash-medium", fileEffort: "high" }), {
		model: "gemini-3.8-flash-high",
		effort: "high",
	});
});

test("non-gemini models are never rewritten", () => {
	assert.deepEqual(resolveModelEffort({ ...base, envModel: "claude-opus-4-6-thinking" }), {
		model: "claude-opus-4-6-thinking",
		effort: "high",
	});
	assert.deepEqual(resolveModelEffort({ ...base, envModel: "gpt-oss-120b-medium", fileEffort: "low" }), {
		model: "gpt-oss-120b-medium",
		effort: "low",
	});
});

test("multi-segment gemini slugs still encode their effort", () => {
	assert.deepEqual(resolveModelEffort({ ...base, envModel: "gemini-2.5-pro-preview-low" }), {
		model: "gemini-2.5-pro-preview-low",
		effort: "low",
	});
});

test("invalid and blank effort/model values are ignored", () => {
	assert.deepEqual(resolveModelEffort({ ...base, envEffort: "extreme" }), { model: "gemini-3.8-flash-high", effort: "high" });
	assert.deepEqual(resolveModelEffort({ ...base, envModel: "gemini-3.8-flash-low", envEffort: "extreme" }), {
		model: "gemini-3.8-flash-low",
		effort: "low",
	});
	assert.deepEqual(resolveModelEffort({ ...base, envModel: "  ", envEffort: "  " }), {
		model: "gemini-3.8-flash-high",
		effort: "high",
	});
});
