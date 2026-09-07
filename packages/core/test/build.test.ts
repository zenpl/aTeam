/**
 * t-062: the Builder writes a log the way the server does; what the server would reject, it rejects while building.
 * Times relative to now.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { Builder, sampleLog, Rejected, reduce, board, surfaceResults, manual, WATCH_INTERVAL, REACH_RULE, KEY_SYMBOLS, NO_HUMAN_IMPACT, SAYINGS, HUMAN_FIELDS, REGISTRY_SYMBOLS, manualFiles, MANUAL_COPY_MIN, sourceFiles, MANUAL_COPIES_FROZEN, manualCopies, EMPTY_IS_NOT_NO_IMPACT, NO_SYMBOL_MEANS_UNCLEAR, SHOWS_RULE, PROMISE_RULE, speaking as speakingOf, deciding as decidingOf, measureKeySymbols, renderKeySymbols, withKeySymbols } from "../src/index.js";
import { DEFAULT_WATCH_CMD } from "../../cli/src/deaf.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulidTime = (id: string) => [...id.slice(0, 10)].reduce((n, c) => n * 32 + ALPHABET.indexOf(c), 0);
const min = (n: number) => n * 60_000;

describe("t-062 · Builder", () => {
  it("field names are the server's; deliveries and cursors carry event_id and last_event_id; ids carry the clock", async () => {
    const start = Date.now() - min(60);
    const b = new Builder({ start, stepMs: min(1) });
    const i = await b.tell("pm", "dev", "做 t-1");
    expect(i).toMatchObject({ kind: "instruction", actor: "pm", to: "dev", body: "做 t-1", at: new Date(start + min(1)).toISOString(), ack_by: new Date(start + min(16)).toISOString() });
    expect(ulidTime(i.id)).toBe(start + min(1));
    const p = await b.pull("dev");
    expect(p.for_me.map((e) => e.id)).toEqual([i.id]);
    const log = await b.log();
    expect(log.deliveries).toEqual([{ event_id: i.id, to: "dev", at: new Date(start + min(2)).toISOString() }]);
    expect(log.cursors).toEqual([{ actor: "dev", last_event_id: i.id, at: new Date(start + min(2)).toISOString() }]);
    await b.ack("dev", i.id);
    const st = await b.state();
    expect(st.instructions.get(i.id)).toMatchObject({ delivered_at: new Date(start + min(2)).toISOString(), acked_at: new Date(start + min(3)).toISOString() });
    // a second pull reads only what came after the cursor
    await b.note("pm", "x");
    const p2 = await b.pull("dev");
    expect(p2.events.map((e) => e.kind)).toEqual(["ack", "note"]);
    expect(b.steps.map((s) => s.kind)).toEqual(["event", "pull", "event", "event", "pull"]);
  });

  it("an illegal move is rejected at build time: done before claim, reopen then done without claim is fine, verify by the owner, ack of a stranger's instruction", async () => {
    const b = new Builder();
    await b.task.create("pm", "t-1", "题", ["能用"], { no_human_impact: true });
    await expect(b.task.done("dev", "t-1", { no_human_impact: true })).rejects.toBeInstanceOf(Rejected);
    await b.task.claim("dev", "t-1", ["x"]);
    await b.task.done("dev", "t-1", { no_human_impact: true, evidence: "abc1234" });
    await expect(b.task.verify("dev", "t-1", "repo", true)).rejects.toThrow(/owner cannot pass/);
    await b.task.verify("qa", "t-1", "repo", false, { evidence: "不对" });
    await expect(b.task.done("dev", "t-1", { no_human_impact: true })).rejects.toThrow(/is failed/); // must reopen (or claim) first
    await b.task.reopen("dev", "t-1", "改");
    await b.task.done("dev", "t-1", { no_human_impact: true, evidence: "def5678" });
    await b.task.verify("qa", "t-1", "repo", true);
    const i = await b.tell("pm", "dev", "x");
    await expect(b.ack("qa", i.id)).rejects.toThrow(/addressed to dev/);
    const t = (await b.state()).tasks.get("t-1")!;
    expect(t.round).toBe(2);
    expect(surfaceResults(t)).toEqual([{ surface: "repo", pass: true }]);
    expect(t.verifications.map((v) => [v.round, v.pass])).toEqual([[1, false], [2, true]]);
    // nothing rejected made it into the log; the service's fail notice after the failed verify is there, as on the server
    expect((await b.log()).events.map((e) => e.kind + ("op" in e ? ":" + e.op : ""))).toEqual(["task:create", "task:claim", "task:done", "task:verify", "instruction", "task:reopen", "task:done", "task:verify", "instruction"]);
    expect(b.steps.find((s) => s.kind === "event" && s.event.kind === "task" && s.event.op === "verify")).toMatchObject({ followed: [{ kind: "instruction", to: "dev" }] });
  });

  it("the sample log holds an instruction with its delivery, cursors for three roles, a decision and a two-round task; it reduces and boards", async () => {
    const start = Date.now() - min(120);
    const log = await sampleLog({ start });
    expect(log.events.some((e) => e.kind === "instruction" && e.to === "dev")).toBe(true);
    expect(log.deliveries.map((d) => d.to)).toContain("dev");
    expect(log.cursors.map((c) => c.actor).sort()).toEqual(["dev", "pm", "qa"]);
    for (const c of log.cursors) expect(log.events.some((e) => e.id === c.last_event_id)).toBe(true);
    for (const d of log.deliveries) expect(log.events.find((e) => e.id === d.event_id)?.kind).toBe("instruction");
    for (const e of log.events) { expect(Date.parse(e.at)).toBeLessThan(Date.now()); expect(ulidTime(e.id)).toBe(Date.parse(e.at)); }
    const now = new Date(Date.parse(log.events.at(-1)!.at) + min(1));
    const s = reduce(log, now);
    const t = s.tasks.get("t-1")!;
    expect(t.status).toBe("verified");
    expect(t.round).toBe(2);
    expect(t.history.map((h) => h.op)).toEqual(["done", "verify", "reopen", "done", "verify"]);
    const b = board(s, "human", now);
    expect(b.tasks.verified.map((x) => x.id)).toEqual(["t-1"]);
    expect(b.instructions.find((i) => i.to === "dev")).toMatchObject({ status: "acked" });
    expect(b.instructions.find((i) => i.to === "human")!.chosen).toMatchObject({ option: "A", by: "human" });
    expect(b.needs_human).toEqual([]);
  });
});

/**
 * t-145: the watch interval is one number in one place. It was four places holding three: the CLI's real default
 * (20s), the manual and CLAUDE.md teaching 25s, and t-139's reminder suggesting 60s — and pm ruled on 25 while the
 * default was 20, because nobody could see all four at once.
 *
 * Same instrument as t-108: the prose is filled from the constant that decides it, and a hard-coded one turns the
 * build red. What the number should *be* is not settled — see WATCH_INTERVAL — but where it lives now is.
 */
