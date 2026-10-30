/**
 * t-215：第三种过期的卡——**人写给人的卡，正文里的数和动作会过期而没人在看**。
 *
 * 真样本两个：① release 02:13「37 件已验的没上线，谁来推？」挂 13.5 小时、期间上了 19 批，此刻待上线是 0，
 * 它请人推的 sha 早是生产的祖先；② pd 那张 Q25 的默认支写「明早开工时」，而那个明早已经过去——**而 A 正是
 * 默认那一支**，到点会按它落一条「已执行」。
 *
 * 与已修的两种分清楚：t-202 管「这张卡该不该存在」、t-210 管「服务发的卡正文是不是快照」；**这一件管人写的卡，
 * 正文是自由文本，服务重算不了**，所以出路是发卡人声明条件，不是让服务猜。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, dueDefaults, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (m: number) => new Date(T0 + m * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "release", "qa"] }, -300);
  await put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "babae6d" }, -290);
  return { s, put };
}
const st = async (s: MemoryStore, m = 0) => reduce(await s.read(), at(m), HUMAN);

describe("t-215 判据 1、2 · 一张卡说得出它活着的条件，那条事实一变就被标出来", () => {
  it("声明了条件、条件没变：不标", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "37 件已验的没上线，谁来推？", ack_by: at(600).toISOString(), depends_on: ["production:deployed.sha"] }, -280);
    const s = await st(w.s);
    expect([...s.instructions.values()][0].stale_since).toBeUndefined();
  });

  it("那条事实被 writes 命中：卡被标出来，说得出是哪条事件改的", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "37 件已验的没上线，谁来推？", ack_by: at(600).toISOString(), depends_on: ["production:deployed.sha"] }, -280);
    const push = await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "c83e986", writes: ["production:deployed.sha"] }, -100);
    const s = await st(w.s);
    expect(s.instructions.get(card.id)?.stale_since).toBeTruthy();
    expect(s.instructions.get(card.id)?.stale_by).toBe(push.id);
  });

  it("**卡还在，人还能答**——标出来不是删掉（判据 4；删一张没答的卡是 t-190 定过的错）", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "谁来推？", ack_by: at(600).toISOString(), options: ["A", "B"], default: "B", depends_on: ["production:deployed.sha"] }, -280);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "c83e986", writes: ["production:deployed.sha"] }, -100);
    const b = board(await st(w.s), HUMAN, at(0));
    const row = b.needs_human.find((x) => x.id === card.id)!;
    expect(row).toBeTruthy();                       // 还在牌桌上
    expect(row.stale_since).toBeTruthy();           // 但被标出来了
    expect(row.options).toEqual(["A", "B"]);        // 照旧可以答
  });

  it("没声明条件的卡不受影响——服务不猜（判据 3）", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "谁来推？", ack_by: at(600).toISOString() }, -280);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "c83e986", writes: ["production:deployed.sha"] }, -100);
    expect((await st(w.s)).instructions.get(card.id)?.stale_since).toBeUndefined();
  });
});

describe("t-215 判据 6 · 默认动作本身过期时，不许无声地按默认结掉", () => {
  it("条件被改动过的卡：到期也不落那条「已执行」", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "明早开工时你在别的平台起一个项目", ack_by: at(-10).toISOString(), options: ["A", "B"], default: "A", depends_on: ["production:deployed.sha"] }, -280);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "c83e986", writes: ["production:deployed.sha"] }, -100);
    expect(dueDefaults(await st(w.s), at(0))).toEqual([]);
  });

  it("条件没被动过的卡：到期照常按默认结掉（不许把整条路一起关掉）", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "选一个", ack_by: at(-10).toISOString(), options: ["A", "B"], default: "A", depends_on: ["production:deployed.sha"] }, -280);
    const due = dueDefaults(await st(w.s), at(0));
    expect(due).toHaveLength(1);
    expect((due[0] as { decides?: { option: string } }).decides?.option).toBe("A");
  });

  it("根本没声明条件的卡，行为一字未改", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "选一个", ack_by: at(-10).toISOString(), options: ["A", "B"], default: "A" }, -280);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "c83e986", writes: ["production:deployed.sha"] }, -100);
    expect(dueDefaults(await st(w.s), at(0))).toHaveLength(1);
  });
});

/**
 * 判据 7（pm 16:53 加，收 qa 16:52 的两条建议）：
 * ① **钟点那一路**——Q25 是被「明早」过期的，没有任何 surface:key 变过；
 * ② **后发事件可以给已发的卡补声明**——会按默认结掉的卡此刻 3 条，带 depends_on 的 0 条（qa 16:55 量的），
 *    它们全比这个字段老。**只认卡自己声明过的条件，等于对所有比字段老的卡沉默**，而那批正是挂得最久的。
 */
