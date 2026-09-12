import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyEffort,
	applyModel,
	envOverrides,
	envOverridesFor,
	listModels,
	parseModelCatalogue,
	parseSettingsArgs,
	readUserConfig,
	saveUserConfig,
	settingsPatch,
} from "../src/settings.ts";

const SAMPLE_CATALOGUE = [
	"Fetching available models...",
	"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
	"gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
	"gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
	"claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
	"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
	"",
].join("\n");

test("parseModelCatalogue reads slug/label rows and drops the banner", () => {
	const entries = parseModelCatalogue(SAMPLE_CATALOGUE);
	assert.equal(entries.length, 5);
	assert.deepEqual(entries[0], { slug: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" });
	assert.deepEqual(entries.at(-1), { slug: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" });
});

test("parseModelCatalogue tolerates colour, slug-only rows, and duplicates", () => {
	const entries = parseModelCatalogue("\u001b[36mgemini-3.1-pro-high\u001b[0m\ngemini-3.1-pro-high\nclaude-opus-4-6-thinking\n");
	assert.deepEqual(entries, [
		{ slug: "gemini-3.1-pro-high", label: "gemini-3.1-pro-high" },
		{ slug: "claude-opus-4-6-thinking", label: "claude-opus-4-6-thinking" },
	]);
});

test("listModels returns [] when agy fails or throws", async () => {
	assert.deepEqual(await listModels("agy", async () => ({ code: 1, stdout: "boom" })), []);
	assert.deepEqual(
		await listModels("agy", async () => {
			throw new Error("ENOENT");
		}),
		[]
	);
});

test("listModels parses a successful catalogue", async () => {
	const entries = await listModels("agy", async (command, args) => {
		assert.equal(command, "agy");
		assert.deepEqual(args, ["models"]);
		return { code: 0, stdout: SAMPLE_CATALOGUE };
	});
	assert.equal(entries.length, 5);
});

test("parseSettingsArgs accepts a value, flags in any order, and reports extras", () => {
	assert.deepEqual(parseSettingsArgs("gemini-3.1-pro-high"), { value: "gemini-3.1-pro-high", session: false, help: false, extra: [] });
	assert.deepEqual(parseSettingsArgs("high --session"), { value: "high", session: true, help: false, extra: [] });
	assert.deepEqual(parseSettingsArgs("-s high"), { value: "high", session: true, help: false, extra: [] });
	assert.deepEqual(parseSettingsArgs("--help"), { value: undefined, session: false, help: true, extra: [] });
	assert.deepEqual(parseSettingsArgs("high extra"), { value: "high", session: false, help: false, extra: ["extra"] });
	assert.deepEqual(parseSettingsArgs("   "), { value: undefined, session: false, help: false, extra: [] });
});

test("applyModel follows the effort encoded in a gemini slug", () => {
	const target = { model: "gemini-3.8-flash-high", effort: "high" as const };
	assert.deepEqual(applyModel(target, " gemini-3.1-pro-low "), { model: "gemini-3.1-pro-low", effort: "low" });
	assert.equal(target.model, "gemini-3.1-pro-low");
});

test("applyModel rewrites a mismatched gemini slug and leaves other models alone", () => {
	const target = { model: "gemini-3.8-flash-high", effort: "low" as const };
	// A slug with no effort suffix is kept consistent with the configured effort.
	assert.deepEqual(applyModel(target, "gemini-3.8-flash"), { model: "gemini-3.8-flash", effort: "low" });
	// Non-gemini slugs pass through; agy ignores --effort for them.
	assert.deepEqual(applyModel(target, "claude-opus-4-6-thinking"), { model: "claude-opus-4-6-thinking", effort: "low" });
});

test("applyEffort keeps a gemini slug in sync", () => {
	const target = { model: "gemini-3.8-flash-high", effort: "high" as const };
	assert.deepEqual(applyEffort(target, "medium"), { model: "gemini-3.8-flash-medium", effort: "medium" });
	const claude = { model: "claude-sonnet-4-6", effort: "high" as const };
	assert.deepEqual(applyEffort(claude, "low"), { model: "claude-sonnet-4-6", effort: "low" });
});

test("settingsPatch always writes model + effort together", () => {
	assert.deepEqual(settingsPatch({ model: "gemini-3.8-flash-low", effort: "low" }), {
		model: "gemini-3.8-flash-low",
		effort: "low",
	});
});

test("envOverrides reports only set AGY_MODEL / AGY_EFFORT", () => {
	assert.deepEqual(envOverrides({}), []);
	assert.deepEqual(envOverrides({ AGY_MODEL: "  " } as NodeJS.ProcessEnv), []);
	assert.deepEqual(envOverrides({ AGY_MODEL: "m", AGY_EFFORT: "low" } as NodeJS.ProcessEnv), ["AGY_MODEL", "AGY_EFFORT"]);
});

test("saveUserConfig preserves unrelated keys and round-trips through readUserConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-settings-"));
	try {
		const file = join(dir, "nested", "agy.json");
		assert.deepEqual(readUserConfig(file), {});

		writeFileSync(join(dir, "agy.json"), JSON.stringify({ timeout: "20m", roles: { scout: { effort: "low" } } }));
		assert.deepEqual(readUserConfig(join(dir, "agy.json")), { timeout: "20m", roles: { scout: { effort: "low" } } });

		const merged = saveUserConfig(file, { model: "gemini-3.1-pro-high", effort: "high" });
		assert.deepEqual(merged, { model: "gemini-3.1-pro-high", effort: "high" });
		assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);

		saveUserConfig(file, { effort: "low" });
		assert.deepEqual(readUserConfig(file), { model: "gemini-3.1-pro-high", effort: "low" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("envOverridesFor reports only the relevant variable", () => {
	const env = { AGY_MODEL: "m", AGY_EFFORT: "low" } as NodeJS.ProcessEnv;
	assert.deepEqual(envOverridesFor("model", env), ["AGY_MODEL"]);
	assert.deepEqual(envOverridesFor("effort", env), ["AGY_EFFORT"]);
	assert.deepEqual(envOverridesFor("effort", {}), []);
});

test("saveUserConfig writes through a symlink instead of replacing it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-settings-"));
	try {
		const real = join(dir, "real.json");
		const link = join(dir, "agy.json");
		writeFileSync(real, JSON.stringify({ timeout: "20m" }));
		try {
			symlinkSync(real, link);
		} catch {
			t.skip("symlinks unavailable on this platform");
			return;
		}
		saveUserConfig(link, { model: "gemini-3.1-pro-high", effort: "high" });
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), {
			timeout: "20m",
			model: "gemini-3.1-pro-high",
			effort: "high",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readUserConfig rejects JSON that is not an object", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-settings-"));
	try {
		const file = join(dir, "agy.json");
		writeFileSync(file, "[1,2,3]");
		assert.throws(() => readUserConfig(file), /must contain a JSON object/);
		writeFileSync(file, "{oops");
		assert.throws(() => readUserConfig(file), /not valid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
