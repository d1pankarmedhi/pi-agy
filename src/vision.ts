/**
 * Vision preset helpers.
 *
 * pi-agy can only hand agy a *text* prompt (the agy CLI has no image flag), so
 * image work is delegated by path: the prompt lists the files to inspect and
 * instructs the agent to open them with its image-viewing tool before
 * answering. When a `url` is supplied the prompt also asks the agent to capture
 * a headless-Chrome screenshot first and then inspect that file.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|svg)$/i;

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