describe("t-215 判据 7① · 钟点那一路：过了这个时刻，它说的事就不成立了", () => {
  it("valid_until 过了：卡被标出来，且到期不落那条「已执行」", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "明早开工时你在别的平台起一个项目",
      ack_by: at(-10).toISOString(), options: ["A", "B"], default: "A", valid_until: at(-30).toISOString() }, -280);
    const s = await st(w.s);
    const one = [...s.instructions.values()][0];
    expect(one.stale_since).toBeTruthy();
    expect(dueDefaults(s, at(0))).toEqual([]);       // 不许无声按默认结掉
  });

  it("还没到那个时刻：一切照旧，默认照常结掉", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "选一个", ack_by: at(-10).toISOString(),
      options: ["A", "B"], default: "A", valid_until: at(600).toISOString() }, -280);
    const s = await st(w.s);
    expect([...s.instructions.values()][0].stale_since).toBeUndefined();
    expect(dueDefaults(s, at(0))).toHaveLength(1);
  });

  it("**钟点与事实并列，不是二选一**：只声明钟点的卡，没有任何 surface:key 变过也会被标", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "明早", ack_by: at(600).toISOString(), valid_until: at(-30).toISOString() }, -280);
    // 全程没有任何带 writes 的事件
    expect([...(await st(w.s)).instructions.values()][0].stale_since).toBeTruthy();
  });
});

describe("t-215 判据 7② · 给一张已经发出去的卡补声明条件", () => {
  it("卡比字段老、一个条件都没声明过：后发一条 premise 补上钟点 ⇒ 被标出来，默认不再结掉", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "pd", to: HUMAN, body: "明早开工时…", ack_by: at(-10).toISOString(), options: ["A", "B"], default: "A" }, -280);
    expect(dueDefaults(await st(w.s), at(0))).toHaveLength(1);      // 补声明之前：照落
    const p = await w.put({ kind: "premise", actor: "pd", of: old.id, valid_until: at(-30).toISOString() }, -20);
    const s = await st(w.s);
    expect(s.instructions.get(old.id)?.stale_since).toBeTruthy();
    expect(s.instructions.get(old.id)?.premise_by).toBe(p.id);      // 是哪条事件补的，说得出
    expect(dueDefaults(s, at(0))).toEqual([]);                      // 补声明之后：扣住
  });

  it("补声明也能补事实依赖，且**历史不改**——卡的正文一字未动", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "37 件已验的没上线，谁来推？", ack_by: at(600).toISOString() }, -280);
    await w.put({ kind: "premise", actor: "release", of: old.id, depends_on: ["production:deployed.sha"] }, -200);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "c83e986", writes: ["production:deployed.sha"] }, -100);
    const s = await st(w.s);
    expect(s.instructions.get(old.id)?.stale_since).toBeTruthy();
    expect(s.instructions.get(old.id)?.instruction.body).toBe("37 件已验的没上线，谁来推？");   // 正文没被改
    expect(s.instructions.get(old.id)?.instruction.depends_on).toBeUndefined();                 // 原事件也没被改
  });

  it("补声明只加不减：先补事实、再补钟点，两样都在", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "谁来推？", ack_by: at(600).toISOString() }, -280);
    await w.put({ kind: "premise", actor: "release", of: old.id, depends_on: ["production:deployed.sha"] }, -200);
    await w.put({ kind: "premise", actor: "release", of: old.id, valid_until: at(600).toISOString() }, -190);
    const one = (await st(w.s)).instructions.get(old.id)!;
    expect(one.depends_on).toEqual(["production:deployed.sha"]);
    expect(one.valid_until).toBeTruthy();
  });

  it("第三方补不了：只有发卡的人、pm 或 human", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "谁来推？", ack_by: at(600).toISOString() }, -280);
    const err = await w.put({ kind: "premise", actor: "qa", of: old.id, valid_until: at(-30).toISOString() }, -200).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as { rule?: string }).rule).toBe("premise");
  });

  it("什么条件都不带的补声明：形状闸挡下，两个名字都点出来", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "谁来推？", ack_by: at(600).toISOString() }, -280);
    const err = await w.put({ kind: "premise", actor: "release", of: old.id } as NewEvent, -200).catch((e) => e as Error);
    expect((err as { rule?: string }).rule).toBe("shape");
    expect(err.message).toContain("depends_on");
    expect(err.message).toContain("valid_until");
  });

  it("**仍然不删卡**（判据 4，两路都适用）：补声明之后卡还在牌桌上、还能答", async () => {
    const { board } = await import("../src/index.js");
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "release", to: HUMAN, body: "谁来推？", ack_by: at(600).toISOString(), options: ["A", "B"], default: "B" }, -280);
    await w.put({ kind: "premise", actor: "release", of: old.id, valid_until: at(-30).toISOString() }, -200);
    const row = board(await st(w.s), HUMAN, at(0)).needs_human.find((x) => x.id === old.id)!;
    expect(row).toBeTruthy();
    expect(row.stale_since).toBeTruthy();
    expect(row.options).toEqual(["A", "B"]);
  });
});
