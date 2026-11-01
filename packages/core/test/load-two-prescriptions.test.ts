/**
 * t-349 · **负载陷阱有两种成因，两张处方。**
 *
 * 出处是 pd 支 `docs/product.md` 的 T13：「职责太杂就拆，职责包合理但活太多就扩——再起一个同职责包的角色
 * （backend-2），任务按 claim 分流」。此前这一格两种成因共用「把它持有的、能改成规则或服务的职责先拿走」一句，
 * 而今晚真实的成因是后一种：dev 一个人收了过半的指令，职责包（R5 R9 R11）本身并不杂——**那张处方对它是错的**。
 *
 * 分档用的是数，不是形容词，而且**两处叫的是同一个函数**（`packedHeavy`）：声明那一处与运行时那一处各写一遍的话，
 * 「同一把尺」就只是一条断言在说它们相等（t-286 那一族的教训）。
 *
 * 判据②里的「杂」此刻量不出来（职责只有 id、name、holder，没有分组），所以这里只判「多」——这一处 dev 已交回 pm，
 * 写在 `packedHeavy` 的注释与 t-349 的证据里，不在这儿假装它判了。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, allocation, runtimeAllocation, staticAllocation, packedHeavy, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const min = (n: number) => n * 60_000;
/** 「拆」那两句（pd 的原话，一字不改）：声明那一处与运行时那一处各一句。 */
const 拆_静态 = "建议：把能改成规则或服务的职责先拿走。";
const 拆_运行时 = "建议：把它持有的、能改成规则或服务的职责先拿走。";
const 扩 = (who: string) => `建议：它的职责包本身正常，别拆——再起一个同职责包的角色（${who}-2），任务按 claim 分流。`;

function world() {
  const store = new MemoryStore();
  let t = Date.now() - min(120);
  const at = () => new Date(t);
  const emit = (e: NewEvent, plus = min(1)) => { t += plus; return append(store, e, { human: HUMAN, now: at() }); };
  const state = async () => reduce(await store.read(), at());
  const pack = (value: unknown) => emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value });
  const ackBy = () => new Date(at().getTime() + min(60)).toISOString();
  const say = (to: string, body: string, plus?: number) =>
    emit({ kind: "instruction", actor: "qa", to, body, ack_by: ackBy() }, plus);
  const load = async () => (allocation(await state(), at(), HUMAN)).find((w) => w.pattern === "负载陷阱");
  return { emit, at, state, pack, say, load };
}

