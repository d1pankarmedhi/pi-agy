/**
 * Session-wide agy run registry.
 *
 * pi-subagents keeps a single `SubagentState` that every foreground and
 * background child reports into, which is what lets its FleetView and fleet
 * inspector show *all* live work in one place. pi-agy previously had no such
 * state: an `agy_fleet` call owned its lanes in a local array that vanished
 * when the tool returned, and single runs were invisible outside their own
 * card.
 *
 * `FleetRegistry` is the pi-agy equivalent. Every agy run (a single
 * `agy`/`agy_code`/`agy_vision`/`agy_role` call, and every lane of an
 * `agy_fleet` fan-out) is registered here with its live activity, metrics, and
 * terminal evidence. The persistent FleetView widget and the `/agy-fleet`
 * inspector both read from one registry instance, so the fleet surface always
 * reflects the real state of the session.
 *
 * Registry instances are UI-agnostic: they only hold data and emit change
 * notifications. The rendering lives in `fleetview.ts` / `inspector.ts`, and
 * the module-level `agyFleetRegistry` singleton is what the executors write to.
 */

import { idleActivity, type LiveActivity, type StepRecord } from "./status.ts";
import type { AgyPreset } from "./render.ts";

/** A run's preset, plus the fan-out pseudo-preset used by `agy_fleet` lanes. */
export type AgyRunPreset = AgyPreset | "fleet";

/** Lifecycle of a tracked agy run. */
export type AgyRunStatus = "queued" | "running" | "done" | "failed" | "aborted";

/** One tracked agy run (single tool call or one `agy_fleet` lane). */
export interface AgyRunRecord {
	/** Unique id for this registry instance (from `nextId`). */
	id: string;
	/** `single` for a direct tool call, `lane` for an `agy_fleet` lane. */
	kind: "single" | "lane";
	/** Short human label, e.g. `agy_code` or `agy_fleet · t2`. */
	label: string;
	preset: AgyRunPreset;
	/** The task/prompt handed to the agent (may be long; renderers truncate). */
	task: string;
	workspace: string;
	model?: string;
	/** Lane id inside the parent fleet (`t1`, `t2`, …), for `kind === "lane"`. */
	laneId?: string;
	/** Parent `agy_fleet` id, for `kind === "lane"`. */
	fleetId?: string;
	status: AgyRunStatus;
	startedAt: number;
	endedAt?: number;
	live: LiveActivity;
	/** Most recent tool steps, newest last (bounded by the producer). */
	recent: StepRecord[];
	response?: string;
	error?: string;
	warnings: string[];
	filesWritten: string[];
	commandsRun: string[];
	numTurns?: number;
	tokens?: number;
}

/** Fields required to open a new tracked run; the rest get sensible defaults. */
export interface AgyRunInput {
	id: string;
	kind: "single" | "lane";
	label: string;
	preset: AgyRunPreset;
	task: string;
	workspace: string;
	model?: string;
	laneId?: string;
	fleetId?: string;
	status?: AgyRunStatus;
}

/** Terminal patch accepted by `finish`. */
export interface AgyRunFinish {
	status: Extract<AgyRunStatus, "done" | "failed" | "aborted">;
	response?: string;
	error?: string;
	warnings?: string[];
	filesWritten?: string[];
	commandsRun?: string[];
	numTurns?: number;
	tokens?: number;
	endedAt?: number;
	live?: Partial<LiveActivity>;
}

/** True while a run is still expected to make progress. */
export function isActiveStatus(status: AgyRunStatus): boolean {
	return status === "queued" || status === "running";
}

/** Aggregate counters for the collapsed FleetView line. */
export interface FleetCounts {
	total: number;
	active: number;
	queued: number;
	running: number;
	done: number;
	failed: number;
	aborted: number;
	tokens: number;
	/** Newest-first list of active runs, then recently finished runs. */
	entries: AgyRunRecord[];
}

function cloneLive(live: LiveActivity): LiveActivity {
	return { ...live, filesTouched: [...live.filesTouched] };
}

/** Defensive copy so a caller mutating its array cannot corrupt stored state. */
function copyValue<K extends keyof AgyRunRecord>(key: K, value: AgyRunRecord[K]): AgyRunRecord[K] {
	if (key === "live") return cloneLive(value as LiveActivity) as AgyRunRecord[K];
	if (Array.isArray(value)) return [...value] as AgyRunRecord[K];
	return value;
}

/** Drop the oldest finished entries so a long session cannot grow unbounded. */
const MAX_FINISHED = 25;
const NOTIFY_DEBOUNCE_MS = 120;

export class FleetRegistry {
	private entries = new Map<string, AgyRunRecord>();
	private listeners = new Set<() => void>();
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private counter = 0;
	private disposed = false;

	/** Monotonic id generator; prefix makes ids readable in logs/tests. */
	nextId(prefix = "run"): string {
		return `${prefix}-${++this.counter}`;
	}

