/**
 * Vision preset helpers.
 *
 * pi-agy can only hand agy a *text* prompt (the agy CLI has no image flag), so
 * image work is delegated by path: the prompt lists the files to inspect and
 * instructs the agent to open them with its image-viewing tool before
 * answering. Local paths may point anywhere on disk — paths outside the
 * workspace are copied into a per-run temp directory that is registered with
 * agy via `--add-dir`, so the agent can read them without
 * `allowNonWorkspaceAccess`. When a `url` is supplied the prompt also asks the
 * agent to capture a headless-Chrome screenshot first and then inspect that
 * file.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocalPath } from "./paths.ts";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|svg)$/i;

/** http(s):, data:, … — handed to the agent verbatim instead of staged. */
const REMOTE_PATH = /^[a-z][a-z0-9+.\-]*:/i;
/** Windows drive letters (`C:\x`, `E:/x`) also match REMOTE_PATH — they are local. */
const DRIVE_PATH = /^[a-z]:[\\/]/i;

export const VISION_GUIDE =
	"IMAGE TASK — inspect the actual pixels before answering. " +
	"Open every image listed below with your image-viewing tool (view_file / read_resource). " +
	"Never infer content from the filename or the question: if you cannot open or see an image, " +
	"say so explicitly instead of guessing.";

/** Headless-Chrome hint; the agent is told to locate another Chromium if this path is wrong. */
export const CHROME_HINT = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/**
 * Read-only guard. Without it the agent sometimes attempts `run_command` to
 * locate/convert an image; in headless mode that call is auto-denied and the
 * run can finish with no output at all.
 */
export const NO_SHELL_GUIDE =
	"Shell commands are DENIED in this environment: never attempt run_command (or any shell tool) — " +
	"it will be auto-denied and the task will fail. Use only your built-in read-only tools " +
	"(view_file, list_dir, grep_search, read_resource) to locate and open the image(s).";

/** Trim, drop empty entries, and de-duplicate while preserving order. */
export function normalizeImages(images: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const raw of images ?? []) {
		if (typeof raw !== "string") continue;
		const p = raw.trim();
		if (p && !out.includes(p)) out.push(p);
	}
	return out;
}

/** True when the path looks like a raster/vector image the agent can view. */
export function isImagePath(path: string): boolean {
	return IMAGE_EXT.test(path.trim());
}

/** True when the entry is a URL/data URI rather than a local file path. */
export function isRemotePath(path: string): boolean {
	const p = path.trim();
	return REMOTE_PATH.test(p) && !DRIVE_PATH.test(p);
}

