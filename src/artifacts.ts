import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveLocalPath } from "./paths.ts";
import type { StreamResult } from "./runner.ts";
import { formatDuration } from "./status.ts";

/**
 * Report artifacts: the durable, hand-off-able form of an agy run.
 *
 *   - A fleet is a summary in the conversation (lane responses are capped), so
 *     its full reports are written on every run. Layout:
 *
 *       <root>/fleet-YYYYMMDD-HHMMSS-xxxx/
 *         report.md        one self-contained document: summary table + every lane
 *         manifest.json    machine-readable index (statuses, evidence, provenance)
 *         lanes/<id>.md    one full report per lane
 *
 *   - A single run's response is returned intact, so writing it is opt-in
 *     (`output: true`). Layout:
 *
 *       <root>/run-YYYYMMDD-HHMMSS-xxxx/
 *         report.md        frontmatter + task + response + evidence + run log
 *         manifest.json    the same provenance, machine-readable
 *
 * Either way the result names the path, so an orchestrator can pass it to
 * another agent or a third party instead of re-typing a paraphrase.
 *
 * Cleanup is not a required step: every write prunes older reports by count and
 * age, so the directories cannot grow without bound. `clearReports` gives the
 * orchestrator an explicit, bounded way to free space once it has consumed them.
 */

export const ARTIFACT_SCHEMA_VERSION = 1;

/** Default roots, relative to the workspace unless the user configures a path. */
export const DEFAULT_FLEET_OUTPUT = ".agy/fleet";
export const DEFAULT_RUN_OUTPUT = ".agy/runs";

/** Report directories are `fleet-…` or `run-…`; cleanup touches only matches. */
const REPORT_DIR_RE = /^(?:fleet|run)-\d{8}-\d{6}-[a-z0-9]{4}$/;

/** Which kind of run a report directory belongs to. */
export type ReportKind = "fleet" | "run";

const REPORT_NAME = "report.md";
const MANIFEST_NAME = "manifest.json";

/** One lane, in the shape the writers need (a FleetLaneState satisfies it). */
export interface ArtifactLane {
	id: string;
	task: string;
	workspace: string;
	status: string;
	error?: string;
	role?: string;
	model?: string;
	effort?: string;
	startedAt?: number;
	endedAt?: number;
	result?: StreamResult;
}

export interface FleetMeta {
	kind?: ReportKind;
	fleetId: string;
	cwd: string;
	concurrency: number;
	aborted: boolean;
	startedAt: number;
	finishedAt: number;
}

export type FleetOutputTarget =
	| { mode: "off" }
	| { mode: "dir"; dir: string }
	| { mode: "file"; file: string };

/**
 * Decide where a report goes. `true` uses the configured root, a `.md` path is a
 * single combined document, `false`/`off` disables output. `defaultOn` covers
 * the two callers: fleets always write, single runs write only when asked.
 */
export function resolveReportOutput(
	output: string | boolean | undefined,
	cwd: string,
	fallbackDir: string,
	defaultOn = true
): FleetOutputTarget {
	if (output === false) return { mode: "off" };
	if (output === undefined) return defaultOn ? dirTarget(fallbackDir, cwd) : { mode: "off" };
	if (output === true) return dirTarget(fallbackDir, cwd);
	if (/^(off|none|false)$/i.test(output.trim())) return { mode: "off" };
	if (!output.trim()) return defaultOn ? dirTarget(fallbackDir, cwd) : { mode: "off" };
	const resolved = resolveLocalPath(output.trim(), cwd);
	return /\.md$/i.test(resolved) ? { mode: "file", file: resolved } : { mode: "dir", dir: resolved };
}

function dirTarget(fallbackDir: string, cwd: string): FleetOutputTarget {
	const target = fallbackDir.trim();
	if (!target || /^(off|none|false)$/i.test(target)) return { mode: "off" };
	const resolved = resolveLocalPath(target, cwd);
	return /\.md$/i.test(resolved) ? { mode: "file", file: resolved } : { mode: "dir", dir: resolved };
}

