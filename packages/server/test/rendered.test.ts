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
 * Does `src` read the property `leaf` off something — `x.line`, `b.alert.line`, `f()?.line`? Deliberately not a bare
 * word search: 「line」 also appears in CSS as `line-height` and `var(--line)`, and counting those was how the first
 * version of this check passed the very night it was written to catch (qa 05:23).
 */
const readsLeaf = (src: string, leaf: string) => new RegExp(`[A-Za-z0-9_$)\\]]\\s*[?!]?\\.\\s*${leaf}(?![\\w-])`).test(src);

/**
 * Every human sentence on `b` that no renderer reads.
 *
 * **Why the leaf and not the field.** The first version asked only whether the *top-level* field appeared in a
 * renderer, and qa proved it useless on the case it was written for: in t-119's defective html.ts the word `alert`
 * appears nine times — in a comment, in `CONTACT_ASK_KEY = "alert.ask"`, in `opts.ask === "alert"`, in CSS variables —
 * while `alert.line`, the sentence core had carefully computed, was read nowhere. The check would have said "alert has
 * a reader" and waved that night through. So what has to be found is the property the sentence actually lands on.
 *
 * It still asks one thing only: does anybody read this. Where it is printed, in what order, in what words, remains
 * pd's and the page's, and nothing here looks at any of that (pm, criterion 3). qa 05:23 said the same and it is worth
 * recording that my earlier note here — that a finer check would start ruling on how a sentence is printed — was
 * wrong: reading a property is not judging what is done with it.
 */
