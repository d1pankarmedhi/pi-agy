import { test } from "node:test";
import assert from "node:assert/strict";
import { matchEffort } from "../index.ts";

test("matchEffort rewrites gemini slugs to the requested effort", () => {
	assert.equal(matchEffort("gemini-3.8-flash-medium", "high"), "gemini-3.8-flash-high");
	assert.equal(matchEffort("gemini-3.8-flash-high", "high"), "gemini-3.8-flash-high");
	assert.equal(matchEffort("gemini-3.1-pro-high", "low"), "gemini-3.1-pro-low");
});

test("matchEffort leaves already-matching slugs unchanged", () => {
	assert.equal(matchEffort("gemini-3.8-flash-high", "high"), "gemini-3.8-flash-high");
});

test("matchEffort leaves non-gemini models unchanged", () => {
	assert.equal(matchEffort("claude-sonnet-4-6", "high"), "claude-sonnet-4-6");
	assert.equal(matchEffort("gpt-oss-120b-medium", "high"), "gpt-oss-120b-medium");
});

test("matchEffort with no effort returns the model unchanged", () => {
	assert.equal(matchEffort("gemini-3.8-flash-medium", undefined), "gemini-3.8-flash-medium");
});