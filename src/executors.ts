import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { config, clampConcurrency, MAX_FLEET_TASKS } from "./config.ts";
import { formatFleetBoard, summarizeFleet, type FleetLaneState } from "./fleet.ts";
import { resolveWorkspace } from "./paths.ts";
import { runAgy, type StreamResult } from "./runner.ts";
import { buildResult } from "./results.ts";
import { debounce, formatDuration, idleActivity, liveDetail, truncate, type LiveActivity } from "./status.ts";

/**
 * Tool executors: shared behavior for the single-run tools (agy, agy_code,
 * agy_explore) and the fan-out tool (agy_fleet).
 */

export interface AgyToolParams {
	prompt: string;
	workspace?: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands?: boolean;
	continueConv?: boolean;
	conversation?: string;
	jsonSchema?: string;
	timeout?: string;
}

/** Shared execute used by all three single-run tools. */
export async function executeAgy(
	_toolCallId: string,
	params: AgyToolParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext
): Promise<AgentToolResult<Record<string, unknown>>> {
	const workspace = params.workspace ? resolveWorkspace(params.workspace, ctx.cwd) : ctx.cwd;
	const model = params.model || config.model;
	const allowCommands = params.allowCommands ?? config.defaultAllowCommands;
	if (ctx.hasUI) ctx.ui.setStatus("agy", `agy ⟳ ${truncate(params.prompt, 50)}…`);
	try {
		const r = await runAgy({
			prompt: params.prompt,
			workspace,
			model,
			effort: params.effort,
			agent: params.agent,
			allowCommands,
			continueConv: params.continueConv ?? false,
			conversation: params.conversation,
			jsonSchema: params.jsonSchema,
			timeout: params.timeout || config.timeout,
			signal,
			onUpdate,
		});
		// Final one-shot status before the footer clears.
		if (ctx.hasUI)
			ctx.ui.setStatus("agy", `agy ✓ done in ${formatDuration(r.duration_seconds ? r.duration_seconds * 1000 : 0)}`);
		return buildResult(r, { workspace, model, allowCommands, steps: r.steps ?? [] });
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("agy", undefined);
	}
}

// ---------------------------------------------------------------------------
// Fleet (fan-out) executor
// ---------------------------------------------------------------------------

export interface FleetTaskParams {
	id?: string;
	task: string;
	workspace?: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	agent?: string;
	allowCommands?: boolean;
	continueConv?: boolean;
	jsonSchema?: string;
	timeout?: string;
}

export interface FleetCallParams extends FleetTaskParams {
	tasks: FleetTaskParams[];
	concurrency?: number;
}

export async function executeFleet(
	_toolCallId: string,
	params: FleetCallParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext
): Promise<AgentToolResult<Record<string, unknown>>> {
	const tasks = Array.isArray(params.tasks) ? params.tasks : [];
	if (tasks.length === 0) throw new Error("agy_fleet: provide at least one task in `tasks`");
	if (tasks.length > MAX_FLEET_TASKS)
		throw new Error(`agy_fleet: too many tasks (${tasks.length}); max is ${MAX_FLEET_TASKS}`);
	const concurrency = clampConcurrency(params.concurrency ?? config.fleetConcurrency);

	const lanes: FleetLaneState[] = tasks.map((t, i) => ({
		id: t.id?.trim() || `t${i + 1}`,
		task: t.task,
		workspace: t.workspace ? resolveWorkspace(t.workspace, ctx.cwd) : ctx.cwd,
		status: "queued",
		live: idleActivity(),
	}));

	const boardPush = debounce(() => {
		if (!onUpdate) return;
		const board = formatFleetBoard(lanes, Date.now());
		onUpdate({
			content: [{ type: "text", text: board.join("\n") }],
			details: {
				streaming: true,
				status: "running",
				lanes: lanes.map((l) => ({
					id: l.id,
					status: l.status,
					activity: liveDetail(l.live),
					error: l.error,
				})),
			},
		});
		if (ctx.hasUI) {
			const active = lanes.filter((l) => l.status === "running" || l.status === "queued").length;
			const done = lanes.filter((l) => l.status === "done").length;
			const bad = lanes.length - active - done;
			ctx.ui.setStatus(
				"agy",
				`agy_fleet ${done}/${lanes.length} done${bad ? ` · ${bad} failed` : ""}${active ? ` · ${active} active` : ""}`
			);
		}
	}, 250);

	const runLane = async (lane: FleetLaneState, t: FleetTaskParams) => {
		lane.status = "running";
		lane.startedAt = Date.now();
		boardPush.schedule();
		try {
			const r = await runAgy({
				prompt: lane.task,
				workspace: lane.workspace,
				model: t.model || params.model,
				effort: t.effort || params.effort,
				agent: t.agent || params.agent,
				allowCommands: t.allowCommands ?? params.allowCommands ?? config.defaultAllowCommands,
				continueConv: t.continueConv ?? false,
				jsonSchema: t.jsonSchema,
				timeout: t.timeout || params.timeout || config.timeout,
				signal,
				onActivity: (live: LiveActivity) => {
					lane.live = live;
					boardPush.schedule();
				},
			});
			lane.result = r;
			lane.status = "done";
		} catch (e) {
			lane.status = signal?.aborted ? "aborted" : "failed";
			lane.error = (e as Error).message;
		}
		lane.endedAt = Date.now();
		boardPush.flush();
	};

	const jobs = lanes.map((l, i) => ({ lane: l, task: tasks[i]! }));
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
		while (next < jobs.length) {
			if (signal?.aborted) break;
			const job = jobs[next++]!;
			await runLane(job.lane, job.task);
		}
	});
	await Promise.allSettled(workers);
	boardPush.cancel();
	if (signal?.aborted) throw new Error("agy_fleet aborted");

	const summary = summarizeFleet(lanes);
	return buildFleetResult(lanes, summary, concurrency);
}