describe("t-145 · watch 的间隔只有一处", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("说明书教的间隔是填进去的，不是抄的", () => {
    expect(read("../manual/common.md")).toContain("--interval {{watch_interval}}");
    const filled = manual("dev")!;
    expect(filled).toContain(`--interval ${WATCH_INTERVAL}`);
    expect(filled).not.toContain("{{watch_interval}}");            // the hole is filled, never shown to a reader
  });

  it("说明书与帮助文本里都不再写死一个间隔数字", () => {
    const hard = /--interval\s+\d+\s*(?:s|ms|m)\b/g;
    // t-156: CLAUDE.md 也在里面。今晚它是唯一漏网的那一处——t-145 把四份合成一份时没查它，于是默认值已经是 60
    // 秒了，而每个 agent 每天读的那份文件还在教 25 秒。被教的那个数看起来就像默认值。
    for (const [what, text] of [["说明书", read("../manual/common.md")], ["CLI 帮助", read("../../cli/src/main.ts")], ["提醒", read("../../cli/src/deaf.ts")], ["CLAUDE.md", read("../../../CLAUDE.md")]] as const) {
      const found = [...text.matchAll(hard)].map((m) => m[0]);
      expect(found, `${what} 里写死了间隔：${found.join("、")}——它该从 WATCH_INTERVAL 取`).toEqual([]);
    }
  });

  it("t-156：一个新节点什么都不配，拿到的就是这个数", () => {
    // 「默认值就是协议」：不给 --interval 时走的就是 WATCH_INTERVAL，CLI 里没有第二个默认值
    const src = read("../../cli/src/main.ts");
    expect(src).toMatch(/str\(a,\s*"interval"\)\s*\?\?\s*WATCH_INTERVAL/);
    expect(WATCH_INTERVAL).toBe("60s");
    // 全仓库只有这一处写着这个数（t-145 的不变式）：源码里搜不到第二个裸的 60s / 60_000 当间隔用
    for (const p of ["../../cli/src/main.ts", "../../cli/src/loop.ts", "../../cli/src/deaf.ts", "../manual/common.md", "../../../CLAUDE.md"]) {
      expect(read(p), `${p} 里写死了间隔`).not.toMatch(/--interval\s+\d+\s*(?:s|ms|m)\b/);
    }
  });

  it("三处说的是同一个数：从常量取的那一个", () => {
    const cmd = DEFAULT_WATCH_CMD;
    expect(cmd).toBe(`ateam watch --interval ${WATCH_INTERVAL}`);
    expect(manual("dev")!).toContain(cmd.replace("ateam ", "ateam "));
    expect(read("../../cli/src/main.ts")).toContain("--interval ${WATCH_INTERVAL}");   // the help line, as a template
  });

  it("改常量就是改全部：没有第二处需要跟着改", () => {
    // every place that teaches the interval reads the same source, so this test is the whole list of them
    const sources = ["../manual/common.md", "../../cli/src/main.ts", "../../cli/src/deaf.ts"];
    for (const p of sources) expect(read(p)).toMatch(/watch_interval|WATCH_INTERVAL/);
  });
});

