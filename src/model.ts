/**
 * Keep the gemini model slug consistent with the requested effort. agy rejects
 * combinations like `--model gemini-3.8-flash-medium --effort high`, so a
 * gemini slug ending in -low/-medium/-high is rewritten to match `effort`.
 * Non-gemini models (claude, gpt-oss, ...) are returned unchanged; they do not
 * accept a --effort flag.
 */
export function matchEffort(model: string, effort: string | undefined): string {
	if (!effort) return model;
	const m = /^(gemini-[^-]+-[^-]+)-(low|medium|high)$/.exec(model);
	return m ? `${m[1]}-${effort}` : model;
}

export function isGemini(model: string): boolean {
	return /^gemini-/.test(model);
}