/**
 * The manual a node receives when it joins: a common core that holds for any project, plus one part per role.
 * Markdown files under packages/core/manual; nothing project-specific lives here (that is the project's own file).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL("../manual/", import.meta.url));

/** Roles the manual is written for. */
export function manualRoles(): string[] {
  return readdirSync(join(DIR, "roles")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}

/** The full manual for one role (common core, then the role part), or null for a role it is not written for. */
export function manual(role: string): string | null {
  const file = join(DIR, "roles", `${role}.md`);
  if (!/^[a-z][a-z0-9_-]*$/.test(role) || !existsSync(file)) return null;
  return `${readFileSync(join(DIR, "common.md"), "utf8").trimEnd()}\n\n---\n\n${readFileSync(file, "utf8").trimEnd()}\n`;
}

/** The manual for an agent that has not joined yet: what this is, how to start a project, how to join. `base` fills the address. */
export function welcome(base: string): string {
  return readFileSync(join(DIR, "welcome.md"), "utf8").replaceAll("{{base}}", base.replace(/\/$/, ""));
}