function unread(b: Board, sources: string[]): Unread[] {
  const all: { path: string; text: string; read: boolean }[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (!CJK.test(v) || [...v].length < SENTENCE_CHARS) return;
      const field = path.split(/[.[]/)[0];
      const leaf = path.split(".").pop()!.replace(/\[\d+\]$/, "");   // criteria[0] is read as `.criteria`, not `.criteria[0]`
      // read = someone names this exact path, or holds the field and reads the property off it (`for (const x of b.batches) x.line`)
      const direct = new RegExp(`${field}\\s*[?!]?\\.\\s*${leaf}(?![\\w-])`);
      all.push({ path, text: v, read: sources.some((s) => direct.test(s) || (s.includes(field) && readsLeaf(s, leaf))) });
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
  };
  walk(b, "");
  const out: Unread[] = [];
  const seen = new Set<string>();
  for (const x of all) {
    if (x.read || seen.has(x.path)) continue;
    // A phrase quoted inside a sentence somebody reads has reached the person already: coverage[i].name is nobody's
    // to print, and coverage[i].line — 「没人管看着跑起来的东西说哪里不对：没有角色声明」 — carries it word for word.
    if (all.some((y) => y.read && y.text !== x.text && y.text.includes(x.text))) continue;
    seen.add(x.path);
    out.push({ path: x.path, field: x.path.split(/[.[]/)[0], text: x.text });
  }
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

  it("接上就绿，而且不管接上之后拿它做了什么", async () => {
    const b = await loudBoard();
    const withOrphan = { ...b, 孤儿: { line: "这一句是算好的，可是没有人会印它。" } } as unknown as Board;
    expect(unread(withOrphan, ["const x = b.孤儿.line;"]).some((x) => x.field === "孤儿")).toBe(false);
    // 判据 3: reading it is the whole question. What a renderer then does with it — prints it somewhere else, wraps
    // it, counts its length — is pd's and the page's business and never this check's.
    expect(unread(withOrphan, ["const n = b.孤儿?.line.length; log(n);"]).some((x) => x.field === "孤儿")).toBe(false);
    expect(unread(withOrphan, ["for (const x of [b.孤儿]) out.push(x.line)"]).some((x) => x.field === "孤儿")).toBe(false);
  });

  /**
   * qa 05:23 proved the first version useless on the case it was written for: it asked only whether the *top-level
   * field* appeared anywhere in a renderer, and in t-119's defective html.ts the word `alert` appears nine times — a
   * comment, `CONTACT_ASK_KEY = "alert.ask"`, `opts.ask === "alert"`, two CSS variables — while `alert.line` was read
   * nowhere. That hole is closed: what is looked for now is the property the sentence actually lands on.
   */
  it("字段被碰了、句子被无视：现在抓得住（旧口径会放行）", async () => {
    const b = await loudBoard();
    const defective = [
      `export interface RenderOptions { /** \`?ask=alert\`: show the contact card again (t-069) */ ask?: string | null }`,
      `export const CONTACT_ASK_KEY = "alert.ask";`,
      `const reopen = contactOn && opts.ask === "alert" && !asks.some(isContactCard);`,
      `--accent:#0F6E63; --alert:#B42318; --warn:#B7791F;`,
      `.count { color:#fff; background:var(--alert); line-height:1.6; }`,
      // what it printed instead: its own sentence, from the address string, never core's
      `export function contactLine(address: string | null): string { return address ? \`你不在时发到 \${address}\` : UI.contactNone; }`,
    ].join("\n");
    expect(defective).toContain("alert");                                     // the old check's whole test, and it passed
    const hit = unread(b, [defective]).find((x) => x.path === "alert.line");
    expect(hit, "字段在源码里出现过，但那句话没人读——必须抓住").toBeTruthy();
    expect(hit!.text).toBe(b.alert!.line);
    // the fixed shapes, verbatim from today's two renderers, are not flagged
    expect(unread(b, [`if (alert?.line) return alert.line;`]).some((x) => x.path === "alert.line")).toBe(false);
    expect(unread(b, [`if (b.alert?.line) out.push(b.alert.line);`]).some((x) => x.path === "alert.line")).toBe(false);
  });

  /**
   * And where it still cannot help, pinned so that nobody reads the test above as more than it is.
   *
   * On the real pair at babae6d this check would **not** have caught t-119, for a reason the fix above does not touch:
   * `cli/src/format.ts` did read `b.alert.line` — only in the misconfigured state, but it read it — so by 判据 1's
   * words ("没有**任何**渲染方读到它") the sentence had a reader, and the page inventing its own line beside it is
   * invisible here. Catching that means saying which renderer has to show what, which is the one thing 判据 3 puts
   * outside this check. It belongs to pd's placement or to another instrument, and it is dev's to report, not to
   * quietly widen the check until it looks caught.
   */
  it("它管不了的那一种：一个渲染方读了，另一个自己另写一句", async () => {
    const b = await loudBoard();
    const pageInventsItsOwn = `export function contactLine(address: string | null) { return \`你不在时发到 \${address}\`; }`;
    const cliReadsItInOneState = `if (b.alert?.status === "misconfigured" && b.alert.line) out.push(b.alert.line);`;
    expect(unread(b, [pageInventsItsOwn, cliReadsItInOneState]).some((x) => x.path === "alert.line")).toBe(false);
    // said plainly: with only the page, it is caught — the gap is exactly "somebody else read it"
    expect(unread(b, [pageInventsItsOwn]).some((x) => x.path === "alert.line")).toBe(true);
  });

  it("引在别人句子里的短语不算孤儿：coverage[i].name 整句地长在被读的 coverage[i].line 里", async () => {
    const b = await loudBoard();
    const name = b.coverage.find((c) => c.line?.includes(c.name ?? "\u0000"));
    expect(name, "样本板上应当有一条 line 里含着自己的 name").toBeTruthy();
    const found = unread(b, [`for (const c of b.coverage) out.push(c.line)`]);
    expect(found.some((x) => x.path.endsWith(".name"))).toBe(false);
    // but a phrase nobody quotes and nobody reads is still an orphan
    const withOrphan = { ...b, 孤儿: { name: "这一句谁也没有引用过，也没有人印。" } } as unknown as Board;
    expect(unread(withOrphan, [`for (const c of b.coverage) out.push(c.line)`]).some((x) => x.field === "孤儿")).toBe(true);
  });

  it("标签、id、英文短语不算一句话：只有中文整句才要求有人读", async () => {
    const noise = { a: "t-129", b: "repo", c: "deployed.sha", d: "GET /health", e: "abc1234: fix", f: "ok" } as unknown as Board;
    expect(unread(noise, ["nothing"])).toEqual([]);
  });
});
