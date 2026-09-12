import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { config, clampConcurrency, MAX_FLEET_TASKS, roles } from "./config.ts";
import { formatFleetBoard, summarizeFleet, type FleetLaneState } from "./fleet.ts";
import { resolveWorkspace } from "./paths.ts";
import type { AgyMeta, AgyPreset, SingleDetails } from "./render.ts";
import { agyFleetRegistry } from "./registry.ts";
import { applyRole, findRole, roleIds, type AgyRole } from "./roles.ts";
import { runAgy, type RunOptions, type StreamResult } from "./runner.ts";
import { buildResult } from "./results.ts";
import { debounce, formatDuration, idleActivity, liveDetail, truncate, type LiveActivity } from "./status.ts";

/**
 * Tool executors: shared behavior for the single-run tools (agy, agy_code,
 * agy_vision, agy_role) and the fan-out tool (agy_fleet).
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
	/** Extra workspace roots for agy (e.g. staged vision image copies). */
	addDirs?: readonly string[];
	/** Warnings to show with the result (e.g. images that could not be found). */
	extraWarnings?: readonly string[];
	/** Internal: which preset invocation this is (selects the TUI card). */
	preset?: AgyPreset;
	/** Specialist role id, when the run came from `agy_role` or a fleet lane. */
	role?: string;
}

/**
 * Run agy with the given model, falling back through `config.fallbackModels` on
 * a hard failure. A CLI model can be unavailable or rate-limited, and a
 * delegation that dies on model selection wastes the whole task.
 */