describe("t-349 判据③ · 两格方向相反", () => {
  it("一人担五项职责、活不多 ⇒ 只许印「拆」", async () => {
    const w = world();
    await w.pack({ lead: ["R1", "R3", "R4", "R8", "R13"], dev: ["R5"], qa: ["R6"] });
    const got = await w.load();
    expect(got!.evidence).toEqual(["lead 持有 5 项职责（R1 R3 R4 R8 R13），其他角色中位数 1 项"]);
    expect(got!.hint).toBe(`${got!.evidence[0]}。${拆_静态}`);
    expect(got!.hint, "活不多的那一格不许印「扩」").not.toContain("别拆");
    expect(got!.hint).not.toContain("-2");
  });

  it("职责包正常、指令流入过半 ⇒ 只许印「扩」（今晚 dev 那个局）", async () => {
    const w = world();
    for (let i = 0; i < 8; i++) await w.say("dev", `第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    for (let i = 0; i < 3; i++) await w.say("pm", `另一件 ${i}：${"壬癸子"[i]}`, min(12));
    const got = await w.load();
    expect(got!.evidence).toEqual(["dev 收到 73% 的指令（8/11）"]);
    expect(got!.hint).toBe(`dev 收到 73% 的指令（8/11）。${扩("dev")}`);
    expect(got!.hint, "包正常的那一格不许印「拿走职责」").not.toContain("拿走");
  });
});

describe("t-349 判据①④ · 处方按被点名那个角色的职责包选，一句话不盖两种处境", () => {
  it("包太杂的那个角色，哪怕是运行时指标点出来的，仍然印「拆」", async () => {
    const w = world();
    for (let i = 0; i < 8; i++) await w.say("pm", `第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    for (let i = 0; i < 3; i++) await w.say("dev", `另一件 ${i}：${"壬癸子"[i]}`, min(12));
    const got = await w.load();   // 默认职责包里 pm 持有六项，所以它是「多」那一档
    expect(got!.evidence).toEqual(["pm 收到 73% 的指令（8/11）"]);
    expect(got!.hint).toBe(`pm 收到 73% 的指令（8/11）。${拆_运行时}`);
    expect(got!.hint).not.toContain("别拆");
  });

  it("声明那一处与运行时那一处判在同一个角色上时，并成一条，处方仍只有「拆」那一张", async () => {
    const w = world();
    await w.pack({ lead: ["R1", "R3", "R4", "R8", "R13"], dev: ["R5"], qa: ["R6"] });
    for (let i = 0; i < 8; i++) await w.say("lead", `第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    for (let i = 0; i < 3; i++) await w.say("dev", `另一件 ${i}：${"壬癸子"[i]}`, min(12));
    const got = await w.load();
    expect(got!.evidence, "两处各留一条证据").toEqual([
      "lead 持有 5 项职责（R1 R3 R4 R8 R13），其他角色中位数 1 项",
      "lead 收到 73% 的指令（8/11）",
    ]);
    expect(got!.hint, "处方跟着第一条证据，而两处判的是同一把尺，所以不会一条说拆一条说扩").toContain(拆_静态);
    expect(got!.hint).not.toContain("别拆");
  });

  it("自我更正率那一条走同一条规矩：包正常就是「扩」", async () => {
    const w = world();
    const say = (body: string, plus?: number) => w.emit({ kind: "instruction", actor: "pd", to: "pm", body, ack_by: new Date(w.at().getTime() + min(60)).toISOString() }, plus);
    for (let i = 0; i < 8; i++) await say(`第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    for (const second of ["更正：改成寅，我上一条的 sha 写错了", "更正我刚才那条：是 t-2 不是 t-1", "纠正：判据 3 我写反了"]) {
      await say("先按这个做", min(12));
      await say(second, min(1));
    }
    await say("先按那个做", min(12));
    await say("生产已上线 abc1234，这条按新的来", min(1));
    await say("再来一件", min(12));
    await say("另外那件也麻烦你看一下", min(1));
    for (let i = 0; i < 18; i++) await w.say("dev", `修 ${i}`, min(1));   // 稀释流入占比，让更正率那一条成为最响的
    const got = await w.load();
    expect(got!.evidence[0]).toContain("pd 17% 的指令是自己写错后更正的（3/18）");
    expect(got!.hint, "pd 的默认职责包是两项，不杂").toContain(扩("pd"));
  });

  it("最小团队不判「拆」：一人多顶帽子在那里是设计", async () => {
    const w = world();
    await w.pack({ lead: ["R1", "R3", "R4", "R8", "R13"], dev: ["R5", "R9"] });
    for (let i = 0; i < 8; i++) await w.say("lead", `第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    for (let i = 0; i < 3; i++) await w.say("dev", `另一件 ${i}：${"壬癸子"[i]}`, min(12));
    expect(staticAllocation(await w.state()), "声明那一处本来就不判最小团队").toEqual([]);
    const got = await w.load();
    expect(got!.hint, "运行时这一处也不许改口说「拆」").toContain(扩("lead"));
  });
});

describe("t-349 判据② · 判法是数，而且两处叫同一把尺", () => {
  it("packedHeavy 就是那把尺：≥4 项且 ≥ 其他角色中位数两倍，最小团队一律不算", () => {
    const heavy = { lead: ["R1", "R3", "R4", "R8"], dev: ["R5"], qa: ["R6"] };
    expect(packedHeavy(heavy, "lead")).toBe(true);
    expect(packedHeavy(heavy, "dev")).toBe(false);
    expect(packedHeavy({ lead: ["R1", "R3", "R4"], dev: ["R5"], qa: ["R6"] }, "lead"), "三项不算多").toBe(false);
    expect(packedHeavy({ a: ["R1", "R3", "R4", "R8"], b: ["R5", "R6"], c: ["R7", "R9"] }, "a"), "正好两倍，判据是「≥」").toBe(true);
    expect(packedHeavy({ a: ["R1", "R3", "R4", "R8"], b: ["R5", "R6", "R7"], c: ["R9", "R10", "R11"] }, "a"), "不到两倍").toBe(false);
    expect(packedHeavy({ lead: ["R1", "R3", "R4", "R8", "R13"], dev: ["R5"] }, "lead"), "最小团队").toBe(false);
    expect(packedHeavy({ lead: ["R1"] }, "nobody"), "没声明过的角色，答不上来就是 false").toBe(false);
  });

  it("声明那一处与运行时那一处对同一个角色给出同一个答案", async () => {
    const w = world();
    await w.pack({ lead: ["R1", "R3", "R4", "R8", "R13"], dev: ["R5"], qa: ["R6"] });
    const st = await w.state();
    const 静态 = staticAllocation(st).find((x) => x.pattern === "负载陷阱");
    expect(静态!.hint).toContain(拆_静态);
    for (let i = 0; i < 8; i++) await w.say("lead", `第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    for (let i = 0; i < 3; i++) await w.say("dev", `另一件 ${i}：${"壬癸子"[i]}`, min(12));
    const 运行时 = runtimeAllocation(await w.state(), w.at(), HUMAN).find((x) => x.pattern === "负载陷阱");
    expect(运行时!.hint, "同一个角色、同一把尺，所以也是「拆」").toContain(拆_运行时);
  });
});
