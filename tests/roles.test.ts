import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_ROLES, applyRole, findRole, resolveRoles, roleIds } from "../src/roles.ts";

test("resolveRoles returns the built-in specialists", () => {
	const roles = resolveRoles(undefined);
	const ids = roles.map((r) => r.id);
	for (const expected of ["scout", "implementer", "reviewer", "verifier", "oracle"]) {
		assert.ok(ids.includes(expected), `missing built-in role ${expected}`);
	}
	assert.ok(roles.every((r) => r.builtin), "built-ins are flagged");
	assert.ok(roles.every((r) => r.guidance.trim().length > 0), "every built-in has prompt guidance");
});

test("built-in read-only roles cannot write, the implementer can", () => {
	const roles = resolveRoles(undefined);
	const scout = findRole(roles, "scout")!;
	const reviewer = findRole(roles, "reviewer")!;
	const implementer = findRole(roles, "implementer")!;
	assert.equal(scout.readOnly, true);
	assert.equal(scout.allowCommands, false);
	assert.equal(reviewer.readOnly, true);
	assert.equal(implementer.readOnly, false);
	assert.equal(implementer.allowCommands, true);
});

test("a user override merges over the built-in instead of replacing it", () => {
	const roles = resolveRoles({ reviewer: { effort: "low" } });
	const reviewer = findRole(roles, "reviewer")!;
	assert.equal(reviewer.effort, "low", "override wins");
	assert.ok(reviewer.guidance.length > 100, "built-in prompt is preserved");
	assert.equal(reviewer.readOnly, true, "built-in policy is preserved");
	assert.equal(reviewer.builtin, true);
});

test("a custom role is read-only unless it explicitly asks for write access", () => {
	const [safe, writer] = resolveRoles({
		"my-audit": { guidance: "audit things" },
		"my-fixer": { guidance: "fix things", allowCommands: true },
	}).filter((r) => r.id.startsWith("my-"));
	assert.equal(safe!.readOnly, true);
	assert.equal(safe!.allowCommands, false);
	assert.equal(safe!.builtin, false);
	assert.equal(writer!.readOnly, false);
	assert.equal(writer!.allowCommands, true);
});

test("a read-only role cannot be widened by a caller", () => {
	const roles = resolveRoles(undefined);
	const reviewer = findRole(roles, "reviewer")!;
	const resolved = applyRole(reviewer, { prompt: "review this", allowCommands: true });
	assert.equal(resolved.allowCommands, false, "caller cannot grant write access to a read-only role");
});

test("readOnly wins even if a custom role sets allowCommands true and readOnly true", () => {
	const role = resolveRoles({ "confused": { guidance: "x", allowCommands: true, readOnly: true } }).find((r) => r.id === "confused")!;
	assert.equal(role.allowCommands, false);
	assert.equal(applyRole(role, { prompt: "t", allowCommands: true }).allowCommands, false);
});

test("applyRole shapes the prompt and fills defaults, letting the caller override model/effort", () => {
	const reviewer = findRole(resolveRoles(undefined), "reviewer")!;
	const resolved = applyRole(reviewer, { prompt: "check src/a.ts", model: "gemini-3.8-pro-high", effort: "low" });
	assert.ok(resolved.prompt.startsWith(reviewer.guidance), "role guidance leads the prompt");
	assert.ok(resolved.prompt.endsWith("Task:\ncheck src/a.ts"), "the caller's task is last and clearly delimited");
	assert.equal(resolved.model, "gemini-3.8-pro-high", "caller model wins");
	assert.equal(resolved.effort, "low", "caller effort wins");

	const defaults = applyRole(reviewer, { prompt: "x" });
	assert.equal(defaults.model, undefined, "no built-in model pin, so the global default applies");
	assert.equal(defaults.effort, "high", "role effort default applies");
});

test("findRole is case-insensitive and tolerant of whitespace; roleIds lists choices", () => {
	const roles = resolveRoles(undefined);
	assert.equal(findRole(roles, "  SCOUT ")?.id, "scout");
	assert.equal(findRole(roles, "nope"), undefined);
	assert.equal(findRole(roles, undefined), undefined);
	assert.match(roleIds(roles), /scout/);
});

test("every built-in role has a unique id and a description", () => {
	const ids = BUILTIN_ROLES.map((r) => r.id);
	assert.equal(new Set(ids).size, ids.length, "ids must be unique");
	assert.ok(BUILTIN_ROLES.every((r) => r.description.trim().length > 0));
});
