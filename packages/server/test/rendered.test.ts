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
import { MemoryStore, append, reduce, board, sampleLog, similarity, SERVICE_ACTOR, type Board, type NewEvent } from "@ateam/core";
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
/**
 * The names a renderer could be holding this field under: the field itself, anything bound from an expression that
 * mentions it, and so on transitively — `const batches = b.batches ?? []` then `for (const x of batches)` then
 * `x.line`.
 *
 * It follows the binding rather than accepting any two facts from anywhere in the file, because qa 05:34 showed with
 * the real file what the loose version does: in babae6d's html.ts `alert` is satisfied by the CSS variable
 * `--alert:#B42318` and `line` by an unrelated `c.line` in the coverage code, so the check said `alert.line` had a
 * reader on the very file where it had none.
 */
/** t-136: how far a binding chain is followed. Measured, not guessed — see `aliases`. */
const ALIAS_STEPS = 2;

/**
 * Source with the *text* blanked out and the code kept: `"alert.ask"` and the CSS `--alert:#B42318` are text, not
 * references, while `${w.hint}` inside a template literal is code and the renderer's only way of saying it reads it.
 * Blanking whole template literals hid exactly that and made this check accuse `format.ts` of ignoring the allocation
 * hints it prints on line 165.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
     .replace(/`(?:[^`\\]|\\.)*`/g, (lit) => lit.replace(/\$\{[^}]*\}|[\s\S]/g, (x) => (x.startsWith("${") ? x : " ")))
     .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/**
 * The names a renderer could be holding this field under: the field itself, plus whatever is bound directly from it —
 * `const batches = b.batches ?? []`, then `for (const x of batches)`, then `x.line`.
 *
 * Two things keep it honest, both of them qa's. Strings and comments are blanked first, because the loose version
 * counted `"alert.ask"` and the CSS variable `--alert:#B42318` as references and so declared `alert.line` read on the
 * one file that never read it (qa 05:34, on the whole real babae6d html.ts, not an excerpt). And the chain is one
 * step, not transitive: one step answers every real reading in this repo — following further only grows the alias set
 * (2 names at one step, 108 unbounded) and with it the chance of matching a `.line` that belongs to somebody else.
 *
 * How far the chain is followed is measured, not assumed: one step misses how this repo reads `coverage`
 * (`const gaps = coverageOf(b)` then `gaps.map(c => c.line)`), and following it without limit finds nothing more than
 * two steps do while growing the alias set from 21 names to 108 — every extra name another chance to match a `.line`
 * that belongs to somebody else. Two steps is the smallest that is right on every sentence-bearing field of a real
 * board.
 *
 * When it is wrong it is wrong toward the alarm: a longer chain than one step reads as "nobody reads this", which
 * turns the build red and gets looked at. The failure that matters — saying a sentence has a reader when it has none —
 * is the one this shape avoids.
 */
function aliases(raw: string, field: string): string[] {
  const src = code(raw);
  if (!new RegExp(`(?<![\\w$])${field}(?![\\w$])`).test(src)) return [];
  const names = new Set([field]);
  let frontier = [field];
  for (let step = 0; step < ALIAS_STEPS && frontier.length; step++) {
    const next: string[] = [];
    for (const n of frontier) for (const re of [
      new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*(?<![\\w$])${n}(?![\\w$])`, "g"),
      new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+[^)]*(?<![\\w$])${n}(?![\\w$])`, "g"),
      new RegExp(`(?<![\\w$])${n}(?![\\w$])[^;\\n]*\\.(?:map|forEach|filter|flatMap|find|some|every)\\(\\s*\\(?\\s*([A-Za-z_$][\\w$]*)`, "g"),
    ]) for (const m of src.matchAll(re)) if (!names.has(m[1])) { names.add(m[1]); next.push(m[1]); }
    frontier = next;
  }
  return [...names];
}

/** Does this source read `leaf` off the field, or off something it bound from the field? */
const readsIn = (src: string, raw: string, field: string, leaf: string) =>
  aliases(raw, field).some((n) => new RegExp(`(?<![\\w$])${n}\\s*[?!]?\\.\\s*${leaf}(?![\\w-])`).test(src));
