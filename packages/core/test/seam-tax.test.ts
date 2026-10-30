/**
 * t-280：**一条走不动的 claim 向所有人收税。** t-248 `09-13T00:49` claim 时声明了整个 `packages/server/test`
 * 目录，它实际只动了 `packages/server/src/html.ts` 与 `packages/server/test/criteria-added.test.ts`；此后任何
 * 一件在那个目录下动任何文件的活都与它撞一条。
 *
 * **这份名单数的是哪个集合：`isDirOnlySeam(t-248 的声明, 对方的声明)` 为真的那些对。**
 * 那是一个能跑的判据（`reduce.ts`），不是这段话里的一句形容：两边的声明真的撞上了，而两边没有任何同名文件。
 * 下面第一条用例把名单里每一对都喂给它——**加一条不属于这个集合的进来，那条当场红**，不必谁去改这段话。
 *
 * **这里不写条数，也不列名字**（t-289 判据 6②）：此前这段话里同时活着四个数（`SIX` 这个常量名、条目数、
 * 「真的挡人的 6 条」那句、以及一句「第九条」的行内注释），**每个数都对，分母不同，而它们挤在一起**——
 * 一个数写在散文里，下一条进来就过期，改名只把今天的数写对。**所以数由代码现算，散文只说它数的是什么。**
 * 四个数各自的分母、以及 09-19 按声明现量的那次（`t-248` 的 15 个接缝对手里，纯目录的与指名了同一文件的），
 * 记在日志里 t-288 与 t-289 的 note 上，不复制到这里来——**复制一份就是再造一个会过期的数。**
 *
 * 正反两侧：
 * · 正 —— 名单里每一对此刻都是 `light` + `contained`，谁都不再被挡，而牌桌那一格照旧看得见它们；
 * · 反 —— **t-242 不在这个集合里**：它与 t-248 都指名了 `packages/server/src/html.ts`，
 *   把目录声明整个删掉这条接缝照样成立（pm `09-15T15:06` 的裁词也是「真的，但不冲突」）。它照旧挡。
 * · 反之二 —— **唯一被写成 `verdict=real` 的纯目录接缝是 t-248+t-271**，而它的价值不在挡 `done`，
 *   在裁词最后那句「合并义务同前：后落地的是 t-248」。合并义务那条路走的是 `seamcheck`，它不看 `light`
 *   ——钉在 `packages/cli/test/seam-tax-merge.test.ts`。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, openSeamsFor, seamId, isDirOnlySeam, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const NOW = new Date("2026-09-16T03:30:00.000Z");

/** t-248 `09-13T00:49` claim 的那五条，逐字。 */
const T248 = ["packages/server/src/html.ts", "packages/server/src/html.ts#taskDetail", "packages/server/src/i18n.ts",
  "packages/server/test", "packages/server/test/criteria-added.test.ts"];

/** 两件在途的任务，两个不同的人（t-248 是 frontend 的，其余是 dev 的，所以「同主自动放行」那条路用不上）。 */
async function pair(theirs: string[], mine: string[]) {
  const s = new MemoryStore();
  const put = (e: NewEvent) => append(s, e, { human: HUMAN, now: NOW });
  for (const [id, who, touches] of [["t-248", "frontend", theirs], ["t-x", "dev", mine]] as const) {
    await put({ kind: "task", op: "create", actor: "pm", task: id, title: "一件", criteria: ["x"], no_human_impact: true });
    await put({ kind: "task", op: "claim", actor: who, task: id, touches: [...touches] });
  }
  const st = reduce(await s.read(), NOW);
  const seam = st.seams.get(seamId("t-248", "t-x"))!;
  return { st, seam, blocks: openSeamsFor(st, "t-x").length > 0, b: board(st, HUMAN, NOW) };   // seam 取自 state：牌桌那两格分家不影响它
}

/**
 * 同源的那些，各自当时逐字的声明（只留与判断有关的那几条，来源是日志里的 claim / done 事件）。
 * **名字里没有数字**（t-289 判据 6②）：加一条、去一条都不必改这里的任何字，下面的用例现算。
 */
