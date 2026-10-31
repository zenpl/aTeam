/**
 * t-335 判据⑧（形状出自 pm 17:16 的裁定，措辞出自 pd 17:20 的 decision `01M69FMZ25DNVK689TG4JS2JFW` ②，照抄）：
 * **给 `--default` 时必须同时声明「到期之后这一项由谁执行」，而答案是收件人就拒。**
 *
 * 真样本，也是 pm 要的自证：pm 14:46:58 那张「要不要起一个 qa？验收停了 10 件」，默认是「起一个 qa」，
 * 15:02:27 默认替人定了——而**起一个会话只有他做得到**，于是日志里写着「已定」，没有一个在场的人能执行它，
 * 卡又不在那一页上了（pd ㉗，`3a40fe9` 的 `docs/product.md:292`）。诚实填写时那张卡的执行者只能是 `human`，
 * 所以它在这道闸下必须被拒。
 *
 * 标志名与那个「无需执行」的值归 dev（pm 17:18／pd 17:21：标志是节点键入的，不是人读的输出）：
 * `--default-doer`，闭集是 `nothing` ∪ 本项目的角色名。pd 的两条建议都照了，见 `DEFAULT_DOER_NOTHING` 那段。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, Rejected, DEFAULT_DOER_NOTHING, DEFAULT_DOER_AMBIGUOUS, DEFAULT_DOER_MISSING, DEFAULT_DOER_WITHOUT_DEFAULT, defaultDoerIsRecipient, PD_PLACEHOLDER, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-31T14:46:58.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, m = 0) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "pd"] }, -10);
  return { s, put };
}
/** pm 那张真卡的形状，`default_doer` 由各格给。 */
const theCard = (doer?: string, extra: Partial<Record<string, unknown>> = {}): NewEvent => ({
  kind: "instruction", actor: "pm", to: HUMAN, intent: "ask",
  body: "要不要起一个 qa？验收停了 10 件", ack_by: at(15).toISOString(),
  options: ["起一个 qa", "把 R6 暂给 dev"], default: "起一个 qa",
  ...(doer === undefined ? {} : { default_doer: doer }), ...extra,
} as NewEvent);
const refusal = async (p: Promise<unknown>) => await p.then(() => null, (e: unknown) => e as Rejected);

describe("t-335 判据⑧ · 到期之后这一项由谁执行，写 --default 的人要先答", () => {
  it("**自证**：pm 那张真卡（默认「起一个 qa」，执行人只能是 human）⇒ 拒，而且是 pd 定稿那四行", async () => {
    const w = await world();
    const r = await refusal(w.put(theCard(HUMAN)));
    expect(r, "它必须被拒：到期之后这一项只有他做得到").toBeInstanceOf(Rejected);
    expect(r!.rule).toBe("instruction");
    // `Rejected.message` 前面带规则名（`instruction: …`），所以这里 contain 那一整段——**逐字仍然钉住**，
    // 只是不连前缀一起比。顺带：pd 那一句自己以「拒：」开头，于是人读到的是「instruction: 拒：…」，
    // 这一处重复我没有自己改（改 pd 的标点不是我的事），已在 done 的证据里交回去。
    expect(r!.message, "pd 17:20 定稿，照抄不改标点").toContain(defaultDoerIsRecipient("起一个 qa", HUMAN));
    expect((await w.s.read()).events.filter((e) => e.kind === "instruction"), "卡没有落库").toHaveLength(0);
  });

  it("执行人是 nothing（不做／照旧，不需要谁动手）⇒ 过", async () => {
    const w = await world();
    const e = await w.put(theCard(DEFAULT_DOER_NOTHING));
    expect(e.id).toBeTruthy();
  });

  it("执行人是本项目的一个角色（不是收件人）⇒ 过", async () => {
    const w = await world();
    const e = await w.put(theCard("dev"));
    expect(e.id).toBeTruthy();
  });

  it("写成 none / nobody / 无 ⇒ 拒，而且是 pd 定稿那两行（两种读法一个该过一个该拒，不许共用一个词）", async () => {
    for (const word of ["none", "nobody", "无", "None"]) {
      const w = await world();
      const r = await refusal(w.put(theCard(word)));
      expect(r, `${word} 必须被拒`).toBeInstanceOf(Rejected);
      expect(r!.message).toContain(DEFAULT_DOER_AMBIGUOUS);
    }
  });

  it("不在闭集里的值（随手写一个角色名）⇒ 拒，并把此刻的合法取值列出来", async () => {
    const w = await world();
    const r = await refusal(w.put(theCard("frontend")));   // 这个项目的 roles 里没有 frontend
    expect(r).toBeInstanceOf(Rejected);
    expect(r!.message, "合法取值要印出来：闭集的意义就在于它数得出来").toContain(DEFAULT_DOER_NOTHING);
    expect(r!.message).toContain("dev");
    // **这一句的措辞还不是话**：它此刻是占位，定稿归 pd（见本文件头上那段）。闸照旧拒，这一格钉的是「拒」。
    expect(r!.message).toContain(PD_PLACEHOLDER);
  });

  it("带默认却一个字都没说谁执行 ⇒ 拒，pd 17:43 定稿那三行（**不写不等于 nothing**）", async () => {
    const w = await world();
    const r = await refusal(w.put(theCard()));
    expect(r, "原来这样发是过的——pm 那张真卡就是这么发出去的").toBeInstanceOf(Rejected);
    expect(r!.rule).toBe("instruction");
    expect(r!.message).toContain(DEFAULT_DOER_MISSING);
    // pd：最后那一行是这一档的全部意义。「没写」若被当成 nothing 放过，这道闸等于没有，㉗ 原样回来。
    expect(r!.message).toContain("不写不等于 nothing");
    expect((await w.s.read()).events.filter((e) => e.kind === "instruction"), "卡没有落库").toHaveLength(0);
  });

  it("写了执行人却没设默认 ⇒ 也拒，pd 定稿那一句", async () => {
    const w = await world();
    const r = await refusal(w.put(theCard("dev", { default: undefined })));
    expect(r).toBeInstanceOf(Rejected);
    expect(r!.message).toContain(DEFAULT_DOER_WITHOUT_DEFAULT);
  });

  it("**对照**：不设默认的卡，不必声明执行人（这道闸没有把普通的提问一起挡掉）", async () => {
    const w = await world();
    const e = await w.put(theCard(undefined, { default: undefined }));
    expect(e.id).toBeTruthy();
  });

  it("**对照**：不带选项的普通指令，一个字都不用改", async () => {
    const w = await world();
    const e = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "先做这件", ack_by: at(15).toISOString() });
    expect(e.id).toBeTruthy();
  });
});