async function runWithFallback(
	runOpts: Omit<RunOptions, "model">,
	primary: string | undefined,
	signal: AbortSignal | undefined
): Promise<{ result: StreamResult; model?: string; attempts: string[] }> {
	const models = [primary, ...config.fallbackModels]
		.filter((m): m is string => typeof m === "string" && m.length > 0)
		.filter((m, index, all) => all.indexOf(m) === index);
	if (models.length === 0) models.push(""); // let agy use its own default

	const attempts: string[] = [];
	let lastError: unknown;
	for (const model of models) {
		attempts.push(model || "(agy default)");
		try {
			return { result: await runAgy({ ...runOpts, model: model || undefined }), model: model || undefined, attempts };
		} catch (error) {
			lastError = error;
			// Never retry past an abort: the caller wants the run to stop.
			if (signal?.aborted) throw error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Display labels for the FleetView / inspector roster. */
const PRESET_LABEL: Record<AgyPreset, string> = {
	run: "agy",
	code: "agy_code",
	vision: "agy_vision",
	role: "agy_role",
};

/** `agy_role · reviewer`, or the plain preset label. */
function runLabel(preset: AgyPreset, role: string | undefined): string {
	const base = PRESET_LABEL[preset] ?? preset;
	return role ? `${base} · ${role}` : base;
}

/** Shared execute used by all single-run tools (agy, agy_code, agy_vision, agy_role). */
export async function executeAgy(
	_toolCallId: string,
	params: AgyToolParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext
): Promise<AgentToolResult<Record<string, unknown>>> {
	const workspace = params.workspace ? resolveWorkspace(params.workspace, ctx.cwd) : ctx.cwd;
	const model = params.model || config.model;
	const effort = params.effort || config.effort;
	const allowCommands = params.allowCommands ?? config.defaultAllowCommands;
	const meta: AgyMeta = {
		preset: params.preset ?? "run",
		model,
		effort: effort || undefined,
		workspace,
		allowCommands,
		timeout: params.timeout || config.timeout,
		continueConv: params.continueConv ?? false,
		conversation: params.conversation,
		agent: params.agent || config.agent,
		role: params.role,
	};

	let footer = "";
	const pushFooter = debounce(() => {
		if (ctx.hasUI && footer) ctx.ui.setStatus("agy", footer);
	}, 200);
	if (ctx.hasUI) ctx.ui.setStatus("agy", `agy ⟳ ${truncate(params.prompt, 50)}…`);

	// Track this run in the session fleet registry so the FleetView widget and
	// the /agy-fleet inspector show it alongside every other live agy run.
	const preset = params.preset ?? "run";
	const runId = agyFleetRegistry.nextId(preset);
	const lastLive = idleActivity();
	agyFleetRegistry.start({
		id: runId,
		kind: "single",
		label: runLabel(preset, params.role),
		preset,
		task: params.prompt,
		workspace,
		model,
		status: "running",
	});
	const trackedUpdate =
		onUpdate === undefined
			? undefined
			: (update: Parameters<AgentToolUpdateCallback>[0]) => {
					const details = (update.details ?? {}) as SingleDetails;
					if (details.recent?.length) agyFleetRegistry.patch(runId, { recent: details.recent });
					onUpdate(update);
				};
	try {
		const { result: r, model: usedModel, attempts } = await runWithFallback(
			{
				prompt: params.prompt,
				workspace,
				effort: params.effort,
				agent: params.agent,
				allowCommands,
				addDirs: params.addDirs,
				continueConv: params.continueConv ?? false,
				conversation: params.conversation,
				jsonSchema: params.jsonSchema,
				timeout: params.timeout || config.timeout,
				signal,
				onUpdate: trackedUpdate,
				meta,
				onActivity: (live: LiveActivity) => {
					Object.assign(lastLive, live);
					agyFleetRegistry.patch(runId, { live, status: "running" });
					const target = live.command
						? `$ ${truncate(live.command, 40)}`
						: live.file
							? `✎ ${truncate(live.file, 40)}`
							: live.phase === "writing"
								? "writing"
								: "thinking";
					footer =
						`agy ⟳ step ${live.step} · ${target}` +
						(live.elapsedMs >= 1000 ? ` · ${formatDuration(live.elapsedMs)}` : "");
					pushFooter.schedule();
				},
			},
			model,
			signal
		);
		// Report the model that actually ran, not the one we asked for first.
		if (usedModel) {
			meta.model = usedModel;
			agyFleetRegistry.patch(runId, { model: usedModel });
		}
		const extraWarnings = [...(params.extraWarnings ?? [])];
		if (attempts.length > 1) extraWarnings.push(`model fallback: tried ${attempts.join(" → ")}.`);
		pushFooter.cancel();
		agyFleetRegistry.finish(runId, {
			status: "done",
			response: r.response,
			warnings: [...extraWarnings, ...(r.warnings ?? [])],
			filesWritten: r.files_written ?? [],
			commandsRun: r.commands_run ?? [],
			numTurns: r.num_turns,
			tokens: r.usage?.total_tokens,
			live: {
				...lastLive,
				stepsDone: r.tool_steps ?? lastLive.stepsDone,
				...(r.usage?.total_tokens !== undefined ? { tokens: r.usage.total_tokens } : {}),
				...(r.num_turns !== undefined ? { turns: r.num_turns } : {}),
			},
		});
		// Final one-shot status before the footer clears.
		if (ctx.hasUI)
			ctx.ui.setStatus("agy", `agy ✓ done in ${formatDuration(r.duration_seconds ? r.duration_seconds * 1000 : 0)}`);
		return buildResult(r, { workspace, model: usedModel ?? model, allowCommands, steps: r.steps ?? [], meta, extraWarnings });
	} catch (e) {
		agyFleetRegistry.finish(runId, {
			status: signal?.aborted ? "aborted" : "failed",
			error: (e as Error).message,
			live: lastLive,
		});
		throw e;
	} finally {
		pushFooter.cancel();
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
	/** Specialist role id (see src/roles.ts); its prompt shape and access policy apply. */
	role?: string;
}

export interface FleetCallParams extends FleetTaskParams {
	tasks: FleetTaskParams[];
	concurrency?: number;
}

export async function executeFleet(
	toolCallId: string,
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

	// Resolve every lane's role up front: an unknown role must fail the whole
	// call before any agent is spawned, not silently mid-fan-out.
	const laneRoles: (AgyRole | undefined)[] = tasks.map((t, i) => {
		if (!t.role) return undefined;
		const role = findRole(roles, t.role);
		if (!role) {
			throw new Error(
				`agy_fleet: unknown role "${t.role}" for lane ${t.id ?? `t${i + 1}`}; known roles: ${roleIds(roles)}`
			);
		}
		return role;
	});

	const lanes: FleetLaneState[] = tasks.map((t, i) => ({
		id: t.id?.trim() || `t${i + 1}`,
		task: t.task,
		workspace: t.workspace ? resolveWorkspace(t.workspace, ctx.cwd) : ctx.cwd,
		status: "queued",
		live: idleActivity(),
	}));

	// Register every lane up front so the FleetView shows the whole fan-out the
	// moment it starts, not just the lanes that have begun running.
	const laneRunIds = lanes.map((lane, i) =>
		agyFleetRegistry.start({
			id: agyFleetRegistry.nextId("lane"),
			kind: "lane",
			label: `agy_fleet · ${lane.id}${laneRoles[i] ? ` · ${laneRoles[i]!.id}` : ""}`,
			preset: "fleet",
			task: lane.task,
			workspace: lane.workspace,
			model: laneRoles[i]?.model ?? (tasks[i]?.model || params.model),
			laneId: lane.id,
			fleetId: toolCallId,
		}).id
	);
	const laneRunId = (lane: FleetLaneState) => laneRunIds[lanes.indexOf(lane)]!;

	const boardPush = debounce(() => {
		if (!onUpdate) return;
		const now = Date.now();
		const board = formatFleetBoard(lanes, now);
		const summary = summarizeFleet(lanes, now);
		onUpdate({
			content: [{ type: "text", text: board.join("\n") }],
			details: {
				streaming: true,
				status: "running",
				concurrency,
				elapsedMs: summary.elapsedMs,
				lanes: lanes.map((l) => ({
					id: l.id,
					task: l.task,
					workspace: l.workspace,
					status: l.status,
					activity: liveDetail(l.live),
					elapsedMs: (l.endedAt ?? now) - (l.startedAt ?? now),
					error: l.error,
					response: l.result?.response,
					files_written: l.result?.files_written,
					commands_run: l.result?.commands_run,
					num_turns: l.result?.num_turns,
					duration_seconds: l.result?.duration_seconds,
				})),
			},
		});
		if (ctx.hasUI) {
			const active = lanes.filter((l) => l.status === "running" || l.status === "queued").length;
			const done = lanes.filter((l) => l.status === "done").length;
			const bad = lanes.length - active - done;
			ctx.ui.setStatus(
				"agy",
				`agy_fleet ${done}/${lanes.length} done${bad ? ` · ${bad} failed` : ""}${active ? ` · ${active} active` : ""} · ${formatDuration(summary.elapsedMs)}`
			);
		}
	}, 250);

	const runLane = async (lane: FleetLaneState, t: FleetTaskParams, role: AgyRole | undefined) => {
		const rid = laneRunId(lane);
		lane.status = "running";
		lane.startedAt = Date.now();
		agyFleetRegistry.patch(rid, { status: "running", startedAt: lane.startedAt });
		boardPush.schedule();
		// A role supplies the prompt shape and the access policy; the caller keeps
		// the per-lane model/effort/timeout choices.
		const policy = role
			? applyRole(role, {
					prompt: t.task,
					allowCommands: t.allowCommands,
					model: t.model,
					effort: t.effort,
					jsonSchema: t.jsonSchema,
				})
			: undefined;
		try {
			const { result: r, model: usedModel, attempts } = await runWithFallback(
				{
					prompt: policy?.prompt ?? lane.task,
					workspace: lane.workspace,
					effort: policy?.effort ?? t.effort ?? params.effort,
					agent: t.agent || params.agent,
					allowCommands: policy
						? policy.allowCommands
						: (t.allowCommands ?? params.allowCommands ?? config.defaultAllowCommands),
					continueConv: t.continueConv ?? false,
					jsonSchema: policy?.jsonSchema ?? t.jsonSchema,
					timeout: t.timeout || params.timeout || config.timeout,
					signal,
					onActivity: (live: LiveActivity) => {
						lane.live = live;
						agyFleetRegistry.patch(rid, { live, status: "running" });
						boardPush.schedule();
					},
				},
				policy?.model ?? t.model ?? params.model,
				signal
			);
			if (usedModel) agyFleetRegistry.patch(rid, { model: usedModel });
			if (attempts.length > 1) r.warnings = [...(r.warnings ?? []), `model fallback: tried ${attempts.join(" → ")}.`];
			lane.result = r;
			lane.status = "done";
			agyFleetRegistry.finish(rid, {
				status: "done",
				response: r.response,
				warnings: r.warnings ?? [],
				filesWritten: r.files_written ?? [],
				commandsRun: r.commands_run ?? [],
				numTurns: r.num_turns,
				tokens: r.usage?.total_tokens,
				live: {
					...lane.live,
					stepsDone: r.tool_steps ?? lane.live.stepsDone,
					...(r.usage?.total_tokens !== undefined ? { tokens: r.usage.total_tokens } : {}),
					...(r.num_turns !== undefined ? { turns: r.num_turns } : {}),
				},
			});
		} catch (e) {
			lane.status = signal?.aborted ? "aborted" : "failed";
			lane.error = (e as Error).message;
			agyFleetRegistry.finish(rid, { status: lane.status, error: lane.error, live: lane.live });
		}
		lane.endedAt = Date.now();
		boardPush.flush();
	};

	const jobs = lanes.map((l, i) => ({ lane: l, task: tasks[i]!, role: laneRoles[i] }));
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
		while (next < jobs.length) {
			if (signal?.aborted) break;
			const job = jobs[next++]!;
			await runLane(job.lane, job.task, job.role);
		}
	});
	await Promise.allSettled(workers);
	// Lanes the scheduler never reached stay "queued" forever otherwise, which
	// would keep the FleetView alive with phantom work.
	for (const lane of lanes) {
		if (lane.status !== "queued") continue;
		lane.status = "aborted";
		lane.error ??= "not started (fleet ended)";
		lane.endedAt = Date.now();
		agyFleetRegistry.finish(laneRunId(lane), { status: "aborted", error: lane.error, live: lane.live });
	}
	boardPush.cancel();
	boardPush.flush();
	if (ctx.hasUI) ctx.ui.setStatus("agy", undefined);

	// An aborted fleet still returns its partial board + per-lane evidence: the
	// orchestrator needs everything the lanes produced before the stop, and
	// throwing here would discard work that already happened on disk.
	const summary = summarizeFleet(lanes);
	return buildFleetResult(lanes, summary, concurrency, { aborted: signal?.aborted === true });
}

/** Model-facing lane responses are capped generously, not silently dropped. */
const LANE_RESPONSE_MAX = 4000;

/** Indent a lane response, preserving line structure and marking truncation. */
function laneResponseLines(response: string | undefined): string[] {
	const text = (response ?? "").trim() || "(no response)";
	const out: string[] = [];
	let used = 0;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (used + line.length > LANE_RESPONSE_MAX) {
			out.push(`  … [truncated at ${LANE_RESPONSE_MAX} chars — full text is in the result details]`);
			break;
		}
		out.push(`  ${line}`);
		used += line.length + 1;
	}
	return out;
}

function buildFleetResult(
	lanes: FleetLaneState[],
	summary: ReturnType<typeof summarizeFleet>,
	concurrency: number,
	options: { aborted?: boolean } = {}
): AgentToolResult<Record<string, unknown>> {
	const now = Date.now();
	// A lane can report success while having done nothing (denied tool call), so
	// surface how many lanes needed a warning instead of implying all were clean.
	const warned = lanes.filter((lane) => (lane.result?.warnings?.length ?? 0) > 0).length;
	const lines: string[] = [
		`**agy_fleet — ${summary.done}/${summary.total} lanes succeeded${warned ? `, ${warned} with warnings` : ""}** ` +
			`(${summary.total} lanes · ${formatDuration(summary.elapsedMs)} · concurrency ${concurrency})`,
		"",
	];
	if (options.aborted) {
		lines.push("> ⚠ the fleet was stopped early; the lanes below hold everything they produced before the stop.", "");
	}
	for (const lane of lanes) {
		const dur = formatDuration((lane.endedAt ?? now) - (lane.startedAt ?? now));
		if (lane.status === "done" && lane.result) {
			const bits = [
				`${lane.result.files_written?.length ?? 0} files`,
				`${lane.result.commands_run?.length ?? 0} commands`,
				dur,
			];
			lines.push(`- **[${lane.id}]** ✓ done · ${bits.join(" · ")}`);
			lines.push(...laneResponseLines(lane.result.response));
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
		// Never drop a lane's warnings: a permission-denied lane can look
		// successful while having produced nothing.
		for (const warning of lane.result?.warnings ?? []) lines.push(`  ⚠ ${truncate(warning.replace(/\s+/g, " "), 300)}`);
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
				warnings: l.result?.warnings,
				elapsedMs: (l.endedAt ?? now) - (l.startedAt ?? now),
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
			elapsedMs: summary.elapsedMs,
			duration_seconds: +(summary.elapsedMs / 1000).toFixed(1),
		},
	};
}