/** Fleet reports are written on every run (the result is capped); runs opt in. */
export const resolveFleetOutput = (output: string | boolean | undefined, cwd: string, fallback: string) =>
	resolveReportOutput(output, cwd, fallback, true);
export const resolveRunOutput = (output: string | boolean | undefined, cwd: string, fallback: string) =>
	resolveReportOutput(output, cwd, fallback, false);

/**
 * Both report roots for this workspace, skipping disabled or single-file
 * configurations. Used by `agy_reports` and `/agy-reports`.
 */
export function reportRoots(cwd: string, fleetOutput: string, runOutput: string): string[] {
	const roots: string[] = [];
	for (const raw of [fleetOutput, runOutput]) {
		if (!raw || /^(off|none|false)$/i.test(raw.trim())) continue;
		const resolved = resolveLocalPath(raw.trim(), cwd);
		// A single-file configuration is not a managed directory.
		if (/\.md$/i.test(resolved) || roots.includes(resolved)) continue;
		roots.push(resolved);
	}
	return roots;
}

/** Unique, sortable report id. The random suffix keeps parallel runs apart. */
export function newReportId(kind: ReportKind = "fleet", now = Date.now(), suffix?: string): string {
	const d = new Date(now);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const tail = (suffix ?? Math.random().toString(36).slice(2, 6))
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.padEnd(4, "0")
		.slice(0, 4);
	return `${kind}-${stamp}-${tail}`;
}

export const newFleetId = (now = Date.now(), suffix?: string): string => newReportId("fleet", now, suffix);
export const newRunId = (now = Date.now(), suffix?: string): string => newReportId("run", now, suffix);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function yamlString(value: string | undefined): string {
	return value === undefined || value === "" ? "null" : JSON.stringify(value);
}