const readsLeaf = (raw: string, field: string, leaf: string) => readsIn(code(raw), raw, field, leaf);

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
  // `code()` and the alias walk are the expensive part and the answer only depends on (source, field), so each pair is
  // computed once: without this the check spends twenty seconds re-reading the same two files for every sentence.
  const stripped = sources.map(code);
  const known = new Map<string, string[]>();          // (source, field) -> the names it could be holding it under
  const reads = (i: number, field: string, leaf: string) => {
    const key = `${i}\u0000${field}`;
    let names = known.get(key);
    if (names === undefined) known.set(key, (names = aliases(sources[i], field)));
    return names.some((n) => new RegExp(`(?<![\\w$])${n}\\s*[?!]?\\.\\s*${leaf}(?![\\w-])`).test(stripped[i]));
  };
  const all: { path: string; text: string; read: boolean }[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (!CJK.test(v) || [...v].length < SENTENCE_CHARS) return;
      const field = path.split(/[.[]/)[0];
      const leaf = path.split(".").pop()!.replace(/\[\d+\]$/, "");   // criteria[0] is read as `.criteria`, not `.criteria[0]`
      // read = someone names this exact path, or holds the field and reads the property off it (`for (const x of b.batches) x.line`)
      all.push({ path, text: v, read: sources.some((_s, i) => reads(i, field, leaf)) });
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

/** Every Chinese string a renderer writes for itself: quoted or backticked, with `${…}` holes removed. */
function ownSentences(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)) {
    const text = m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, "").trim();
    if (CJK.test(text) && [...text].length >= SENTENCE_CHARS) out.push(text);
  }
  return out;
}

/**
 * t-142 (pm 05:31): core computes a sentence for a person, and a renderer writes its own beside it. t-126 was that:
 * i18n held `contactTo: (v) => \`你不在时发到 \${v}\`` and the page printed it instead of the four states core had
 * computed — so an address nobody had ever delivered to was promised as one that works.
 *
 * The rule here is pm's: not "who must show which sentence" (that is placement, and pd's), only **no second copy**.
 */