	/** Open a new tracked run and notify immediately (a new row must appear). */
	start(input: AgyRunInput): AgyRunRecord {
		const record: AgyRunRecord = {
			id: input.id,
			kind: input.kind,
			label: input.label,
			preset: input.preset,
			task: input.task,
			workspace: input.workspace,
			model: input.model,
			laneId: input.laneId,
			fleetId: input.fleetId,
			status: input.status ?? "queued",
			startedAt: Date.now(),
			live: idleActivity(),
			recent: [],
			warnings: [],
			filesWritten: [],
			commandsRun: [],
		};
		this.entries.set(record.id, record);
		this.emitNow();
		return record;
	}

	/** Merge live fields into an existing run; notifies on a short debounce. */
	patch(id: string, patch: Partial<AgyRunRecord>): void {
		const record = this.entries.get(id);
		if (!record) return;
		let changed = false;
		const target = record as unknown as Record<string, unknown>;
		for (const key of Object.keys(patch) as (keyof AgyRunRecord)[]) {
			const value = patch[key];
			if (value === undefined) continue;
			const next = copyValue(key, value as never);
			if (record[key] !== next) {
				target[key] = next;
				changed = true;
			}
		}
		if (changed) this.emitSoon();
	}

	/** Close a run with its terminal evidence and notify immediately. */
	finish(id: string, result: AgyRunFinish): void {
		const record = this.entries.get(id);
		if (!record) return;
		record.status = result.status;
		record.endedAt = result.endedAt ?? Date.now();
		if (result.response !== undefined) record.response = result.response;
		if (result.error !== undefined) record.error = result.error;
		if (result.warnings !== undefined) record.warnings = [...result.warnings];
		if (result.filesWritten !== undefined) record.filesWritten = [...result.filesWritten];
		if (result.commandsRun !== undefined) record.commandsRun = [...result.commandsRun];
		if (result.numTurns !== undefined) record.numTurns = result.numTurns;
		if (result.tokens !== undefined) record.tokens = result.tokens;
		record.live = result.live
			? cloneLive({ ...record.live, ...result.live, phase: "done" })
			: { ...cloneLive(record.live), phase: "done" };
		this.trimFinished();
		this.emitNow();
	}

	/** A live progress update from a run, e.g. its current activity. */
	activity(id: string, live: LiveActivity): void {
		this.patch(id, { live, status: "running" });
	}

	get(id: string): AgyRunRecord | undefined {
		return this.entries.get(id);
	}

	/** Active runs first (oldest first), then finished runs (newest first). */
	all(): AgyRunRecord[] {
		const active: AgyRunRecord[] = [];
		const finished: AgyRunRecord[] = [];
		for (const record of this.entries.values()) {
			(isActiveStatus(record.status) ? active : finished).push(record);
		}
		active.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
		finished.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || a.id.localeCompare(b.id));
		return [...active, ...finished];
	}

	/** Runs that still need the FleetView: queued + running. */
	active(): AgyRunRecord[] {
		return this.all().filter((record) => isActiveStatus(record.status));
	}

	counts(): FleetCounts {
		const entries = this.all();
		let active = 0;
		let queued = 0;
		let running = 0;
		let done = 0;
		let failed = 0;
		let aborted = 0;
		let tokens = 0;
		for (const entry of entries) {
			switch (entry.status) {
				case "queued":
					queued++;
					active++;
					break;
				case "running":
					running++;
					active++;
					break;
				case "done":
					done++;
					break;
				case "failed":
					failed++;
					break;
				case "aborted":
					aborted++;
					break;
			}
			if (entry.tokens) tokens += entry.tokens;
		}
		return { total: entries.length, active, queued, running, done, failed, aborted, tokens, entries };
	}

	/** Subscribe to change notifications. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Drop all tracked runs (used when a session starts fresh). */
	clear(): void {
		if (!this.entries.size) return;
		this.entries.clear();
		this.emitNow();
	}

	dispose(): void {
		this.disposed = true;
		if (this.notifyTimer) clearTimeout(this.notifyTimer);
		this.notifyTimer = undefined;
		this.listeners.clear();
		this.entries.clear();
	}

	private trimFinished(): void {
		const finished = [...this.entries.values()]
			.filter((record) => !isActiveStatus(record.status))
			.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		for (const record of finished.slice(MAX_FINISHED)) this.entries.delete(record.id);
	}

	/** Notify listeners without letting one subscriber break the others. */
	private notifyListeners(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				// A broken UI subscriber must never crash the host or starve the
				// remaining listeners; the registry itself is the source of truth.
				console.warn(`[pi-agy] fleet registry listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private emitSoon(): void {
		if (this.disposed || this.notifyTimer) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			if (this.disposed) return;
			this.notifyListeners();
		}, NOTIFY_DEBOUNCE_MS);
		this.notifyTimer.unref?.();
	}

	private emitNow(): void {
		if (this.disposed) return;
		if (this.notifyTimer) {
			clearTimeout(this.notifyTimer);
			this.notifyTimer = undefined;
		}
		this.notifyListeners();
	}
}

/**
 * The registry every agy tool writes to and every fleet surface reads from.
 * One extension runtime == one session-owned fleet.
 */
export const agyFleetRegistry = new FleetRegistry();