const DIR_ONLY: [string, string[]][] = [
  ["t-233", ["packages/core/src/rules.ts", "packages/cli/src/main.ts", "packages/server/src/app.ts", "packages/server/test/rejected-class.test.ts"]],
  ["t-237", ["packages/core/src/board.ts", "packages/core/src/events.ts", "packages/server/test/gate-honesty.test.ts"]],
  ["t-250", ["packages/core/src/store.ts", "packages/server/src/sqlite-store.ts", "packages/server/test/write-cost.test.ts", "POST /events"]],
  ["t-271", ["packages/server/test/owed-endpoint.test.ts"]],
  ["t-257", ["packages/core/src/pull.ts", "packages/server/src/app.ts", "packages/server/test/plain-pull-signal.test.ts", "packages/server/test/cli-sha-card.test.ts"]],
  ["t-279", ["packages/core/src/board.ts", "packages/cli/src/format.ts", "packages/core/test/stalled.test.ts", "packages/server/test/stalled-not-on-page.test.ts"]],
  ["t-249", ["packages/server/src/app.ts", "packages/server/src/health.ts", "packages/server/test/health.test.ts", "packages/server/test/html.test.ts"]],
  ["t-278", ["packages/cli/src/fixture.ts", "packages/core/src/build.ts", "packages/core/src/ulid.ts", "packages/server/test/fixture-parity.test.ts", "packages/server/test/cli-sha-card.test.ts"]],
  ["t-280", ["packages/cli/src/seamcheck.ts", "packages/core/src/reduce.ts", "packages/core/test/seam-tax.test.ts", "packages/server/test/seam-dir-not-on-page.test.ts"]],
  // t-288：**09-19T04:19 我自己撞的那条**，这一族第一条发生在 t-280 落地之后的。
  // 它被挡住是因为**服务端跑的是 3e50e5b**（不含 t-280）——在这棵树上它与其余九条同形，照旧只记不挡。
  // 收进来不是为了多一条，是为了让名单里有一条「修好之后仍然发生过」的，免得下次有人拿它当反证。
  ["t-287", ["packages/core/src/events.ts", "packages/core/src/rules.ts", "packages/core/src/verifyflow.ts",
    "packages/cli/src/precheck.ts", "packages/server/test/instruction-ruler.test.ts"]],
];

describe("t-280 · 一条目录声明收的税", () => {
  // t-289 判据 6③：**加一条进来而不改别处，不会让任何数与实际不符**——因为这里一个数都没有硬编。
  it("名单里每一对都真的属于这个集合：判据是代码，不是文件头那段话", () => {
    for (const [who, touches] of DIR_ONLY) {
      expect(isDirOnlySeam(T248, touches), `${who} 不属于「只撞在目录上」那一族，不该在这份名单里`).toBe(true);
    }
    expect(new Set(DIR_ONLY.map(([who]) => who)).size, "名单里不许有重复").toBe(DIR_ONLY.length);
  });

  it("反：把一条不属于这个集合的加进来，上面那条就红——t-242 与 t-248 指名了同一个文件", () => {
    const t242 = ["packages/core/src/board.ts", "packages/server/src/html.ts", "packages/server/src/html.ts#renderBoard"];
    expect(isDirOnlySeam(T248, t242), "它是真接缝，不是目录撞出来的").toBe(false);
    // 而「不撞」与「只撞在目录上」也分得开：完全无关的声明同样不属于这个集合
    expect(isDirOnlySeam(T248, ["packages/cli/src/format.ts"])).toBe(false);
  });

  for (const [who, touches] of DIR_ONLY) {
    it(`正：${who} —— 与 t-248 只在 packages/server/test 这个目录上相撞，记下来、不再挡人`, async () => {
      const { seam, blocks, b } = await pair(T248, touches);
      expect(seam, "接缝还在——改的是挡不挡，不是记不记").toBeTruthy();
      expect(seam.overlap).toContain("packages/server/test");
      expect(seam.light, `${who} 改前是「不轻」，要人裁一次`).toBe(true);
      expect(blocks, `${who} 的 done 不该再被这条挡住`).toBe(false);
      // 牌桌照旧看得见它，只是在自己那一格里；`seams` 里一条都没有，因为人那一页读的是那一份
      expect(b.contained_seams.find((x) => x.id === seam.id)).toMatchObject({ light: true, open: false, contained: true });
      expect(b.seams.find((x) => x.id === seam.id)).toBeUndefined();
    });
  }

  it("反：t-242 与 t-248 都指名了 packages/server/src/html.ts —— 照旧挡，这一条不是税", async () => {
    const { seam, blocks } = await pair(T248, ["packages/core/src/board.ts", "packages/server/src/html.ts",
      "packages/server/src/html.ts#renderBoard", "packages/server/test/live-section.test.ts"]);
    expect(seam.light, "两侧真的指名了同一个文件，这条与目录声明无关").toBeUndefined();
    expect(blocks, "真接缝要照旧挡住 done").toBe(true);
    expect(seam.overlap).toContain("packages/server/src/html.ts");
  });

  it("反：把目录声明从 t-248 那边拿掉，t-242 那条照样在、照样挡——证明它不是目录撞出来的", async () => {
    const withoutDir = T248.filter((t) => t !== "packages/server/test");
    const { seam, blocks } = await pair(withoutDir, ["packages/server/src/html.ts", "packages/server/src/html.ts#renderBoard"]);
    expect(seam).toBeTruthy();
    expect(blocks).toBe(true);
  });

  it("反：把目录声明拿掉，这一族就一条都不存在——它们确实只是目录撞出来的", async () => {
    const withoutDir = T248.filter((t) => t !== "packages/server/test");
    for (const [who, touches] of DIR_ONLY) {
      const { st } = await pair(withoutDir, touches);
      expect(st.seams.get(seamId("t-248", "t-x")), `${who}`).toBeUndefined();
    }
  });

  it("两个人都声明了同一个目录：那是同一句话，照旧挡", async () => {
    const { seam, blocks } = await pair(T248, ["packages/server/test", "packages/server/test/theirs.test.ts"]);
    expect(seam.light).toBeUndefined();
    expect(blocks).toBe(true);
  });
});
