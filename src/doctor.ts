/**
 * `/agy-doctor` — a bounded health check for the pi-agy setup.
 *
 * pi-subagents ships `/subagents-doctor` because a delegation stack fails in
 * confusing ways when its prerequisites are wrong (missing CLI, unauthenticated
 * session, a config that silently overrides the model). pi-agy has the same
 * class of failure modes, plus one that is easy to get wrong: swallowing the
 * fact that headless agy denies file writes unless `allowCommands` is set.
 *
 * The checks are pure data in / formatted text out, with every I/O dependency
 * injected, so the whole report is unit-testable without an agy install.
 */

import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import type { AgyConfig } from "./config.ts";
import type { AgyRole } from "./roles.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	detail: string;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	/** False only when at least one check failed (warn does not block use). */
	ok: boolean;
}

export interface DoctorExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface DoctorDeps {
	config: AgyConfig;
	roles: readonly AgyRole[];
	workspace: string;
	/** Run a command; must never throw (return a non-zero code instead). */
	exec: (bin: string, args: string[]) => Promise<DoctorExecResult>;
	exists: (path: string) => boolean;
	isDirectory: (path: string) => boolean;
	/** Raw parsed contents of the user config file, when it exists. */
	readConfigFile: (path: string) => { ok: true; value: unknown } | { ok: false; error: string };
}

/** Default `exec` backed by `execFile` with a hard timeout. */
export function defaultDoctorExec(bin: string, args: string[], timeoutMs = 15_000) {
	return new Promise<DoctorExecResult>((resolve) => {
		execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === "number"
				? (error as { code: number }).code
				: error
					? 1
					: 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
	const { config, roles, workspace } = deps;
	const checks: DoctorCheck[] = [];

	// 1. CLI present and runnable. A missing/misconfigured binary makes every
	//    other check meaningless, so this one is a hard failure.
	const version = await deps.exec(config.bin, ["--version"]);
	if (version.code === 0 && firstLine(version.stdout)) {
		checks.push({ name: "agy CLI", status: "ok", detail: `${config.bin} ${firstLine(version.stdout)}` });
	} else if (version.code === 0) {
		checks.push({ name: "agy CLI", status: "warn", detail: `${config.bin} ran but reported no version` });
	} else {
		checks.push({
			name: "agy CLI",
			status: "fail",
			detail:
				`could not run \`${config.bin} --version\` (exit ${version.code})` +
				(version.stderr.trim() ? `: ${firstLine(version.stderr)}` : "") +
				`. Install the Antigravity CLI or set AGY_BIN.`,
		});
	}

	// 2. User config file parses. A malformed file is silently ignored at load
	//    time, which looks like "my settings do nothing".
	if (deps.exists(config.configFile)) {
		const parsed = deps.readConfigFile(config.configFile);
		checks.push(
			parsed.ok
				? { name: "config file", status: "ok", detail: `${config.configFile} parsed` }
				: { name: "config file", status: "fail", detail: `${config.configFile}: ${parsed.error}` }
		);
	} else {
		checks.push({
			name: "config file",
			status: "ok",
			detail: `${config.configFile} not present (using defaults + env vars)`,
		});
	}

	// 3. Workspace usable.
	if (!deps.exists(workspace)) {
		checks.push({ name: "workspace", status: "fail", detail: `${workspace} does not exist` });
	} else if (!deps.isDirectory(workspace)) {
		checks.push({ name: "workspace", status: "fail", detail: `${workspace} is not a directory` });
	} else {
		checks.push({ name: "workspace", status: "ok", detail: workspace });
	}

	// 4. The permission trap. This is the single most confusing failure mode:
	//    agy reports SUCCESS while every write was denied.
	checks.push(
		config.defaultAllowCommands
			? {
					name: "permissions",
					status: "ok",
					detail: "allowCommands defaults to true — writes and shell commands are permitted",
				}
			: {
					name: "permissions",
					status: "warn",
					detail:
						"allowCommands defaults to false: agy DENIES file writes and shell commands in headless mode. " +
						"Read-only presets still work, but any writing task (agy_code, agy_role implementer) will silently do nothing.",
				}
	);

	// 5. Roles: catch a custom role that cannot do anything useful.
	const brokenRoles = roles.filter((role) => !role.guidance.trim());
	checks.push(
		brokenRoles.length
			? {
					name: "roles",
					status: "warn",
					detail: `role(s) with no prompt guidance: ${brokenRoles.map((r) => r.id).join(", ")}`,
				}
			: {
					name: "roles",
					status: "ok",
					detail: `${roles.length} available: ${roles.map((r) => r.id).join(", ")}`,
				}
	);

	// 6. Model catalogue. Best-effort: an older CLI may not support `models`.
	const models = await deps.exec(config.bin, ["models"]);
	const catalog = models.code === 0 ? models.stdout.trim() : "";
	if (catalog) {
		const listed = catalog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		const hasConfigured = listed.some((line) => line.includes(config.model));
		checks.push({
			name: "models",
			status: hasConfigured ? "ok" : "warn",
			detail: hasConfigured
				? `configured model ${config.model} is available`
				: `configured model ${config.model} was not found in \`agy models\` output`,
		});
	} else {
		checks.push({
			name: "models",
			status: "warn",
			detail: `could not list models (exit ${models.code}); ${config.model} will be used as configured`,
		});
	}

	// 7. Fallback chain sanity.
	checks.push({
		name: "fallbacks",
		status: "ok",
		detail: config.fallbackModels.length
			? `retry order: ${config.model} → ${config.fallbackModels.join(" → ")}`
			: "none configured (set AGY_FALLBACK_MODELS or fallbackModels to survive a model outage)",
	});

	return { checks, ok: checks.every((check) => check.status !== "fail") };
}

/** Human-readable report for the TUI notification and non-UI output. */
export function formatDoctorReport(report: DoctorReport): string {
	const glyph: Record<DoctorStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
	const lines = [
		report.ok ? "pi-agy doctor: setup looks usable." : "pi-agy doctor: problems found.",
		"",
	];
	for (const check of report.checks) lines.push(`${glyph[check.status]} ${check.name} — ${check.detail}`);
	return lines.join("\n");
}

/** Full dependency set for a real run against the current machine. */
export async function doctorDeps(config: AgyConfig, roles: readonly AgyRole[], workspace: string): Promise<DoctorDeps> {
	const { readFileSync } = await import("node:fs");
	return {
		config,
		roles,
		workspace,
		exec: (bin, args) => defaultDoctorExec(bin, args),
		exists: (path) => existsSync(path),
		isDirectory: (path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
		readConfigFile: (path) => {
			try {
				return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