/** True when `file` is the workspace directory itself or lives inside it. */
function isInsideWorkspace(workspace: string, file: string): boolean {
	const within = (dir: string, target: string) => {
		const rel = relative(dir, target);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	if (within(workspace, file)) return true;
	// Windows paths are case-insensitive; mixed-case workspaces are common.
	return process.platform === "win32" && within(workspace.toLowerCase(), file.toLowerCase());
}

/** A local image path made reachable by the agent, or staged from outside the workspace. */
export interface StagedImages {
	/** Final paths to list in the prompt (absolute; staged copies for outside files). */
	images: string[];
	/** Extra directories to register with agy (`--add-dir`) — the staging dir, if used. */
	addDirs: string[];
	/** Requested paths that do not exist on disk (excluded from `images`). */
	missing: string[];
	/** Original → staged-copy pairs, so the result can report what was copied. */
	staged: Array<{ from: string; to: string }>;
	/** Remove the staging directory; a no-op when nothing was staged. */
	cleanup: () => void;
}

/**
 * Make local image paths readable by the agent. `resolveLocalPath` handles `~`,
 * Git-Bash forms, and relative paths; files already inside the workspace are
 * passed through, while files elsewhere are copied (deduplicated by name) into
 * a per-run temp directory that is registered via `--add-dir`, so the agent
 * never needs `allowNonWorkspaceAccess`. Missing paths are reported instead of
 * being silently ignored.
 */
export function stageLocalImages(
	images: readonly string[] | undefined,
	workspace: string,
	opts: { tmpRoot?: string } = {}
): StagedImages {
	const out: StagedImages = { images: [], addDirs: [], missing: [], staged: [], cleanup() {} };
	const used = new Set<string>();
	const seenAbs = new Set<string>();
	let stageDir: string | undefined;

	for (const raw of normalizeImages(images)) {
		// `file://` URLs point at local files — convert them to real paths.
		let entry = raw;
		if (/^file:/i.test(entry)) {
			try {
				entry = fileURLToPath(entry);
			} catch {
				out.missing.push(`${raw} (invalid file:// URL)`);
				continue;
			}
		} else if (isRemotePath(entry)) {
			out.images.push(entry);
			continue;
		}
		const abs = resolveLocalPath(entry, workspace);
		// The same file can be passed twice in different forms (C:/x, C:\x, ~/x).
		const key = process.platform === "win32" ? abs.toLowerCase() : abs;
		if (seenAbs.has(key)) continue;
		seenAbs.add(key);
		let isFile = false;
		let exists = false;
		try {
			exists = existsSync(abs);
			isFile = exists && statSync(abs).isFile();
		} catch {
			exists = false;
		}
		if (!exists) {
			out.missing.push(raw);
			continue;
		}		// Inside the workspace (or not a regular file) the agent can read it as-is.
		if (!isFile || isInsideWorkspace(workspace, abs)) {
			out.images.push(abs);
			continue;
		}

		stageDir ??= mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "pi-agy-vision-"));
		const ext = extname(abs);
		const stem = basename(abs, ext) || "image";
		let name = basename(abs);
		for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
		used.add(name.toLowerCase());
		const to = join(stageDir, name);
		try {
			copyFileSync(abs, to);
		} catch (e) {
			out.missing.push(`${raw} (${(e as Error).message})`);
			continue;
		}
		out.images.push(to);
		out.staged.push({ from: abs, to });
	}

	if (stageDir) {
		out.addDirs.push(stageDir);
		const dir = stageDir;
		out.cleanup = () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort — the OS cleans temp dirs anyway */
			}
		};
	}
	return out;
}

/**
 * Vision runs read-only unless the caller asked for shell access, or a `url`
 * was supplied (the screenshot step needs commands to drive headless Chrome).
 */
export function resolveVisionAllowCommands(
	explicit: boolean | undefined,
	url: string | undefined
): boolean {
	return explicit ?? Boolean(url?.trim());
}

export interface VisionPromptInput {
	/** The question to answer about the image(s). */
	prompt: string;
	/** Image files to inspect (workspace-relative or absolute). */
	images?: readonly string[];
	/** Optional page URL to screenshot before inspecting. */
	url?: string;
	/** When false, prepend the read-only guard (shell calls would be denied). */
	allowCommands?: boolean;
}

/**
 * Assemble a self-contained vision task: viewing instruction, the image list,
 * an optional screenshot step, the question, and an evidence request so the
 * orchestrator can verify which files the agent actually looked at.
 */
export function buildVisionPrompt(input: VisionPromptInput): string {
	const images = normalizeImages(input.images);
	const sections: string[] = [VISION_GUIDE];
	if (input.allowCommands === false) sections.push(NO_SHELL_GUIDE);

	if (images.length) {
		sections.push(
			"Images to inspect — open each one, then answer from what you actually see:\n" +
				images.map((p) => `- ${p}`).join("\n")
		);
	}

	const url = input.url?.trim();
	if (url) {
		sections.push(
			"First capture a screenshot of this page, then inspect the captured file:\n" +
				`- ${url}\n` +
				`Use headless Chrome/Edge, for example: "${CHROME_HINT}" --headless=new --hide-scrollbars ` +
				`--window-size=1280,800 --screenshot=<file>.png "<url>". ` +
				"If Chrome is not at that path, locate a Chromium browser (Chrome/Edge) and use it. " +
				"Save the screenshot inside the workspace, keep the exact command you ran, and inspect " +
				"the captured file (not the live page)."
		);
	}

	sections.push(`Task: ${input.prompt.trim()}`);

	if (images.length || url) {
		sections.push(
			"In your final answer, list the image file(s) you inspected and the screenshot command you " +
				"used (if any), so the result can be verified against them."
		);
	}

	return sections.join("\n\n");
}
