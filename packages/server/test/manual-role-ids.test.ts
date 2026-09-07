/**
 * t-108 (S8). qa 00:14 built a team called 主编/写手/审稿 and lost it — it was following our own example, which used
 * 「审稿」 as an id. Two guards, in the shape of t-090: the drift check pulls the ids out of the manual's own prose and
 * holds each one to the rule; the regression follows the manual literally and expects it to work.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { MemoryStore, ROLE_ID_RE } from "@ateam/core";
import { createApp } from "../src/app.js";

const MANUAL = new URL("../../core/manual/", import.meta.url);
const files = () => [
  ...readdirSync(MANUAL).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(new URL(f, MANUAL), "utf8")] as const),
  ...readdirSync(new URL("roles/", MANUAL)).map((f) => [`roles/${f}`, readFileSync(new URL(`roles/${f}`, MANUAL), "utf8")] as const),
];

/**
 * Every string the manual uses as a role id: the keys of any `project:roles` value it writes out, in either the
 * `ateam reading roles '<json>'` form or the raw event form. Pulled from the text, never listed by hand.
 */
function idsInManual(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"key"\s*:\s*"roles"\s*,\s*"value"\s*:\s*(\{)/g)) out.push(...keysOf(text, m.index + m[0].length - 1));
  for (const m of text.matchAll(/reading roles '(\{)/g)) out.push(...keysOf(text, m.index + m[0].length - 1));
  return out;
}
/** The keys of the JSON object starting at `at`, read by brace-matching so a nested value does not confuse it. */
function keysOf(text: string, at: number): string[] {
  let depth = 0, end = at;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  try { return Object.keys(JSON.parse(text.slice(at, end)) as object); } catch { return []; }
}

describe("t-108 · the manual's own role ids obey the manual's own rule", () => {
  it("every id the manual writes out is a legal id, and the examples are not empty", () => {
    let seen = 0;
    for (const [name, text] of files()) {
      for (const id of idsInManual(text)) {
        seen++;
        expect(ROLE_ID_RE.test(id), `${name}: 例子里把 ${JSON.stringify(id)} 当角色 id 用，它不符合 ${ROLE_ID_RE.source}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(4);   // 抽取真的抽到了东西，不是一个永远为空的检查
  });

  it("the extractor would catch a bad example: it is not a check that can never fail", () => {
    const fake = `-d '{"kind":"reading","surface":"project","key":"roles","value":{"主编":["R1"],"reviewer":["R6"]},"method":"x"}'`;
    expect(idsInManual(fake)).toEqual(["主编", "reviewer"]);
    expect(idsInManual(fake).every((x) => ROLE_ID_RE.test(x))).toBe(false);
  });

  it("the manual says the id form by quoting the rule, so the prose cannot drift from it", () => {
    const welcome = readFileSync(new URL("welcome.md", MANUAL), "utf8");
    expect(welcome).toContain("{{role_id_form}}");            // 正文里没有手抄一份形状
    expect(welcome).not.toMatch(/\^\[a-z\]/);
  });
});

describe("t-108 · following the manual literally still works", () => {
  const TOKEN = "secret-token";
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>;
  let base = "";
  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234" });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("every roles declaration printed in the manual is accepted, and the id form it prints is the rule's own", async () => {
    const welcome = await (await fetch(`${base}/`, { headers: { accept: "application/json" } })).text();
    expect(welcome).toContain(ROLE_ID_RE.source);            // 服务下发的那份里，形状是真的从规则来的
    let tried = 0;
    for (const [, text] of files()) {
      for (const m of text.matchAll(/"key"\s*:\s*"roles"\s*,\s*"value"\s*:\s*(\{)/g)) {
        const value = JSON.parse(text.slice(m.index + m[0].length - 1, endOf(text, m.index + m[0].length - 1)));
        const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ kind: "reading", surface: "project", key: "roles", value }) });
        expect(r.status, JSON.stringify(value)).toBe(201);    // 判据 3：照说明书逐字操作，不再被 t-106 拒绝
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(1);                        // 写作项目那份中文显示名的例子也在内
  });
  function endOf(text: string, at: number): number {
    let depth = 0;
    for (let i = at; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) return i + 1; }
    return at;
  }
});