function duplicated(sentences: string[], sources: { name: string; src: string }[], bar: number): { where: string; text: string; like: string; score: number }[] {
  const out: { where: string; text: string; like: string; score: number }[] = [];
  for (const { name, src } of sources) {
    for (const own of ownSentences(src)) {
      let best = { s: 0, like: "" };
      for (const c of sentences) { const s = similarity(own, c); if (s > best.s) best = { s, like: c }; }
      if (best.s >= bar) out.push({ where: name, text: own, like: best.like, score: best.s });
    }
  }
  return out;
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
    expect(unread(withOrphan, ["const it = b.孤儿; out.push(it.line);"]).some((x) => x.field === "孤儿")).toBe(false);
    expect(unread(withOrphan, ["for (const x of [b.孤儿]) out.push(x.line)"]).some((x) => x.field === "孤儿")).toBe(false);
    // holding it and never reading the sentence is not reading it — that is t-119's shape, and it must still be red
    expect(unread(withOrphan, ["if (b.孤儿) out.push(UI.somethingElse)"]).some((x) => x.field === "孤儿")).toBe(true);
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

/**
 * t-142: core has a sentence, and a renderer writes its own beside it. Nobody catches that today, and it is not
 * hypothetical — t-126 was exactly it, and what the person read was a promise about an address that had never been
 * delivered to.
 *
 * **What the bar rests on, measured from the files rather than from memory** (an earlier version of this comment
 * claimed a 1.000 copy that never existed; qa 05:52 went and looked). Every Chinese literal in `i18n.ts@babae6d`
 * against every sentence core computes, all pairs:
 *
 *   1.000   a copy — by construction, not by observation. Copying a sentence makes it identical to itself; no such
 *           pair has ever been in this repo, and the whole point is that none ever should be.
 *   0.182   `contactTo`, the literal the page printed instead of core's — the real defect, and the highest pair the
 *           repo's history contains.
 *   0.179   `contactInvalid`, entirely innocent, three thousandths away from it.
 *   0.115   `contactTitle`; 0.103 `contactNone`; 0.060 `contactEmail`.
 *
 * So 0.6 is not the middle of an observed gap between defects and innocents — there is no such gap. It is the middle
 * of the gap between *writing your own words* (0.18 at worst) and *copying* (1.0), which is the only thing this
 * distinguishes and all it claims to.
 */
const DUP_BAR = 0.6;

describe("t-142 · core 已经有一句了，渲染方不许再拼一句", () => {
  const renderers = () => [
    { name: "server/src/html.ts", src: readFileSync(new URL("../src/html.ts", import.meta.url), "utf8") },
    { name: "server/src/i18n.ts", src: readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8") },
    { name: "cli/src/format.ts", src: readFileSync(new URL("../../cli/src/format.ts", import.meta.url), "utf8") },
  ];
  const coreSentences = async () => {
    const b = await loudBoard();
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") { if (CJK.test(v) && [...v].length >= SENTENCE_CHARS) out.push(v); return; }
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") return Object.values(v).forEach(walk);
    };
    walk(b);
    return out;
  };

  it("今天没有一处重复", async () => {
    const found = duplicated(await coreSentences(), renderers(), DUP_BAR);
    const said = found.map((f) => `  ${f.where}：「${f.text}」\n    与 core 的「${f.like}」相似度 ${f.score.toFixed(2)}`).join("\n");
    expect(found, found.length ? `渲染方自己拼了 core 已经算好的话：\n${said}` : "").toEqual([]);
  });

  /** core's four call-out sentences, from core itself — the corpus t-126 duplicated one of. */
  const alertLines = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const build of [
      // an address recorded before the shape was declared: the state qa had to make with appendRaw, and t-126's twin
      async (s: MemoryStore) => s.appendRaw({ id: "01OLD", at: new Date().toISOString(), kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: "someone@example.com" } as never),
      async (s: MemoryStore) => { await append(s, { kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: "https://hooks.example/team" }, { human: HUMAN }); },
      // proved reachable: the state whose sentence t-126's own wording was a synonym of
      async (s: MemoryStore) => {
        await append(s, { kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: "https://hooks.example/team" }, { human: HUMAN });
        await append(s, { kind: "reading", actor: SERVICE_ACTOR, surface: "project", key: "alert.reached", value: "https://hooks.example/team", method: "外呼真的送到了（HTTP 200）" }, { human: HUMAN });
      },
    ]) {
      const s = new MemoryStore();
      await build(s);
      const line = board(reduce(await s.read(), new Date()), HUMAN, new Date()).alert?.line;
      if (line) out.push(line);
    }
    return out;
  };

  it("造一处重复：红，并指出它和 core 的哪一句撞了；去掉就绿", async () => {
    const sentences = [...(await coreSentences()), ...(await alertLines())];
    const one = sentences.find((x) => x.includes("这个外呼地址"))!;
    const copied = [{ name: "i18n.ts", src: `export const UI = { contactEmail: "${one}" };` }];
    const [hit] = duplicated(sentences, copied, DUP_BAR);
    expect(hit).toBeTruthy();
    expect(hit.text).toBe(one);
    expect(hit.like).toBe(one);
    expect(hit.score).toBe(1);
    // that copy really was in i18n.ts at babae6d; without it, nothing
    expect(duplicated(sentences, [{ name: "i18n.ts", src: `export const UI = { contactSave: "记下" };` }], DUP_BAR)).toEqual([]);
  });

  it("一句稍作改写的也抓得住，只要还够像", async () => {
    const sentences = [...(await coreSentences()), ...(await alertLines())];
    const one = sentences.find((x) => x.includes("这个外呼地址"))!;
    const reworded = one.replace("我们发不出去", "我们发不出").replace("。", "");
    expect(similarity(reworded, one)).toBeGreaterThan(DUP_BAR);
    expect(duplicated(sentences, [{ name: "i18n.ts", src: `const x = "${reworded}";` }], DUP_BAR)).toHaveLength(1);
  });

  /**
   * 判据 3, in numbers. This cannot catch t-126, the case it exists for, and no threshold could — but not for the
   * reason I first wrote. I had claimed the synonym was *less* like core's sentence than innocent strings were, on a
   * number I got by typing the literal out (with a URL in it) instead of reading it from the file. Read from the file
   * it is 0.182: the **most** alike of the group, with an innocent — `contactInvalid` — at 0.179 beside it.
   *
   * The conclusion survives and is sharper for it: the real defect and an innocent string are three thousandths
   * apart, so no threshold separates them. Anything low enough to catch t-126 catches contactInvalid in the same
   * breath. Reported to pm rather than tuned until it looks caught.
   */
  it("它看不见的：改写到不像的同义句——包括 t-126 自己", async () => {
    const sentences = [...(await coreSentences()), ...(await alertLines())];
    const score = (x: string) => Math.max(...sentences.map((c) => similarity(x, c)));
    const t126 = "你不在时发到";              // i18n@babae6d contactTo, with its ${v} hole, as this check sees it
    const innocent = "填一个 https:// 开头的 webhook 地址";   // i18n@babae6d contactInvalid, guilty of nothing
    expect(score(t126)).toBeLessThan(DUP_BAR);
    expect(Math.abs(score(t126) - score(innocent))).toBeLessThan(0.01);   // no bar can tell these two apart
    expect(duplicated(sentences, [{ name: "i18n.ts", src: `const x = "${t126}";` }], DUP_BAR)).toEqual([]);
    expect(duplicated(sentences, [{ name: "i18n.ts", src: `const x = "${innocent}";` }], DUP_BAR)).toEqual([]);
    // and a sentence core never computed at all is nobody's duplicate
    expect(duplicated(sentences, [{ name: "i18n.ts", src: `const x = "今天天气不错，适合发布。";` }], DUP_BAR)).toEqual([]);
  });
});