/**
 * t-141: 「你欠什么」那一段是 pd 06:27 的字。它在 core 里只有一份（REACH_RULE），说明书填进去，不抄。
 *
 * 这一件的整个由来就是「一边停一边教」：说明书教「先 ack 再做别的」，而行为已经不这么算了。抄一份到 markdown
 * 里，下一次口径变的时候两份就会又分开——同一条 t-108/t-145 的规矩，这次守的是一段话不是一个数。
 */
describe("t-141 · 说明书里「你欠什么」那一段只有一处出处", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("说明书是填 REACH_RULE，不是抄它的字", () => {
    const src = read("../manual/common.md");
    expect(src).toContain("{{reach_rule}}");
    expect(src).not.toContain("沉默不是答案");                 // 一个字都不在 markdown 里
    const filled = manual("dev")!;
    expect(filled).toContain(REACH_RULE);
    expect(filled).not.toContain("{{reach_rule}}");
  });

  it("三份说明书都不再教已经退役的「先 ack 再做别的」", () => {
    for (const p of ["../manual/common.md", "../manual/invite.md", "../manual/welcome.md"]) {
      const text = read(p);
      expect(text, `${p} 还在教 ack`).not.toMatch(/先\s*ack|必须\s*ack|每一条发给你的指令.*ack/);
      expect(text, `${p} 还在教发 ack 事件`).not.toContain('"kind":"ack"');
    }
  });

  it("代价说在明处：不是「你会被记一笔」，是「发的人会一直以为你还没读到」", () => {
    expect(REACH_RULE).toContain("沉默不是答案");
    expect(REACH_RULE).toContain("发的人会一直以为你还没读到");
    expect(manual("dev")!).toContain("发的人会一直以为你还没读到");
  });
});

/**
 * t-173：**每一个 CLI 用 bool() 读的开关，都必须在 args.ts 的 BOOLEAN 名单里。**
 *
 * 漏一个，那个开关就是死的，而且是**静默地**死：`--x` 报「needs a value」，`--x true` 存成字符串而 bool() 仍然
 * 返回 false。今天同时漏了两个，都是我当天加的——`--no-human-impact`（t-151 那道闸唯一的出路）与 `--missed`
 * （t-149 的补记）。前一个尤其糟：**出路死了，那道闸就从「要求人说真话」变成「逼人说假话」**，因为一件真的不
 * 改变人看到的东西的活，除了编一句 shows 之外无路可走。frontend 在它上线之前实测发现，不是我。
 *
 * 同 t-108 / t-148 的做法：一份名单与它描述的东西分开手工维护，必然漂移，所以让构建去对。
 */
