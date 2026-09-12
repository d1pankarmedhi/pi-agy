/**
 * Terminal-facing settings — pick the agy model and reasoning effort from pi
 * (`/agy-model`, `/agy-effort`) instead of hand-editing `~/.pi/agy.json` or
 * exporting environment variables.
 *
 * Two layers, deliberately separate:
 *   - The *live* choice mutates the shared `config` object, so every later agy
 *     run in the session uses it immediately (see `applyModel`/`applyEffort`).
 *   - *Persistence* merges `model` + `effort` into the user config file so the
 *     choice survives a restart (`saveUserConfig`) — the only thing this
 *     extension ever writes, and only when the user runs one of the commands.
 *
 * The functions here are pure apart from `saveUserConfig`/`listModels`, which
 * take explicit paths/executors so they can be unit-tested without touching the
 * user's real config or spawning agy.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { effortFromModel, matchEffort, type AgyEffort } from "./model.ts";

/** The config fields the terminal commands own. */
export interface SettingsTarget {
	model: string;
	effort: AgyEffort;
}

/** The effective model + effort after a change. */
export interface AppliedSettings {
	model: string;
	effort: AgyEffort;
}

/** Environment variables that silently outrank a saved model/effort. */
export const MODEL_ENV_VARS = ["AGY_MODEL"] as const;
export const EFFORT_ENV_VARS = ["AGY_EFFORT"] as const;

export function envOverridesFor(kind: "model" | "effort", env: NodeJS.ProcessEnv = process.env): string[] {
	const names = kind === "model" ? MODEL_ENV_VARS : EFFORT_ENV_VARS;
	return names.filter((name) => (env[name] ?? "").trim() !== "");
}

export function envOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
	return [...envOverridesFor("model", env), ...envOverridesFor("effort", env)];
}

/**
 * Point the session at a model slug. A gemini slug encodes its own effort, so
 * the effort follows the slug (`gemini-3.8-flash-low` → effort `low`) rather
 * than being rewritten under the user's feet. Non-gemini slugs (claude,
 * gpt-oss) leave the effort as configured; agy ignores `--effort` for them.
 */
export function applyModel(target: SettingsTarget, slug: string): AppliedSettings {
	const next = slug.trim();
	const derived = effortFromModel(next);
	if (derived) target.effort = derived;
	target.model = matchEffort(next, target.effort);
	return { model: target.model, effort: target.effort };
}

/** Change the effort, keeping a gemini model slug consistent with it. */
export function applyEffort(target: SettingsTarget, effort: AgyEffort): AppliedSettings {
	target.effort = effort;
	target.model = matchEffort(target.model, effort);
	return { model: target.model, effort: target.effort };
}

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

export interface SettingsArgs {
	/** Explicit model slug / effort level, if one was given. */
	value?: string;
	/** `--session`: apply now but do not write the config file. */
	session: boolean;
	/** `--help` (or bare `help`). */
	help: boolean;
	/** Tokens after the value, which make the invocation ambiguous. */
	extra: string[];
}

/** Parse `/agy-model`-style arguments: `[value] [--session] [--help]`. */
export function parseSettingsArgs(input: string): SettingsArgs {
	const rest: string[] = [];
	let session = false;
	let help = false;
	for (const token of input.split(/\s+/).filter(Boolean)) {
		if (token === "--session" || token === "-s") session = true;
		else if (token === "--help" || token === "-h" || token === "help") help = true;
		else if (token === "--save") continue; // persisting is the default
		else rest.push(token);
	}
	return { value: rest[0], session, help, extra: rest.slice(1) };
}

// ---------------------------------------------------------------------------
// Model catalogue (`agy models`)
// ---------------------------------------------------------------------------

export interface ModelEntry {
	/** Slug passed to `agy --model`. */
	slug: string;
	/** Human label printed by `agy models`, falling back to the slug. */
	label: string;
}

/** `agy models` prints a banner and `slug<TAB>Label` rows (possibly coloured). */
export function parseModelCatalogue(stdout: string): ModelEntry[] {
	const entries: ModelEntry[] = [];
	const seen = new Set<string>();
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
		if (!line) continue;
		const [first, ...rest] = line.split("\t");
		const slug = first.trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) continue;
		if (seen.has(slug)) continue;
		seen.add(slug);
		entries.push({ slug, label: rest.join(" ").trim() || slug });
	}
	return entries;
}

export type ModelListExec = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export const MODEL_LIST_TIMEOUT_MS = 15_000;

const defaultModelListExec: ModelListExec = (command, args) =>
	new Promise((resolve) => {
		execFile(
			command,
			args,
			{ windowsHide: true, timeout: MODEL_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(err, stdout) => resolve({ code: err ? 1 : 0, stdout: stdout ?? "" })
		);
	});

/** Best-effort catalogue; an unreachable agy yields `[]` (callers fall back). */
export async function listModels(bin: string, exec: ModelListExec = defaultModelListExec): Promise<ModelEntry[]> {
	try {
		const { code, stdout } = await exec(bin, ["models"]);
		return code === 0 ? parseModelCatalogue(stdout) : [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Persistence (`~/.pi/agy.json`)
// ---------------------------------------------------------------------------

/** Read the user config as a plain object, preserving unknown keys. */
export function readUserConfig(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	const text = readFileSync(filePath, "utf8");
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`${filePath} is not valid JSON: ${(e as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * Merge `patch` into the user config and write it back atomically (temp file +
 * rename), so an interrupted write can never truncate the user's file.
 */
export function saveUserConfig(filePath: string, patch: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...readUserConfig(filePath), ...patch };
	// Write through an existing symlink instead of replacing it, so a dotfile
	// setup (`~/.pi/agy.json -> ~/dotfiles/...`) keeps its link.
	const target = existsSync(filePath) ? realpathSync(filePath) : filePath;
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	renameSync(tmp, target);
	return merged;
}

/** `{ model, effort }` — the pair is always saved together to stay consistent. */
export function settingsPatch(settings: AppliedSettings): Record<string, unknown> {
	return { model: settings.model, effort: settings.effort };
}
