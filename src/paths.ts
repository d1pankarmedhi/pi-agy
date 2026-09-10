import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

let cygpathWorks: boolean | null = null;

function toWindowsPath(p: string): string {
	if (cygpathWorks === false) return resolve(p);
	try {
		const out = execFileSync("cygpath", ["-w", p], { encoding: "utf8" }).trim();
		if (out) {
			cygpathWorks = true;
			return out;
		}
	} catch {
		cygpathWorks = false;
	}
	return resolve(p);
}

/**
 * Normalize one local path: expands `~`, converts Git-Bash forms (`/tmp/foo`,
 * `/e/dev/x` on Windows), and resolves relative paths against `base`.
 */
export function resolveLocalPath(raw: string, base: string): string {
	let p = raw.trim();
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
		// Strip the separator too: resolve(home, "/pics") would jump to the drive root.
		p = resolve(homedir(), p.slice(1).replace(/^[\\/]+/, ""));
	}
	if (process.platform === "win32" && /^\/[^/]/.test(p) && !/^[A-Za-z]:/.test(p)) {
		return toWindowsPath(p);
	}
	return resolve(base, p);
}

/** Normalize workspace paths (Git Bash forms like /tmp/foo or ~/dev on Windows). */
export function resolveWorkspace(raw: string, cwd: string): string {
	if (raw.trim() === ".") return cwd;
	return resolveLocalPath(raw, cwd);
}