function yamlList(values: readonly string[] | undefined): string {
	if (!values?.length) return "[]";
	return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function iso(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Table cells must stay on one line and must not break the pipe layout. */
function cell(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/\|/g, "\\|")
		.replace(/\s*\r?\n\s*/g, " ");
}

function shortTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
	return `${Math.round(n / 100_000) / 10}M`;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Every step, with the full command/path — this is a document, not a status line. */
function runLogLines(steps: NonNullable<StreamResult["steps"]>, max = 200): string[] {
	const terminal = steps.filter((s) => s.state !== "active");
	const out: string[] = [];
	for (const step of terminal) {
		if (out.length >= max) {
			out.push(`- … +${terminal.length - out.length} more steps`);
			break;
		}
		const mark = step.state === "failed" ? "✗" : "✓";
		const what = step.command ? `\`${step.command}\`` : step.file ? `\`${step.file}\`` : step.tool;
		out.push(`- ${mark} ${step.index}. ${step.tool} · ${what}`);
	}
	return out;
}

function laneSections(lane: ArtifactLane, now: number): string[] {
	const r = lane.result;
	const dur = (lane.endedAt ?? now) - (lane.startedAt ?? now);
	const lines: string[] = [];

	lines.push("### Task", "");
	for (const line of lane.task.trim().split(/\r?\n/)) lines.push(`> ${line}`);
	lines.push("");

	if (lane.status === "done") {
		lines.push("### Deliverable", "", (r?.response ?? "").trim() || "_(the agent returned no text)_", "");
	} else {
		lines.push("### Failure", "", `\`${lane.status}\`${lane.error ? ` — ${lane.error}` : ""}`, "");
		// A failed lane can still have produced partial output worth keeping.
		const partial = (r?.response ?? "").trim();
		if (partial) lines.push("Partial output before the failure:", "", partial, "");
	}

	const files = r?.files_written ?? [];
	const commands = r?.commands_run ?? [];
	lines.push("### Evidence", "");
	if (!files.length && !commands.length) lines.push("- none reported");
	for (const file of files) lines.push(`- file: \`${file}\``);
	for (const command of commands) lines.push(`- command: \`${command}\``);
	lines.push("");

	// Warnings and denials are the difference between "succeeded" and "did
	// something"; a receiving agent must see them.
	const caveats: string[] = [...(r?.warnings ?? [])];
	for (const denied of r?.denied_actions ?? []) {
		caveats.push(`denied ${denied.action}${denied.display_name ? ` (${denied.display_name})` : ""}`);
	}
	if (caveats.length) {
		lines.push("### Caveats", "");
		for (const caveat of caveats) lines.push(`- ${caveat}`);
		lines.push("");
	}

	const log = runLogLines(r?.steps ?? []);
	lines.push("### Run log", "");
	lines.push(...(log.length ? log : ["- no tool steps recorded"]), "");

	lines.push("### Run", "");
	lines.push(`- lane: \`${lane.id}\``);
	lines.push(`- status: \`${lane.status}\``);
	if (lane.role) lines.push(`- role: \`${lane.role}\``);
	if (lane.model) lines.push(`- model: \`${lane.model}\``);
	if (lane.effort) lines.push(`- effort: \`${lane.effort}\``);
	lines.push(`- workspace: \`${lane.workspace}\``);
	lines.push(`- duration: ${formatDuration(dur)}`);
	if (r?.num_turns !== undefined) lines.push(`- turns: ${r.num_turns}`);
	if (r?.usage?.total_tokens !== undefined) lines.push(`- tokens: ${shortTokens(r.usage.total_tokens)}`);
	if (r?.conversation_id) lines.push(`- conversation: \`${r.conversation_id}\` (resume with \`conversation\`)`);
	lines.push("");
	return lines;
}

/** One lane as a standalone document: YAML frontmatter + the full report. */
export function formatLaneDoc(lane: ArtifactLane, meta: FleetMeta, now = Date.now()): string {
	const r = lane.result;
	const dur = (lane.endedAt ?? now) - (lane.startedAt ?? now);
	const frontmatter = [
		"---",
		`kind: ${yamlString(meta.kind ?? "fleet")}`,
		`lane: ${yamlString(lane.id)}`,
		meta.kind === "run" ? `run: ${yamlString(meta.fleetId)}` : `fleet: ${yamlString(meta.fleetId)}`,
		`status: ${yamlString(lane.status)}`,
		`role: ${yamlString(lane.role)}`,
		`model: ${yamlString(lane.model)}`,
		`effort: ${yamlString(lane.effort)}`,
		`workspace: ${yamlString(lane.workspace)}`,
		`started: ${yamlString(iso(lane.startedAt))}`,
		`finished: ${yamlString(iso(lane.endedAt))}`,
		`duration_seconds: ${(dur / 1000).toFixed(1)}`,
		`turns: ${r?.num_turns ?? "null"}`,
		`tokens: ${r?.usage?.total_tokens ?? "null"}`,
		`tool_steps: ${r?.tool_steps ?? "null"}`,
		`conversation_id: ${yamlString(r?.conversation_id)}`,
		`files_written: ${yamlList(r?.files_written)}`,
		`commands_run: ${yamlList(r?.commands_run)}`,
		"---",
		"",
		`# [${lane.id}] ${lane.status}`,
		"",
	];
	return [...frontmatter, ...laneSections(lane, now)].join("\n").replace(/\n+$/, "\n");
}

/** One self-contained document covering the whole fleet. */
export function formatFleetReport(meta: FleetMeta, lanes: ArtifactLane[], now = Date.now()): string {
	const done = lanes.filter((l) => l.status === "done").length;
	const failed = lanes.filter((l) => l.status === "failed").length;
	const aborted = lanes.filter((l) => l.status === "aborted").length;
	const elapsed = meta.finishedAt - meta.startedAt;

	const lines: string[] = [
		`# agy_fleet — ${done}/${lanes.length} lanes succeeded`,
		"",
		`- fleet: \`${meta.fleetId}\``,
		`- workspace: \`${meta.cwd}\``,
		`- started: ${new Date(meta.startedAt).toISOString()}`,
		`- duration: ${formatDuration(elapsed)}`,
		`- lanes: ${lanes.length} (ok ${done} · failed ${failed} · aborted ${aborted})`,
		`- concurrency: ${meta.concurrency}`,
		`- schema: ${ARTIFACT_SCHEMA_VERSION}`,
		"",
	];
	if (meta.aborted) {
		lines.push("> ⚠ the fleet was stopped early; lanes below hold everything they produced before the stop.", "");
	}

	lines.push(
		"## Lanes",
		"",
		"| lane | status | role | model | duration | turns | tokens | files | commands |",
		"|---|---|---|---|---|---|---|---|---|"
	);
	for (const lane of lanes) {
		const r = lane.result;
		const dur = (lane.endedAt ?? now) - (lane.startedAt ?? now);
		lines.push(
			`| ${cell(lane.id)} | ${cell(lane.status)} | ${cell(lane.role ?? "—")} | ${cell(lane.model ?? "—")} | ` +
				`${seconds(dur)} | ${r?.num_turns ?? "—"} | ${shortTokens(r?.usage?.total_tokens)} | ` +
				`${r?.files_written?.length ?? 0} | ${r?.commands_run?.length ?? 0} |`
		);
	}
	lines.push("");

	for (const lane of lanes) {
		lines.push("---", "", `## [${lane.id}] ${lane.status}`, "", ...laneSections(lane, now));
	}
	return lines.join("\n").replace(/\n+$/, "\n");
}

/** The machine-readable index: labels for humans, paths for other agents. */
export function buildManifest(
	meta: FleetMeta,
	lanes: ArtifactLane[],
	laneFiles: Record<string, string>
): Record<string, unknown> {
	const now = Date.now();
	return {
		schemaVersion: ARTIFACT_SCHEMA_VERSION,
		kind: meta.kind ?? "fleet",
		fleetId: meta.fleetId,
		createdAt: new Date(meta.startedAt).toISOString(),
		finishedAt: new Date(meta.finishedAt).toISOString(),
		cwd: meta.cwd,
		concurrency: meta.concurrency,
		aborted: meta.aborted,
		report: REPORT_NAME,
		totals: {
			lanes: lanes.length,
			done: lanes.filter((l) => l.status === "done").length,
			failed: lanes.filter((l) => l.status === "failed").length,
			aborted: lanes.filter((l) => l.status === "aborted").length,
			elapsedMs: meta.finishedAt - meta.startedAt,
		},
		lanes: lanes.map((lane) => ({
			id: lane.id,
			status: lane.status,
			file: laneFiles[lane.id] ? basename(laneFiles[lane.id]!) : undefined,
			role: lane.role,
			model: lane.model,
			effort: lane.effort,
			workspace: lane.workspace,
			task: lane.task,
			error: lane.error,
			warnings: lane.result?.warnings,
			files_written: lane.result?.files_written,
			commands_run: lane.result?.commands_run,
			conversation_id: lane.result?.conversation_id,
			num_turns: lane.result?.num_turns,
			duration_seconds: lane.result?.duration_seconds,
			usage: lane.result?.usage,
			elapsedMs: (lane.endedAt ?? now) - (lane.startedAt ?? now),
		})),
	};
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteFleetArtifactsOptions {
	/** Directory that holds one subdirectory per fleet. */
	root: string;
	fleetId: string;
	cwd: string;
	concurrency: number;
	aborted: boolean;
	startedAt: number;
	lanes: ArtifactLane[];
	/** Keep at most N fleet directories under root (0 = no limit). */
	keep?: number;
	/** Drop fleet directories finished more than N days ago (0 = no limit). */
	maxAgeDays?: number;
	/** Write `<root>/.gitignore` so the default tree never gets committed. */
	selfIgnore?: boolean;
	now?: number;
}

export interface FleetArtifacts {
	fleetId: string;
	dir: string;
	report: string;
	manifest: string;
	lanes: Record<string, string>;
	bytes: number;
	pruned: string[];
	warnings: string[];
}

/** Filesystem-safe, collision-free filenames for lane ids like `a/b` or `t 1`. */
function laneFileNames(ids: string[]): Record<string, string> {
	const used = new Set<string>();
	const out: Record<string, string> = {};
	for (const id of ids) {
		let base = id
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 48);
		if (!base) base = "lane";
		let name = base;
		let n = 2;
		while (used.has(name)) name = `${base}-${n++}`;
		used.add(name);
		out[id] = name;
	}
	return out;
}

function ensureGitignore(root: string): void {
	const file = join(root, ".gitignore");
	try {
		if (existsSync(file)) return;
		mkdirSync(root, { recursive: true });
		writeFileSync(file, "*\n", "utf8");
	} catch {
		// A missing .gitignore only risks a noisy git status; never a run failure.
	}
}

/**
 * Write the full artifact set for a finished fleet. Never throws: a read-only
 * workspace must not turn a completed fleet into a failed tool call, so any
 * filesystem error becomes a warning on the result.
 */
export function writeFleetArtifacts(opts: WriteFleetArtifactsOptions): FleetArtifacts {
	const now = opts.now ?? Date.now();
	// Two fleets in the same second must not overwrite each other's reports, so a
	// name collision gets a fresh id rather than a silent merge.
	let fleetId = opts.fleetId;
	for (let attempt = 0; attempt < 5 && existsSync(join(opts.root, fleetId)); attempt++) {
		fleetId = newFleetId(now);
	}
	const meta: FleetMeta = {
		fleetId,
		cwd: opts.cwd,
		concurrency: opts.concurrency,
		aborted: opts.aborted,
		startedAt: opts.startedAt,
		finishedAt: now,
	};
	const dir = join(opts.root, fleetId);
	const reportPath = join(dir, REPORT_NAME);
	const manifestPath = join(dir, MANIFEST_NAME);
	const names = laneFileNames(opts.lanes.map((l) => l.id));
	const lanePaths: Record<string, string> = {};
	for (const [id, name] of Object.entries(names)) lanePaths[id] = join(dir, "lanes", `${name}.md`);

	const artifacts: FleetArtifacts = {
		fleetId,
		dir,
		report: reportPath,
		manifest: manifestPath,
		lanes: lanePaths,
		bytes: 0,
		pruned: [],
		warnings: [],
	};

	try {
		mkdirSync(join(dir, "lanes"), { recursive: true });
		if (opts.selfIgnore) ensureGitignore(opts.root);

		for (const lane of opts.lanes) {
			const body = formatLaneDoc(lane, meta, now);
			writeFileSync(lanePaths[lane.id]!, body, "utf8");
			artifacts.bytes += Buffer.byteLength(body);
		}

		const report = formatFleetReport(meta, opts.lanes, now);
		writeFileSync(reportPath, report, "utf8");
		artifacts.bytes += Buffer.byteLength(report);

		const manifest = `${JSON.stringify(buildManifest(meta, opts.lanes, lanePaths), null, 2)}\n`;
		writeFileSync(manifestPath, manifest, "utf8");
		artifacts.bytes += Buffer.byteLength(manifest);
	} catch (e) {
		artifacts.warnings.push(`could not write the fleet report to ${dir}: ${(e as Error).message}`);
		return artifacts;
	}

	artifacts.pruned = pruneReports({
		root: opts.root,
		keep: opts.keep,
		maxAgeDays: opts.maxAgeDays,
		protect: [dir],
		now,
	});
	return artifacts;
}

export interface WriteRunReportOptions {
	/** Directory that holds one subdirectory per run. */
	root: string;
	runId: string;
	preset: string;
	cwd: string;
	/** Keep at most N report directories under root (0 = no limit). */
	keep?: number;
	/** Drop report directories older than N days (0 = no limit). */
	maxAgeDays?: number;
	selfIgnore?: boolean;
	now?: number;
	lane: ArtifactLane;
}

export interface RunArtifacts {
	runId: string;
	dir: string;
	report: string;
	manifest: string;
	bytes: number;
	pruned: string[];
	warnings: string[];
}

/**
 * Write one run's report: `report.md` (frontmatter + task + response + evidence
 * + run log) and `manifest.json`. Never throws — a read-only workspace must not
 * turn a finished run into a failed tool call.
 */
export function writeRunReport(opts: WriteRunReportOptions): RunArtifacts {
	const now = opts.now ?? Date.now();
	let runId = opts.runId;
	for (let attempt = 0; attempt < 5 && existsSync(join(opts.root, runId)); attempt++) {
		runId = newReportId("run", now);
	}
	const meta: FleetMeta = {
		kind: "run",
		fleetId: runId,
		cwd: opts.cwd,
		concurrency: 1,
		aborted: false,
		startedAt: opts.lane.startedAt ?? now,
		finishedAt: now,
	};
	const dir = join(opts.root, runId);
	const reportPath = join(dir, REPORT_NAME);
	const manifestPath = join(dir, MANIFEST_NAME);
	const artifacts: RunArtifacts = {
		runId,
		dir,
		report: reportPath,
		manifest: manifestPath,
		bytes: 0,
		pruned: [],
		warnings: [],
	};

	try {
		mkdirSync(dir, { recursive: true });
		if (opts.selfIgnore) ensureGitignore(opts.root);

		const report = formatLaneDoc(opts.lane, meta, now);
		writeFileSync(reportPath, report, "utf8");
		artifacts.bytes += Buffer.byteLength(report);

		const manifest = {
			...buildManifest(meta, [opts.lane], {}),
			preset: opts.preset,
		};
		const body = `${JSON.stringify(manifest, null, 2)}\n`;
		writeFileSync(manifestPath, body, "utf8");
		artifacts.bytes += Buffer.byteLength(body);
	} catch (e) {
		artifacts.warnings.push(`could not write the run report to ${dir}: ${(e as Error).message}`);
		return artifacts;
	}

	artifacts.pruned = pruneReports({
		root: opts.root,
		keep: opts.keep,
		maxAgeDays: opts.maxAgeDays,
		protect: [dir],
		now,
	});
	return artifacts;
}

/** Single-file mode: the combined report plus a sibling manifest. */
export function writeFleetReportFile(
	file: string,
	meta: FleetMeta,
	lanes: ArtifactLane[],
	now = Date.now()
): { file: string; manifest: string; bytes: number; warnings: string[] } {
	const manifestPath = join(dirname(file), `${basename(file).replace(/\.md$/i, "")}.manifest.json`);
	const warnings: string[] = [];
	let bytes = 0;
	try {
		mkdirSync(dirname(file), { recursive: true });
		const report = formatFleetReport(meta, lanes, now);
		writeFileSync(file, report, "utf8");
		bytes += Buffer.byteLength(report);
		const manifest = `${JSON.stringify(buildManifest(meta, lanes, {}), null, 2)}\n`;
		writeFileSync(manifestPath, manifest, "utf8");
		bytes += Buffer.byteLength(manifest);
	} catch (e) {
		warnings.push(`could not write the fleet report to ${file}: ${(e as Error).message}`);
	}
	return { file, manifest: manifestPath, bytes, warnings };
}

// ---------------------------------------------------------------------------
// Listing / cleanup
// ---------------------------------------------------------------------------

export interface ReportListing {
	id: string;
	kind: ReportKind;
	dir: string;
	createdAt?: string;
	lanes: number;
	done: number;
	failed: number;
	aborted: number;
	bytes: number;
}

/** Creation time encoded in the directory name (`fleet-YYYYMMDD-HHMMSS-xxxx`). */
function fleetIdDate(id: string): number | undefined {
	const m = /^fleet-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
	if (!m) return undefined;
	const [, y, mo, d, h, mi, se] = m;
	const t = new Date(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h),
		Number(mi),
		Number(se)
	).getTime();
	return Number.isFinite(t) ? t : undefined;
}

