/**
 * The manual a node receives when it joins: a common core that holds for any project, plus one part per role.
 * Markdown files under packages/core/manual; nothing project-specific lives here (that is the project's own file).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WATCH_INTERVAL, RESPONSIBILITIES, RESPONSIBILITY_DOING, ROLE_ID_RE } from "./events.js";

const DIR = fileURLToPath(new URL("../manual/", import.meta.url));

/** Roles the manual is written for. */
export function manualRoles(): string[] {
  return readdirSync(join(DIR, "roles")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}

/** The full manual for one role (common core, then the role part), or null for a role it is not written for. */
export function manual(role: string): string | null {
  const file = join(DIR, "roles", `${role}.md`);
  if (!/^[a-z][a-z0-9_-]*$/.test(role) || !existsSync(file)) return null;
  return `${common()}\n\n---\n\n${readFileSync(file, "utf8").trimEnd()}\n`;
}

/**
 * The part of the manual every role reads. t-108's rule again (t-145): a number the prose teaches is filled from the
 * constant that decides it, never retyped — a copy drifts from the thing it describes, and this one had drifted into
 * three different numbers in four places.
 */
function common(): string {
  return readFileSync(join(DIR, "common.md"), "utf8").trimEnd().replaceAll("{{watch_interval}}", WATCH_INTERVAL);
}

/** The tail of a role's manual: which responsibilities this project says the role holds (t-059). */
export function responsibilityAppendix(role: string, ids: string[]): string {
  const names = new Map(RESPONSIBILITIES.map((r) => [r.id, r.name]));
  const lines = ids.map((id) => `- **${id} ${names.get(id) ?? "（这个项目自定义的职责）"}**：${RESPONSIBILITY_DOING[id] ?? "这个项目自己定义了这项职责；问 pm 或 human 它是什么。"}`);
  return `\n---\n\n## 你在这个项目里持有的职责\n\n${lines.length ? lines.join("\n") : `这个项目没有为 ${role} 声明任何职责；问 pm 或 human 你该管什么。`}\n`;
}

/**
 * t-081: the manual for a role this project declared, whatever it is called. A role with a written part keeps it (the five
 * this repository ships with); any other declared name gets the common core plus its responsibilities, assembled from the ids.
 * `null` when nothing was declared for the name: an unknown role is still 404.
 */
export function manualFor(role: string, ids: string[] | undefined): string | null {
  const written = manual(role);
  if (written) return written;
  if (!ids) return null;
  return `${common()}\n\n---\n\n# 角色 · ${role}\n\n这个项目声明了 ${role} 这个角色。你要做的事，就是下面这些职责；说明书的其余部分对所有角色都一样。\n`;
}

/** The manual for an agent that has not joined yet: what this is, how to start a project, how to join. `base` fills the address. */
export function welcome(base: string): string {
  // t-108: the id form comes from the rule itself, never retyped into the prose — a copy drifts from what it describes
  return readFileSync(join(DIR, "welcome.md"), "utf8")
    .replaceAll("{{base}}", base.replace(/\/$/, ""))
    .replaceAll("{{role_id_form}}", ROLE_ID_RE.source);
}

/** The invite page: what an agent with the link does to join. Placeholders: base, code, project, name, expires. */
export function inviteManual(fill: { base: string; code: string; project: string; name: string; expires: string }): string {
  let text = readFileSync(join(DIR, "invite.md"), "utf8");
  for (const [k, v] of Object.entries(fill)) text = text.replaceAll(`{{${k}}}`, k === "base" ? v.replace(/\/$/, "") : v);
  return text;
}