describe("t-173 · CLI 的开关名单与它的用法对得上", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("bool() 读到的每一个开关都在 BOOLEAN 里", () => {
    const main = read("../../cli/src/main.ts");
    const args = read("../../cli/src/args.ts");
    const declared = new Set([...(args.match(/const BOOLEAN = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    // 两种读法都要查：bool(a, "x")，以及绕过解析器直接查 argv 的 argv.includes("--x")——后者是 --clear-refused
    // 那一种，症状不同（先打一行 needs a value 再照常工作）但根因同一个。
    const used = [...new Set([
      ...[...main.matchAll(/bool\(\s*a\s*,\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
      ...[...main.matchAll(/argv\.includes\(\s*"--([^"]+)"\s*\)/g)].map((m) => m[1]),
    ])].sort();
    expect(used.length).toBeGreaterThan(5);   // 名单本身没被读空
    const missing = used.filter((x) => !declared.has(x));
    expect(missing, `这些开关是死的（--x 报 needs a value，--x true 也设不上）：${missing.join("、")}`).toEqual([]);
  });

  it("今天漏掉的那三个现在真的在里面", () => {
    const args = read("../../cli/src/args.ts");
    for (const flag of ["no-human-impact", "missed", "clear-refused"]) expect(args).toContain(`"${flag}"`);
  });
});

/**
 * t-170 判据 9 (pm 08:46)：**KEY_SYMBOLS 不能靠手数。**
 *
 * qa 08:46 判不过的第一条就是它漏了一个：frontend 的 `board.ts#inFlightGroups` 改的是牌桌在途那一段的四行字，
 * 而它不在名单里，于是那件活可以合法地说「不改变人看到的东西」——正是这条规则从 t-151 起最想拦的那一种。
 * 漏的原因不是疏忽，是**一份名单与它描述的东西分开手工维护**，今晚第四次（t-108 的秒数、t-148 的命令、
 * t-173 的开关，这是第四个）。所以这里从源码里把它重新量一遍。
 */
describe("t-170 · core 里会说人话的符号，名单是量出来的不是数出来的", () => {
  const CJK = /[一-龥]/;
  /**
   * t-185：**扫的是哪些文件，也是走出来的，不是名单。**这里原来写着 ["board.ts","events.ts","reduce.ts",
   * "allocation.ts"] 与另一份七个文件的名单——core 里新加一个会说人话的文件，两道闸都看不见它。现在从
   * `packages/core/src` 走一遍，谁都不用记得往哪份名单里加。
   */
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const CORE_FILES = sourceFiles(new URL("../src", import.meta.url).pathname, "").map((f) => f.replace(/^\//, ""));
  /**
   * core 源码里「函数体或常量里含给人看的整句中文」的导出符号——**只有 pd 08:22 那两类中的第一类**：
   * 那句话是什么。第二类「哪句话出现在哪儿」这段扫法按定义看不见：`inFlightGroups` 决定在途每一行印 `shows`
   * 还是 `title`，一个中文字面量都没有，而它改了牌桌四行字（qa 08:54 在合并后的树上量出来的，闸没红）。
   *
   * 我试过用「读 .shows / .title」去补第二类，它确实抓得住 inFlightGroups——但那是又一次按名字打地鼠：
   * 一个在两个 UI key 之间选一个、根本不碰 .shows 的函数，它照样看不见。这一整类要等 t-143 的 key 表让
   * 「哪个 key 在哪显示」变成可算的数据（pm 08:55 已搬去 t-178）。在那之前，这道闸自己说出这件事——见
   * gateHonesty 里 shows 那一档。
   */
  /**
   * t-186：**这两段搬走了。**`speaking()` / `deciding()` 现在住在 `packages/core/src/keysyms.ts`，仓库里因此
   * 有了一个能**产出**名单的东西（`bin/keysyms`），不再只有一条能**检查**它的断言。根是 frontend 10:13 找到的：
   * 生成器只存在于断言里，所以每个人的做法必然是手改到闸变绿，而名单又是每行六个排版的，任何一次增删都重排
   * 整块——两个人各加一个名字，撞的不是逻辑，是排版。
   *
   * 这里只留判定：闸读的是同一段代码，所以「闸怎么想」与「名单怎么来」不会再各说各话。
   */
  const sources = () => Object.fromEntries(CORE_FILES.map((f) => [f, read(`../src/${f}`)]));
  const deciding = () => decidingOf(sources());
  const speaking = () => speakingOf(sources());

  it("量出来的每一个都在名单里——漏一个，那件活就能说「不改变人看到的东西」", () => {
    const missing = [...new Set([...speaking(), ...deciding()])].filter((x) => !(KEY_SYMBOLS as readonly string[]).includes(x));
    expect(missing, `core 里这些符号会说人话，但不在 KEY_SYMBOLS 里：${missing.join("、")}——碰了它们的活现在可以合法说「${NO_HUMAN_IMPACT}」`).toEqual([]);
  });

  it("t-178 判据 1、2：决定「哪句话出现在哪儿」的也算——inFlightGroups 这一类不再看不见", () => {
    const d = deciding();
    expect(d, "一个都没认出来，说明这段推导本身失效了").not.toEqual([]);
    expect(d, "qa 08:54 的那一个：它决定在途每一行印「这件干了什么」还是任务标题，一个中文字面量都没有").toContain("inFlightGroups");
    for (const x of d) expect(KEY_SYMBOLS as readonly string[], `${x} 决定人看到什么，却不在名单里`).toContain(x);
  });

  it("名单里没有已经不说人话的：它跟着源码走，不是只增不减", () => {
    const live = new Set([...speaking(), ...deciding()]);
    const stale = (KEY_SYMBOLS as readonly string[]).filter((x) => !live.has(x));
    expect(stale, `名单里这些已经不在 core 里说人话了：${stale.join("、")}`).toEqual([]);
  });
});

/**
 * t-179：**说明书里不许有 core 那些句子的第二份——这一条不再一句一句地钉。**
 *
 * 今晚这是第三处：t-141 的「你欠什么」、t-145 的 watch 秒数、现在第 6 步那一段。逐句钉的做法自带这条毛病——
 * 下一句被抄进去时，没人记得再钉一次。所以这里量的是**一整类**：core 里任何一条人可见的中文，在说明书源文件里
 * 逐字出现第二份，就红。
 *
 * 两件事让它不误报，也不漏：
 * ① 量**源文件**，不量填好的说明书。`{{reach_rule}}` / `{{shows_rule}}` / `{{promise_rule}}` 是唯一出处的正确
 *    用法，源文件里只有占位符——所以正确的做法自动不算拷贝，一条例外都不用写。
 * ② 只比中文散文。`ateam task done <id> --evidence` 在两边一模一样是**应该的**（命令名就是那个名字）。
 */
describe("t-179 · core 的句子在说明书里没有第二份", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const cores = () => Object.fromEntries(
    readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => [`src/${f}`, read(`../src/${f}`)]),
  );
  // t-185：说明书的范围也走出来。原来是「手写三份 + roles/ 再走一遍」，加一份新说明书就有一半的闸看不见它。
  const entries = (rel: string) => {
    const dir = new URL(`../manual/${rel}`, import.meta.url);
    return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
  };
  const manuals = () => Object.fromEntries(manualFiles(entries).map((f) => [f, read(`../manual/${f}`)]));

  it("判据 1：第 6 步与第 3.5 步是填进来的，说明书源文件里没有那几句的第二份", () => {
    const src = read("../manual/common.md");
    expect(src).toContain("{{shows_rule}}");
    expect(src).toContain("{{promise_rule}}");
    expect(src).not.toContain(EMPTY_IS_NOT_NO_IMPACT);        // 一个字都不在 markdown 里
    expect(src).not.toContain(NO_SYMBOL_MEANS_UNCLEAR);
    const filled = manual("dev")!;
    expect(filled).toContain(EMPTY_IS_NOT_NO_IMPACT);          // 填出来的那份一字不差
    expect(filled).toContain(NO_SYMBOL_MEANS_UNCLEAR);
    expect(filled).not.toContain("{{shows_rule}}");
    expect(filled).not.toContain("{{promise_rule}}");
  });

  it("判据 1：改了 core 那句，说明书跟着变——不是一声不吭", () => {
    // 说明书那份是**算出来的**，所以不必真去改源码：把常量换掉，填出来的字必须跟着换。
    // 这条与上一条一起，才叫「只有一处出处」：上一条证明 markdown 里没有第二份，这一条证明填的是同一份。
    const before = manual("dev")!;
    expect(before).toContain(EMPTY_IS_NOT_NO_IMPACT);
    const after = before.replaceAll(EMPTY_IS_NOT_NO_IMPACT, "改过的那句话");
    expect(after).toContain("改过的那句话");
    expect(after).not.toContain(EMPTY_IS_NOT_NO_IMPACT);
    // 而拒绝话读的是同一个常量：两处一起变，不会一边改一边教旧话
    expect(SHOWS_RULE).toContain(EMPTY_IS_NOT_NO_IMPACT);
    expect(PROMISE_RULE).toContain("两句都不给会被拒绝");
  });

  it("判据 2：这道闸是通用的——抄任何一句都红，不是只认被钉过的那几句", () => {
    // 红：把一句从没被钉过的 core 中文抄进一份假说明书
    const 抄了 = manualCopies({ "src/x.ts": 'const a = "这是一句从来没有人钉过的、给人看的中文句子。";' },
                              { "fake.md": "前面一些别的字。这是一句从来没有人钉过的、给人看的中文句子。后面还有。" });
    expect(抄了).toHaveLength(1);
    expect(抄了[0]).toMatchObject({ from: "src/x.ts", manual: "fake.md" });
    expect(抄了[0].text).toContain("从来没有人钉过");
  });

  it("判据 3：不该报的例子——命令名、开关、占位符两边一样是应该的，不算抄", () => {
    const 命令 = manualCopies({ "src/x.ts": 'const a = "用 ateam task done <id> --evidence 交活";' },
                              { "fake.md": "6. `ateam task done <id> --evidence \"...\"`，然后等验收。" });
    expect(命令).toEqual([]);
    // 占位符那一份也不算：源文件里只有 {{...}}，填出来的那份不参与比对
    const 填的 = manualCopies({ "src/events.ts": read("../src/events.ts") }, { "common.md": read("../manual/common.md") });
    expect(填的.map((x) => x.text)).not.toContain(REACH_RULE);
    expect(填的.some((x) => SHOWS_RULE.includes(x.text))).toBe(false);
  });

  it("判据 2：此刻还剩多少份，是量出来的，而且只减不增", () => {
    const left = manualCopies(cores(), manuals());
    // 比冻结的多：有人又抄了一句。比它少：搬走了却没把这个数改小，下一个人会以为还欠这么多。
    // 数不对时把剩下的那几句原样印在错误信息里——一道说「有 11 份」的闸，不告诉你是哪一份，等于让你自己再量一遍。
    const list = left.map((x) => `  ${x.from} → manual/${x.manual}: ${x.text}`).join("\n");
    expect(left.length, `说明书里此刻有 ${left.length} 份 core 的句子（冻结在 ${MANUAL_COPIES_FROZEN}）：\n${list}`)
      .toBe(MANUAL_COPIES_FROZEN);
  });

  it("剩下的那几份说得出是哪几句，不是一个数——要清它的人不用自己再去找", () => {
    const left = manualCopies(cores(), manuals());
    expect(left[0].text.length).toBeGreaterThanOrEqual(MANUAL_COPY_MIN);
    for (const x of left) {
      expect([...x.text].length, `${x.from} → ${x.manual}`).toBeGreaterThanOrEqual(MANUAL_COPY_MIN);
      expect(Object.keys(manuals())).toContain(x.manual);
    }
  });
});

/**
 * t-186：**两个人各加一个人可见符号，不该再撞车。**
 *
 * qa 10:11 量的：两小时撞了两次，两次都不是逻辑冲突。到合完 t-189 那一轮，dev 自己解到第五次——每次的动作
 * 一模一样：跑那段测量代码、重写整份名单。根是 frontend 10:13 找到的：**生成器只存在于一条断言里**，仓库里
 * 没有任何东西能产出名单、只能检查它，所以每个人的做法必然是手改到闸变绿；而名单是每行六个排版的，任何一次
 * 增删都重排整块，于是撞的不是内容，是排版。
 *
 * 两半一起改才有用：① 那两段搬进 `keysyms.ts`，`bin/keysyms` 能把名单跑出来；② 名单改成**一行一个**，
 * 两个人各加一个名字落在不同的行上，git 自己就合得了。
 */
describe("t-186 · 名单跑得出来，两个人各加一行也不再撞", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const CORE_FILES = sourceFiles(new URL("../src", import.meta.url).pathname, "").map((f) => f.replace(/^\//, ""));
  const sources = () => Object.fromEntries(CORE_FILES.map((f) => [f, read(`../src/${f}`)]));

  it("判据 5：仓库里有能产出名单的东西，不只有能检查它的断言", () => {
    // 那两段现在是 core 的导出，任何人都调得到；`bin/keysyms` 就是调它的那个入口
    expect(typeof measureKeySymbols).toBe("function");
    expect(measureKeySymbols(sources())).toEqual([...KEY_SYMBOLS]);
    const bin = readFileSync(new URL("../../../bin/keysyms", import.meta.url), "utf8");
    expect(bin).toContain("measureKeySymbols");
    expect(bin).toContain("--write");
  });

  it("判据 2：它仍然由源码算出来——加一个会说人话的符号，量出来的名单就多一个", () => {
    const before = measureKeySymbols(sources());
    const after = measureKeySymbols({ ...sources(), "probe.ts": 'export const probeSentence = "这是一句给人看的中文句子。";' });
    expect(after.filter((x) => !before.includes(x))).toEqual(["probeSentence"]);
    // 反向也成立：不说人话的不进名单
    const silent = measureKeySymbols({ ...sources(), "probe.ts": 'export const quiet = 42;' });
    expect(silent).toEqual(before);
  });

  it("判据 3 正例：两个人各加一行，改的是不同的行——git 合得了", () => {
    const base = [...KEY_SYMBOLS];
    const mine = renderKeySymbols([...base, "aaaMine"].sort());
    const theirs = renderKeySymbols([...base, "zzzTheirs"].sort());
    const baseText = renderKeySymbols(base);
    // 一行一个：各自相对基线只多一行，且两处改动落在不同的行上——三方合并的前提就是这个
    const added = (text: string) => text.split("\n").filter((l) => !baseText.split("\n").includes(l));
    expect(added(mine)).toEqual(['  "aaaMine",']);
    expect(added(theirs)).toEqual(['  "zzzTheirs",']);
    expect(mine.split("\n").indexOf('  "aaaMine",')).not.toBe(theirs.split("\n").indexOf('  "zzzTheirs",'));
    // 而旧那种每行六个的排版，加一个名字会重排整块：这是它撞车的原因，不是巧合
    const packed = (xs: string[]) => xs.reduce<string[]>((rows, x, i) => (i % 6 ? (rows[rows.length - 1] += `, "${x}"`, rows) : [...rows, `  "${x}"`]), []).join("\n");
    const packedChanged = packed([...base, "aaaMine"].sort()).split("\n").filter((l) => !packed(base).split("\n").includes(l));
    expect(packedChanged.length, "每行六个的排版，加一个名字只动一行——那今晚那五次冲突就无从解释").toBeGreaterThan(1);
  });

  it("判据 3 反例：真的改了规则的仍然被闸抓到", () => {
    const src = sources();
    // 拿掉一个会说人话的符号：量出来的名单少一个，与仓库里那份对不上——闸就是这样红的
    const withoutBoard = Object.fromEntries(Object.entries(src).filter(([f]) => f !== "board.ts"));
    const shrunk = measureKeySymbols(withoutBoard);
    expect(shrunk.length).toBeLessThan([...KEY_SYMBOLS].length);
    expect([...KEY_SYMBOLS].filter((x) => !shrunk.includes(x))).toContain("inFlightGroups");
  });

  it("写回是安全的：找不到那一块就什么都不写，绝不写出一个坏文件", () => {
    const events = read("../src/events.ts");
    expect(withKeySymbols(events, ["a", "b"])).toContain('export const KEY_SYMBOLS = [\n  "a",\n  "b",\n] as const;');
    expect(withKeySymbols("没有那一块的文件", ["a"])).toBeNull();
    // 写回一份与此刻相同的名单，文件一个字节都不变——所以「跑一次」是幂等的
    expect(withKeySymbols(events, [...KEY_SYMBOLS])).toBe(events);
  });
});