function buildFleetResult(
	lanes: FleetLaneState[],
	summary: ReturnType<typeof summarizeFleet>,
	concurrency: number
): AgentToolResult<Record<string, unknown>> {
	const now = Date.now();
	const lines: string[] = [
		`**agy_fleet — ${summary.done}/${summary.total} lanes succeeded** ` +
			`(${summary.total} lanes · ${formatDuration(summary.elapsedMs)} · concurrency ${concurrency})`,
		"",
	];
	for (const lane of lanes) {
		const dur = formatDuration((lane.endedAt ?? now) - (lane.startedAt ?? now));
		if (lane.status === "done" && lane.result) {
			const bits = [
				`${lane.result.files_written?.length ?? 0} files`,
				`${lane.result.commands_run?.length ?? 0} commands`,
				dur,
			];
			lines.push(`- **[${lane.id}]** ✓ done · ${bits.join(" · ")}`);
			const resp = truncate((lane.result.response ?? "(no response)").trim(), 600);
			lines.push(`  ${resp.replace(/\s*\n+\s*/g, " ")}`);
		} else {
			const why =
				lane.status === "aborted"
					? "aborted"
					: lane.error
						? truncate(lane.error, 120)
						: "failed";
			lines.push(`- **[${lane.id}]** ✗ ${lane.status} · ${why} · ${dur}`);
			lines.push(`  task: ${truncate(lane.task.replace(/\s+/g, " "), 160)}`);
		}
	}
	const withEvidence = lanes.filter(
		(l) => l.status === "done" && l.result && (l.result.files_written?.length || l.result.commands_run?.length)
	);
	if (withEvidence.length) {
		lines.push("", "Evidence —");
		for (const lane of withEvidence) {
			const parts: string[] = [];
			if (lane.result?.files_written?.length) parts.push(`files: ${lane.result.files_written.join(", ")}`);
			if (lane.result?.commands_run?.length) parts.push(`commands: ${lane.result.commands_run.join(" | ")}`);
			lines.push(`  [${lane.id}] ${parts.join("   ")}`);
		}
	}
	lines.push(
		"",
		`(${summary.total} lanes · ok=${summary.done} failed=${summary.failed} aborted=${summary.aborted} · ${formatDuration(summary.elapsedMs)})`
	);

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			status: "done",
			lanes: lanes.map((l) => ({
				id: l.id,
				task: l.task,
				workspace: l.workspace,
				status: l.status,
				error: l.error,
				response: l.result?.response,
				files_written: l.result?.files_written,
				commands_run: l.result?.commands_run,
				conversation_id: l.result?.conversation_id,
				num_turns: l.result?.num_turns,
				duration_seconds: l.result?.duration_seconds,
				usage: l.result?.usage,
			})),
			succeeded: summary.done,
			failed: summary.failed,
			aborted: summary.aborted,
			total: lanes.length,
			concurrency,
			duration_seconds: +(summary.elapsedMs / 1000).toFixed(1),
		},
	};
}