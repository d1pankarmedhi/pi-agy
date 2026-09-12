import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { effortFromModel, isEffort, matchEffort, type AgyEffort } from "./model.ts";
import { resolveRoles, type AgyRole, type AgyRoleOverride } from "./roles.ts";

/**
 * pi-agy configuration. Built-in defaults < user file (~/.pi/agy.json) <
 * environment variables < per-call tool parameters.
 */
export interface AgyConfig {
	bin: string;
	model: string;
	effort: "low" | "medium" | "high";
	agent?: string;
	timeout: string;
	defaultAllowCommands: boolean;
	fleetConcurrency: number;
	/** Models to retry with, in order, when a run fails outright. */
	fallbackModels: string[];
	/** User-defined or overriding specialist roles (see src/roles.ts). */
	roles: Record<string, AgyRoleOverride>;
	configFile: string;
}

const DEFAULT_CONFIG: Omit<AgyConfig, "configFile"> = {
	bin: "agy",
	model: "gemini-3.8-flash-high",
	effort: "high",
	timeout: "10m",
	defaultAllowCommands: true,
	fleetConcurrency: 3,
	fallbackModels: [],
	roles: {},
};

/** Hard cap for parallel agy lanes (also the clamp ceiling for the config). */
export const MAX_FLEET_CONCURRENCY = 8;
/** Hard cap for tasks per agy_fleet call. */
export const MAX_FLEET_TASKS = 24;

export function clampConcurrency(n: number, max = MAX_FLEET_CONCURRENCY): number {
	if (!Number.isFinite(n)) return DEFAULT_CONFIG.fleetConcurrency;
	return Math.min(max, Math.max(1, Math.floor(n)));
}

function userConfigPath(): string {
	const env = process.env.AGY_CONFIG;
	return env ? resolve(env) : join(homedir(), ".pi", "agy.json");
}

/** Per-field inputs for `resolveModelEffort` (separated so it is unit-testable). */
export interface ModelEffortInput {
	envModel?: string;
	envEffort?: string;
	fileModel?: string;
	fileEffort?: string;
	defaultModel: string;
	defaultEffort: AgyEffort;
}

export interface ModelEffortResolution {
	model: string;
	effort: AgyEffort;
}

/**
 * Resolve the model + effort across precedence levels.
 *
 * The two fields rank independently (env > user file > defaults), but they must
 * stay consistent: a gemini slug encodes its own effort. An *explicit* effort
 * wins only when it comes from the same or a higher level than the winning
 * model; otherwise the effort encoded in that slug wins. Without this,
 * `AGY_MODEL=gemini-3.8-flash-low` would be silently rewritten by the default
 * `effort=high`, and a file-level `effort` could override an env-level model.
 */
export function resolveModelEffort(input: ModelEffortInput): ModelEffortResolution {
	const envModel = input.envModel?.trim() || undefined;
	const fileModel = input.fileModel?.trim() || undefined;
	const envEffort = isEffort(input.envEffort) ? input.envEffort : undefined;
	const fileEffort = isEffort(input.fileEffort) ? input.fileEffort : undefined;

	const model = envModel ?? fileModel ?? input.defaultModel;
	const modelLevel = envModel ? 2 : fileModel ? 1 : 0;
	const explicit = envEffort ? { level: 2, value: envEffort } : fileEffort ? { level: 1, value: fileEffort } : undefined;
	const effort =
		explicit && explicit.level >= modelLevel
			? explicit.value
			: effortFromModel(model) ?? explicit?.value ?? input.defaultEffort;
	return { model: matchEffort(model, effort), effort };
}

function loadConfig(): AgyConfig {
	const filePath = userConfigPath();
	let file: Partial<AgyConfig> = {};
	try {
		if (existsSync(filePath)) file = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (e) {
		console.warn(`[pi-agy] could not read ${filePath}: ${(e as Error).message}`);
	}
	const envBool = (v: string | undefined, dflt: boolean) =>
		v === undefined ? dflt : v.toLowerCase() === "true" || v === "1";
	const envInt = (v: string | undefined, dflt: number) => {
		const n = parseInt(v ?? "", 10);
		return Number.isFinite(n) && n > 0 ? n : dflt;
	};
	const { model, effort } = resolveModelEffort({
		envModel: process.env.AGY_MODEL,
		envEffort: process.env.AGY_EFFORT,
		fileModel: file.model,
		fileEffort: file.effort,
		defaultModel: DEFAULT_CONFIG.model,
		defaultEffort: DEFAULT_CONFIG.effort,
	});
	return {
		bin: process.env.AGY_BIN || file.bin || DEFAULT_CONFIG.bin,
		model,
		effort,
		agent: process.env.AGY_AGENT || file.agent,
		timeout: process.env.AGY_TIMEOUT || file.timeout || DEFAULT_CONFIG.timeout,
		defaultAllowCommands: envBool(process.env.AGY_ALLOW_CMDS, file.defaultAllowCommands ?? DEFAULT_CONFIG.defaultAllowCommands),
		fleetConcurrency: clampConcurrency(
			envInt(process.env.AGY_FLEET_CONCURRENCY, file.fleetConcurrency ?? DEFAULT_CONFIG.fleetConcurrency)
		),
		fallbackModels: parseModelList(process.env.AGY_FALLBACK_MODELS) ?? file.fallbackModels ?? DEFAULT_CONFIG.fallbackModels,
		roles: file.roles ?? DEFAULT_CONFIG.roles,
		configFile: filePath,
	};
}

/** `a,b , c` → `[a, b, c]`; undefined for an empty/absent value. */
function parseModelList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const models = value
		.split(",")
		.map((m) => m.trim())
		.filter(Boolean);
	return models.length ? models : undefined;
}

export const config = loadConfig();

/** Specialist roles: built-ins merged with any `roles` from the user config. */
export const roles: readonly AgyRole[] = resolveRoles(config.roles);