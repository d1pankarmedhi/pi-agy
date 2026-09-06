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

/** Normalize workspace paths (Git Bash forms like /tmp/foo or ~/dev on Windows). */
export function resolveWorkspace(raw: string, cwd: string): string {
	let p = raw.trim();
	if (p === ".") return cwd;
	if (p.startsWith("~")) p = resolve(homedir(), p.slice(1));
	if (process.platform === "win32" && /^\/[^/]/.test(p) && !/^[A-Za-z]:/.test(p)) {
		return toWindowsPath(p);
	}
	return resolve(cwd, p);
}