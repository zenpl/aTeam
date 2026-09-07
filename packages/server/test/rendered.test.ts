/**
 * t-136: a sentence core computes for a person, that no renderer reads, is worse than no sentence at all — it looks
 * finished on every board and in every piece of evidence, and the person never sees a word of it. It happened twice in
 * one night, both times mine: t-119 (the four call-out states, computed honestly, while the page derived its own line
 * from a string) and t-129 (the batch line, computed with the right answer, while nothing printed it). qa found both.
 *
 * A rule beats remembering, so this is the same instrument t-118 and t-112 ended up with: read the source and refuse.
 *
 * **What it checks and what it does not.** It asks only whether a renderer reads the field a sentence arrives on. It
 * says nothing about where the sentence is printed, in what order, or in what words — those are pd's and the page's,
 * and this must never grow into a second judge of them (pm, criterion 3).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryStore, append, reduce, board, sampleLog, type Board, type NewEvent } from "@ateam/core";
import { createApp as _createApp } from "../src/app.js";

const HUMAN = "human";
/** Anything with Chinese in it and long enough to be a sentence rather than a label or an id. */
const SENTENCE_CHARS = 12;
const CJK = /[一-鿿]/;
const RENDERERS = {
  "server/src/html.ts": new URL("../src/html.ts", import.meta.url),
  "cli/src/format.ts": new URL("../../cli/src/format.ts", import.meta.url),
};

export interface Unread { path: string; field: string; text: string }

/**
 * Every human sentence on `b` whose top-level field no renderer mentions. Field-level on purpose: "does anyone read
 * this" is the whole question, and a finer check would start ruling on how it is printed.
 */
function unread(b: Board, sources: string[]): Unread[] {
  const out: Unread[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (!CJK.test(v) || [...v].length < SENTENCE_CHARS) return;
      const field = path.split(/[.[]/)[0];
      if (sources.some((s) => s.includes(field)) || seen.has(field)) return;
      seen.add(field);
      out.push({ path, field, text: v });
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
  };
  walk(b, "");
  return out;
}

/** A board with every sentence-bearing corner lit: the states only appear when the log puts them there. */
async function loudBoard(): Promise<Board> {
  const log = await sampleLog();
  const s = new MemoryStore();
  for (const e of log.events) await s.appendRaw(e);
  for (const c of log.cursors) await s.setCursor(c);
  for (const d of log.deliveries) await s.recordDelivery(d);
  const now = new Date();
  const put = (e: NewEvent) => append(s, e, { human: HUMAN, now });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: "https://hooks.example/team" });
  await put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "eae0b22", method: "ateam release --deploy", writes: ["production:deployed.sha"] });
  await put({ kind: "reading", actor: "release", surface: "repo", key: "batch.8b", value: { sha: "be9b232", base: "0000000", contains: ["t-1"] }, method: "装配", depends_on: ["production:deployed.sha"] });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: { pm: ["R1", "R3", "R4", "R8", "R11", "R13"], reviewer: ["R3", "R6"], dev: ["R5", "R9"], frontend: ["R5"] } });
  return board(reduce(await s.read(), now), HUMAN, now);
}

describe("t-136 · 算好了没人印，构建当场红", () => {
  it("每一句给人看的话，都有渲染方读得到它落在的那个字段", async () => {
    const sources = Object.values(RENDERERS).map((u) => readFileSync(u, "utf8"));
    const found = unread(await loudBoard(), sources);
    const said = found.map((x) => `  ${x.path}（字段 ${x.field}，${Object.keys(RENDERERS).join(" 与 ")} 都没有读它）：${x.text}`).join("\n");
    expect(found, found.length ? `core 算好了这些话，但没有任何渲染方读它们落在的字段：\n${said}` : "").toEqual([]);
  });

  it("故意留一句无人读的：它红，而且指名到那一句", async () => {
    const b = await loudBoard();
    const withOrphan = { ...b, 孤儿: { line: "这一句是算好的，可是没有人会印它。" } } as unknown as Board;
    const found = unread(withOrphan, ["renderBoard reads b.tasks and b.live", "format reads board.release"]);
    expect(found.some((x) => x.field === "孤儿")).toBe(true);
    const it0 = found.find((x) => x.field === "孤儿")!;
    expect(it0.path).toBe("孤儿.line");
    expect(it0.text).toBe("这一句是算好的，可是没有人会印它。");   // named, not just counted
  });

  it("接上就绿：一个渲染方提到那个字段就够了，印在哪、印成什么样不归它管", async () => {
    const b = await loudBoard();
    const withOrphan = { ...b, 孤儿: { line: "这一句是算好的，可是没有人会印它。" } } as unknown as Board;
    const connected = unread(withOrphan, ["const x = b.孤儿.line;"]);
    expect(connected.some((x) => x.field === "孤儿")).toBe(false);
    // and it stays out of the business of how: a renderer that reads the field but prints it wrong is not this test's
    expect(unread(withOrphan, ["if (b.孤儿) {/* 印别的 */}"]).some((x) => x.field === "孤儿")).toBe(false);
  });

  it("标签、id、英文短语不算一句话：只有中文整句才要求有人读", async () => {
    const noise = { a: "t-129", b: "repo", c: "deployed.sha", d: "GET /health", e: "abc1234: fix", f: "ok" } as unknown as Board;
    expect(unread(noise, ["nothing"])).toEqual([]);
  });
});