function dirBytes(dir: string): number {
	let total = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		try {
			const st = lstatSync(path);
			total += st.isDirectory() ? dirBytes(path) : st.size;
		} catch {
			// Unreadable entry: skip it rather than failing the whole listing.
		}
	}
	return total;
}

/** A removable report directory: a real directory, a direct child, matching the naming scheme. */
function isReportDir(root: string, dir: string): boolean {
	if (dirname(resolve(dir)) !== resolve(root)) return false;
	if (!REPORT_DIR_RE.test(basename(resolve(dir)))) return false;
	try {
		const st = lstatSync(dir);
		return st.isDirectory() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Every report directory under `root`, newest first. */
export function listReports(root: string): ReportListing[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const out: ReportListing[] = [];
	for (const entry of entries) {
		const dir = join(root, entry);
		if (!isReportDir(root, dir)) continue;
		let manifest: Record<string, any> | undefined;
		try {
			manifest = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
		} catch {
			manifest = undefined;
		}
		const created = fleetIdDate(entry);
		out.push({
			id: entry,
			kind: entry.startsWith("run-") ? "run" : "fleet",
			dir,
			createdAt:
				typeof manifest?.createdAt === "string"
					? manifest.createdAt
					: created !== undefined
						? new Date(created).toISOString()
						: undefined,
			lanes: Number(manifest?.totals?.lanes ?? 0),
			done: Number(manifest?.totals?.done ?? 0),
			failed: Number(manifest?.totals?.failed ?? 0),
			aborted: Number(manifest?.totals?.aborted ?? 0),
			bytes: dirBytes(dir),
		});
	}
	return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Retention: keep the newest `keep` fleets and drop anything older than
 * `maxAgeDays`. Runs after every write so the report directory stays bounded
 * even if nobody ever cleans up.
 */
export function pruneReports(opts: {
	root: string;
	keep?: number;
	maxAgeDays?: number;
	protect?: readonly string[];
	now?: number;
}): string[] {
	const keep = opts.keep ?? 0;
	const maxAgeDays = opts.maxAgeDays ?? 0;
	if (keep <= 0 && maxAgeDays <= 0) return [];
	const now = opts.now ?? Date.now();
	const protectedDirs = new Set((opts.protect ?? []).map((p) => resolve(p)));
	const listings = listReports(opts.root);
	const removed: string[] = [];
	listings.forEach((listing, index) => {
		if (protectedDirs.has(resolve(listing.dir))) return;
		const beyondKeep = keep > 0 && index >= keep;
		// Age comes from the timestamp in the name, not mtime: writing or reading a
		// report should not make an old fleet look new.
		const created = fleetIdDate(listing.id);
		const tooOld = maxAgeDays > 0 && created !== undefined && now - created > maxAgeDays * 86_400_000;
		if (!beyondKeep && !tooOld) return;
		try {
			rmSync(listing.dir, { recursive: true, force: true });
			removed.push(listing.id);
		} catch {
			// A directory we cannot remove is not worth failing a finished fleet over.
		}
	});
	return removed;
}

export interface ClearReportsOptions {
	root: string;
	/** Remove exactly these fleets. */
	ids?: readonly string[];
	/** Keep the newest N fleets, remove the rest. */
	keep?: number;
	/** Remove fleets finished more than N days ago. */
	olderThanDays?: number;
	/** Remove every fleet under the root. */
	all?: boolean;
	dryRun?: boolean;
	protect?: readonly string[];
	now?: number;
}

export interface ClearReportsResult {
	removed: ReportListing[];
	kept: ReportListing[];
	bytes: number;
	dryRun: boolean;
}

/**
 * Explicit cleanup for the orchestrator: remove fleet reports it has already
 * consumed. Selection is required (ids / keep / olderThanDays / all) so nothing
 * is ever wiped by an accidental default, and only direct children matching the
 * fleet naming scheme are touched.
 */
export function clearReports(opts: ClearReportsOptions): ClearReportsResult {
	const now = opts.now ?? Date.now();
	const listings = listReports(opts.root);
	// Never delete the fleet just written by the current call.
	const protectedDirs = new Set((opts.protect ?? []).map((p) => resolve(p)));

	let selected: ReportListing[];
	if (opts.ids?.length) {
		const wanted = new Set(opts.ids);
		if (!wanted.size) throw new Error("agy_reports: `fleetId` must name at least one fleet");
		// Accept either the full id or the bare suffix (last 4 chars).
		selected = listings.filter((l) => wanted.has(l.id));
		if (!selected.length) {
			throw new Error(`agy_reports: no report matched ${[...wanted].join(", ")} under ${opts.root}`);
		}
	} else if (opts.all) {
		selected = listings;
	} else if (opts.keep !== undefined && opts.keep >= 0) {
		selected = listings.slice(opts.keep);
	} else if (opts.olderThanDays !== undefined && opts.olderThanDays > 0) {
		const cutoff = now - opts.olderThanDays * 86_400_000;
		selected = listings.filter((l) => {
			const created = fleetIdDate(l.id);
			return created !== undefined && created < cutoff;
		});
	} else {
		throw new Error(
			"agy_reports: pick what to clear — `all: true`, `fleetId`, `keep` (newest N kept), or `olderThan` (e.g. \"7d\")"
		);
	}

	const dryRun = opts.dryRun === true;
	const removed: ReportListing[] = [];
	const kept: ReportListing[] = [];
	let bytes = 0;
	for (const listing of selected) {
		if (protectedDirs.has(resolve(listing.dir))) {
			kept.push(listing);
			continue;
		}
		if (!isReportDir(opts.root, listing.dir)) {
			kept.push(listing);
			continue;
		}
		if (!dryRun) {
			try {
				rmSync(listing.dir, { recursive: true, force: true });
			} catch {
				kept.push(listing);
				continue;
			}
		}
		removed.push(listing);
		bytes += listing.bytes;
	}
	return { removed, kept, bytes, dryRun };
}

/** Path as the user sees it: relative when inside `cwd`, absolute otherwise. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** One listing with the directory root it came from. */
export type RootedListing = ReportListing & { root: string };

/** Every stored report across the given roots, newest first. */
export function listAllReports(roots: readonly string[]): RootedListing[] {
	const out: RootedListing[] = [];
	for (const root of roots) for (const listing of listReports(root)) out.push({ ...listing, root });
	// Newest first across kinds: `run-…` sorts above `fleet-…` by name alone.
	return out.sort((a, b) => {
		const at = a.createdAt ?? "";
		const bt = b.createdAt ?? "";
		if (at !== bt) return at < bt ? 1 : -1;
		return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});
}

export interface ClearAllReportsResult {
	removed: RootedListing[];
	kept: RootedListing[];
	bytes: number;
	dryRun: boolean;
}

/**
 * `clearReports` across several roots (fleet + run report directories). A root
 * with nothing to remove is not an error; only "no selector at all" is.
 */
export function clearAllReports(
	roots: readonly string[],
	opts: Omit<ClearReportsOptions, "root">
): ClearAllReportsResult {
	if (!opts.all && !opts.ids?.length && opts.keep === undefined && opts.olderThanDays === undefined) {
		throw new Error(
			"agy_reports: pick what to clear — `all: true`, `fleetId`, `keep` (newest N kept), or `olderThan` (e.g. \"7d\")"
		);
	}
	const removed: RootedListing[] = [];
	const kept: RootedListing[] = [];
	let bytes = 0;
	for (const root of roots) {
		try {
			const result = clearReports({ ...opts, root });
			removed.push(...result.removed.map((listing) => ({ ...listing, root })));
			kept.push(...result.kept.map((listing) => ({ ...listing, root })));
			bytes += result.bytes;
		} catch (e) {
			// "No report matched this id" is expected when the id lives in the
			// other root; anything else is a real failure.
			if (!opts.ids?.length || !/no report matched/.test((e as Error).message)) throw e;
		}
	}
	if (opts.ids?.length && !removed.length && !kept.length) {
		throw new Error(`agy_reports: no report matched ${opts.ids.join(", ")} under ${roots.join(", ")}`);
	}
	return { removed, kept, bytes, dryRun: opts.dryRun === true };
}

/** Human-readable byte count for status messages. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Parse a compact duration (`7d`, `36h`, `90m`) into days, for `olderThan`. */
export function parseAge(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const m = /^\s*(\d+(?:\.\d+)?)\s*([dhm])\s*$/i.exec(value);
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2]!.toLowerCase();
	if (unit === "d") return n;
	if (unit === "h") return n / 24;
	return n / 1440;
}
