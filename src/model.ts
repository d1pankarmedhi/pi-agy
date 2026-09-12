/** Reasoning effort levels agy accepts. Only gemini-* models take `--effort`. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;

export type AgyEffort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: unknown): value is AgyEffort {
	return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** A gemini slug that ends in an effort suffix, e.g. `gemini-3.8-flash-low`. */
const GEMINI_EFFORT_SLUG = /^(gemini-.+)-(low|medium|high)$/;

/**
 * Keep the gemini model slug consistent with the requested effort. agy rejects
 * combinations like `--model gemini-3.8-flash-medium --effort high`, so a
 * gemini slug ending in -low/-medium/-high is rewritten to match `effort`.
 * Non-gemini models (claude, gpt-oss, ...) are returned unchanged; they do not
 * accept a --effort flag.
 */
export function matchEffort(model: string, effort: string | undefined): string {
	if (!effort) return model;
	const m = GEMINI_EFFORT_SLUG.exec(model);
	return m ? `${m[1]}-${effort}` : model;
}

/**
 * The effort a gemini slug encodes (`gemini-3.8-flash-low` → `low`). Used when
 * the user picks a model by slug so the effort follows the slug instead of
 * silently rewriting it.
 */
export function effortFromModel(model: string): AgyEffort | undefined {
	const m = GEMINI_EFFORT_SLUG.exec(model);
	return m ? (m[2] as AgyEffort) : undefined;
}

export function isGemini(model: string): boolean {
	return /^gemini-/.test(model);
}