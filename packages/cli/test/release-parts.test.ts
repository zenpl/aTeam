/**
 * t-261：**`ateam release` 也是一条命令发多件事，而它那 7 处走的是裸 `emit`，不是 `sendAll`。**
 *
 * 起因是 dev 13:13 核 t-260 判据 4 时点名的第三条路（前两处：t-228 的 `done`、t-232 的 `verify`）。
 * 真正会发两件的执行路径有两条，我逐条追过 `release.ts`：
 *   · `--rollback` 成功：**481 note ＋ 482 reading**（判据 2 问的就是这一对）
 *   · `--deploy --anyway`：**409 note**，随后按结果落 417／424／429 之一
 *
 * 判据 3 要先红：主件成、附带件被拒时，终端上要两行各一件、退出码按整体算。
 */
import { describe, it, expect } from "vitest";
import { rollback, DEPLOY_KEY } from "../src/release.js";
import { partSender, releaseEmitters } from "../src/send.js";
import { ClientError } from "../src/client.js";
import { PART_NAMES, EXIT_PARTIAL, type Board } from "@ateam/core";

/**
 * 一块**够 rollback 真跑到那一对**的板：开了团队部署、dev 在名单里且自报过 production、
 * 生产头是 bbbbbbb2222，而 aaaaaaa1111 上过线（所以它是合法的回滚目标）。
 * 第一版我随手拼了个板，红在一个 `TypeError` 上——**红对了地方不等于红对了原因**，那不算证据。
 */
const board = (): Board => ({
  readings: [{ valid: true, surface: "project", key: DEPLOY_KEY, value: { branch: "production", by: ["dev"] } }],
  presence: [{ actor: "dev", push: "production" }],
  live: { deploys: ["aaaaaaa1111", "bbbbbbb2222"], deployed_sha: "bbbbbbb2222" },
  release: { deployed_sha: "bbbbbbb2222" }, seams: [], tasks: {},
} as unknown as Board);

/**
 * 按 `main.ts` 真正的接法造 deps：两个回调从 `releaseEmitters` 来，底下是真的 `partSender`。
 * **修之前那两个回调是裸 `emit`，抛出来就穿过 `rollback`**；本件的修就在这一层，所以用例也钉这一层。
 */
function deps(readingThrows: boolean) {
  const printed: string[] = [], sent: string[] = [];
  const parts = partSender<{ kind: string; key?: string }>(async (e) => {
    sent.push(`${e.kind}${e.key ? `:${e.key}` : ""}`);
    if (readingThrows && e.kind === "reading") throw new ClientError(409, { error: "rejected", rule: "reading", message: "shape 不合" });
    return { id: "01A", line: `01A  ${e.kind}` };
  }, (l) => printed.push(l), () => {});
  const build = {
    reading: (key: string, value: unknown, extra: { surface: string }) => ({ kind: "reading", key, value, surface: extra.surface }),
    note: (body: string) => ({ kind: "note", body }),
  };
  return {
    printed, sent, parts,
    d: {
      me: "dev", anyway: undefined as string | undefined, hasCredential: true,
      git: {
        resolve: (x: string) => x, remoteTip: () => "bbbbbbb2222", treeOf: () => "tree1",
        commitTree: () => "ccccccc3333", push: () => null, isShallow: () => false,
      } as never,
      ...releaseEmitters(parts.one, build as never),
      print: (l: string) => printed.push(l),
    },
  };
}

describe("t-261 · release 一条命令发多件", () => {
  it("rollback 成功那一对：note 落了、reading 被拒——两件各自报，命令不掀翻", async () => {
    const { d, printed, sent, parts } = deps(true);
    // 修之前：那条 reading 抛出来穿过 rollback，整条命令带着 `Error: shape 不合` 死掉——
    // note 已经落了却没有任何一行说它成了，也没有一行说没落下的是 reading。
    await expect(rollback(board(), "aaaaaaa1111", d as never)).resolves.toBeDefined();
    expect(sent).toEqual(["note", "reading:deployed.sha"]);     // 两件都试过，顺序是它本来的顺序
    const all = printed.join("\n");
    expect(all).toContain("01A  note");                          // 成的那件有自己的一行
    expect(all).toContain(PART_NAMES.releaseReading("deployed.sha"));   // 拒的那件说得出是哪一件
    expect(all).toContain("REJECTED (reading)");                 // 并说得出是哪条规则
    const t = parts.tally();
    expect(t).toMatchObject({ ok: 1, bad: 1, exit: EXIT_PARTIAL });     // 退出码按整体算，不是最后一件的
    expect(t.failed[0].what).toBe(PART_NAMES.releaseReading("deployed.sha"));
  });

  it("两件都成：一条不少，退出码 0", async () => {
    const { d, sent, parts } = deps(false);
    await expect(rollback(board(), "aaaaaaa1111", d as never)).resolves.toBeDefined();
    expect(sent).toEqual(["note", "reading:deployed.sha"]);
    expect(parts.tally()).toMatchObject({ ok: 2, bad: 0, exit: 0 });
  });

  /**
   * 判据 2：**481-482 那一对是两件，不是一件。** 判的依据是后果不同——note 记的是这次回滚的来龙去脉，
   * reading 落的是 `production:deployed.sha` 这条**别人会引用的事实**。只落了 note 而 reading 没落，
   * 世界的状态与日志说的就对不上（生产已经回滚了，而牌桌还指着旧 sha）。两件各自报，才看得出缺的是哪一半。
   */
  it("判据 2：那一对按两件算——只落一件时，看得出缺的是哪一半", async () => {
    const { d, parts } = deps(true);
    await rollback(board(), "aaaaaaa1111", d as never);
    const t = parts.tally();
    expect(t.ok).toBe(1);
    expect(t.bad).toBe(1);
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0].what).toContain("deployed.sha");   // 缺的正是那条事实
  });
});
