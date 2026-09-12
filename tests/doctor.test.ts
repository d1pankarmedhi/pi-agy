import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDoctorReport, runDoctor, type DoctorDeps, type DoctorExecResult } from "../src/doctor.ts";
import { resolveRoles } from "../src/roles.ts";
import type { AgyConfig } from "../src/config.ts";

const CONFIG: AgyConfig = {
	bin: "agy",
	model: "gemini-3.8-flash-high",
	effort: "high",
	timeout: "10m",
	defaultAllowCommands: true,
	fleetConcurrency: 3,
	fallbackModels: [],
	roles: {},
	configFile: "/home/u/.pi/agy.json",
};

const MODELS = "gemini-3.8-flash-high\ngemini-3.1-pro-high\n";

function deps(over: Partial<DoctorDeps> = {}, responses: Record<string, DoctorExecResult> = {}): DoctorDeps {
	return {
		config: CONFIG,
		roles: resolveRoles(undefined),
		workspace: "/ws",
		exec: async (bin, args) => {
			const key = `${bin} ${args.join(" ")}`;
			return responses[key] ?? { code: 0, stdout: args[0] === "--version" ? "1.2.2\n" : MODELS, stderr: "" };
		},
		exists: () => true,
		isDirectory: () => true,
		readConfigFile: () => ({ ok: true, value: {} }),
		...over,
	};
}

function check(report: { checks: { name: string; status: string; detail: string }[] }, name: string) {
	const found = report.checks.find((c) => c.name === name);
	assert.ok(found, `missing check ${name}`);
	return found!;
}

test("a healthy setup reports every check ok", async () => {
	const report = await runDoctor(deps());
	assert.equal(report.ok, true);
	assert.ok(report.checks.every((c) => c.status === "ok"), JSON.stringify(report.checks, null, 2));
	assert.match(check(report, "agy CLI").detail, /1\.2\.2/);
	assert.match(check(report, "roles").detail, /scout/);
});

test("an unrunnable agy CLI is a hard failure with remediation", async () => {
	const report = await runDoctor(
		deps({}, { "agy --version": { code: 127, stdout: "", stderr: "command not found" } })
	);
	assert.equal(report.ok, false);
	const cli = check(report, "agy CLI");
	assert.equal(cli.status, "fail");
	assert.match(cli.detail, /AGY_BIN/);
	assert.match(cli.detail, /command not found/);
});

test("writes being denied is a warning, not a failure", async () => {
	const report = await runDoctor(deps({ config: { ...CONFIG, defaultAllowCommands: false } }));
	assert.equal(report.ok, true, "read-only use is still viable");
	const permissions = check(report, "permissions");
	assert.equal(permissions.status, "warn");
	assert.match(permissions.detail, /DENIES file writes/);
});

test("a malformed config file is reported instead of silently ignored", async () => {
	const report = await runDoctor(deps({ readConfigFile: () => ({ ok: false, error: "Unexpected token }" }) }));
	assert.equal(report.ok, false);
	const config = check(report, "config file");
	assert.equal(config.status, "fail");
	assert.match(config.detail, /Unexpected token/);
});

test("a missing workspace fails, a non-directory workspace fails", async () => {
	const missing = await runDoctor(deps({ exists: () => false }));
	assert.equal(check(missing, "workspace").status, "fail");
	const notDir = await runDoctor(deps({ isDirectory: () => false }));
	assert.equal(check(notDir, "workspace").status, "fail");
	assert.match(check(notDir, "workspace").detail, /not a directory/);
});

test("a configured model missing from the catalogue is a warning", async () => {
	const report = await runDoctor(deps({ config: { ...CONFIG, model: "gemini-9-ultra" } }));
	const models = check(report, "models");
	assert.equal(models.status, "warn");
	assert.match(models.detail, /gemini-9-ultra/);
});

test("a role with no guidance is flagged and the fallback chain is reported", async () => {
	const roles = resolveRoles({ broken: { description: "no prompt" } });
	const report = await runDoctor(deps({ roles }));
	assert.equal(check(report, "roles").status, "warn");
	assert.match(check(report, "roles").detail, /broken/);

	const withFallback = await runDoctor(deps({ config: { ...CONFIG, fallbackModels: ["a", "b"] } }));
	assert.match(check(withFallback, "fallbacks").detail, /gemini-3\.8-flash-high → a → b/);
});

test("formatDoctorReport renders a status glyph per check", async () => {
	const text = formatDoctorReport(await runDoctor(deps({ config: { ...CONFIG, defaultAllowCommands: false } })));
	assert.match(text, /^pi-agy doctor: setup looks usable\./);
	assert.match(text, /✓ agy CLI/);
	assert.match(text, /⚠ permissions/);

	const failed = formatDoctorReport(await runDoctor(deps({}, { "agy --version": { code: 1, stdout: "", stderr: "boom" } })));
	assert.match(failed, /^pi-agy doctor: problems found\./);
	assert.match(failed, /✗ agy CLI/);
});
