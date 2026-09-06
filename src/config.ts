import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
	configFile: string;
}

const DEFAULT_CONFIG: Omit<AgyConfig, "configFile"> = {
	bin: "agy",
	model: "gemini-3.8-flash-high",
	effort: "high",
	timeout: "10m",
	defaultAllowCommands: true,
	fleetConcurrency: 3,
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
	return {
		bin: process.env.AGY_BIN || file.bin || DEFAULT_CONFIG.bin,
		model: process.env.AGY_MODEL || file.model || DEFAULT_CONFIG.model,
		effort: ((process.env.AGY_EFFORT || file.effort || DEFAULT_CONFIG.effort) as AgyConfig["effort"]),
		agent: process.env.AGY_AGENT || file.agent,
		timeout: process.env.AGY_TIMEOUT || file.timeout || DEFAULT_CONFIG.timeout,
		defaultAllowCommands: envBool(process.env.AGY_ALLOW_CMDS, file.defaultAllowCommands ?? DEFAULT_CONFIG.defaultAllowCommands),
		fleetConcurrency: clampConcurrency(
			envInt(process.env.AGY_FLEET_CONCURRENCY, file.fleetConcurrency ?? DEFAULT_CONFIG.fleetConcurrency)
		),
		configFile: filePath,
	};
}

export const config = loadConfig();