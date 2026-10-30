/**
 * t-281：**`sync` 第一行给的出路少了一条，而少掉的那条是「已签收、无动作可办」那一类唯一诚实的出路。**
 *
 * 真实的一条（pm 09-17 04:4x 亲历）：`01M29YRV80QBCKVADVBVD0PQ5G` 09-12 04:43:08 就被 ack 过（48.6 秒），
 * 此后五天每次 sync 都以「最久」的身份出现在它第一行；按提示跑 `ateam ack` 被当场拒（already acked），
 * 而一条 `--refs` 它的 note 把那个数从 179 降到 178。**两个数我自己重放日志核过，没有抄。**
 *
 * 本件只改那一句话。`owedTo`／`didAct`／`reach` 一个字没动——下面第三、四条就是钉这一点的：
 * 一条光秃秃的 `ack` 照旧不算「办了」（t-193），而引用照旧算。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, owedNow, owedSentences, owedThirdWay, DECLINE_PREFIX, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-17T05:00:00.000Z");
const NOW = new Date(T0 + 5 * 24 * 3600_000);   // 五天后，与真实那条同一个量级

/** pm 收到一条指令、48 秒就 ack 了，此后什么都没做——因为它没有动作可做。 */
async function world(extra?: (emit: (e: NewEvent, at: Date) => Promise<unknown>, id: string) => Promise<unknown>) {
  const s = new MemoryStore();
  const emit = (e: NewEvent, at: Date) => append(s, e, { human: HUMAN, now: at });
  const sent = await emit({ kind: "instruction", actor: "qa", to: "pm", body: "补一个树名，你那处引用我更正了，结论不变",
    ack_by: new Date(T0 + 15 * 60_000).toISOString() }, new Date(T0));
  await emit({ kind: "ack", actor: "pm", of: sent.id }, new Date(T0 + 48_584));
  if (extra) await extra(emit, sent.id);
  const st = reduce(await s.read(), NOW);
  return { st, id: sent.id, owed: owedNow(st, "pm"), lines: owedSentences(owedNow(st, "pm"), NOW) };
}

describe("t-281 · 那一行要说出系统实际认的出路", () => {
  it("正：ack 过、没别的动作 ⇒ 它仍挂在「读过还没动」里，而那句话现在说得出第三条路，并带得出可以照抄的命令", async () => {
    const { id, owed, lines } = await world();
    expect(owed.untouched.map((x) => x.instruction), "t-193：光 ack 不算办了，这条没被本件动过").toContain(id);
    const line = lines.find((l) => l.includes("读过还没动"))!;
    expect(line, "改前这一句只给两条出路").toContain("ateam note --refs");
    expect(line, "命令里要带得出是哪一条，能照抄").toContain(id);
    expect(line).toContain(owedThirdWay(id));
  });

  it("正：照那句话做一次，它就从这一栏里消失——出路是真的，不是话术", async () => {
    const { id, owed } = await world(async (emit, sent) => {
      await emit({ kind: "note", actor: "pm", body: "它更正的是自己的一处引用，结论不变，我这边没有要改的动作", refs: [sent] }, new Date(T0 + 5 * 24 * 3600_000 - 60_000));
    });
    expect(owed.untouched.map((x) => x.instruction), "引用之后它了结了").not.toContain(id);
  });

  it("反：「不办」照旧在，而且不是唯一的出路——它不该被摆在最省事的位置", async () => {
    const { lines, id } = await world();
    const line = lines.find((l) => l.includes("读过还没动"))!;
    expect(line, "pd 原来那半句一个字没动").toContain(`「${DECLINE_PREFIX}原因」`);
    expect(line.indexOf(DECLINE_PREFIX), "第三条路排在「不办」之后，不抢它的位置").toBeLessThan(line.indexOf("ateam note --refs"));
    expect(line).toContain(id);
  });

  it("反：判据 3 那条禁令——判定本身没被放宽：一条别人发的、与它无关的引用不算它办了", async () => {
    const { id, owed } = await world(async (emit, sent) => {
      await emit({ kind: "note", actor: "qa", body: `我自己再提一次 ${sent}`, refs: [sent] }, new Date(T0 + 3600_000));
    });
    expect(owed.untouched.map((x) => x.instruction), "引用要出自收件人本人才算数").toContain(id);
  });
});
