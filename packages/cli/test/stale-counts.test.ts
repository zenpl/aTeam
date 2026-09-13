/**
 * t-221：命令行那一侧的同一条规矩。`ateam release` 把三个数并排印出来（`未上线 N 件 · …`），
 * 而它们是某个人某一刻测出来的——**旧了就不印那三个数**，印那句「不知道有多少件在等上线」加它的依据。
 */
import { describe, it, expect } from "vitest";
import { Builder, type Board } from "@ateam/core";
import * as fmt from "../src/format.js";

const SHA = "a".repeat(40);

async function world(after: boolean): Promise<Board> {
  const b = new Builder({ start: Date.now() - 3 * 3600_000, stepMs: 60_000 });
  await b.reading("pm", "roles", ["pm", "dev", "qa"], { surface: "project" });
  await b.task.create("pm", "t-1", "第一件", ["判据"], { no_human_impact: true });
  await b.task.claim("dev", "t-1", ["a.ts"]);
  await b.task.done("dev", "t-1", { evidence: `${SHA.slice(0, 7)} 完成`, no_human_impact: true });
  await b.task.verify("qa", "t-1", "repo", true, { evidence: "跑过了" });
  await b.reading("release", "deployed.sha", SHA, { surface: "production" });
  await b.reading("release", "deployed.tasks", { sha: SHA, contained: ["t-1"], not_contained: [], unmeasured: [], method: "git-ancestor" }, { surface: "production" });
  if (after) {
    await b.task.create("pm", "t-2", "事实之后才做的那一件", ["判据"], { no_human_impact: true });
    await b.task.claim("dev", "t-2", ["b.ts"]);
    await b.task.done("dev", "t-2", { evidence: `${"b".repeat(7)} 完成`, no_human_impact: true });
    await b.task.verify("qa", "t-2", "repo", true, { evidence: "跑过了" });
  }
  return b.board(new Date());
}

describe("t-221 · ateam release：旧了就不印那三个数", () => {
  it("事实还答得了时照旧印三个数", async () => {
    const out = fmt.release(await world(false));
    expect(out).toContain("未上线 0 件");
  });

  it("**事实答不了时一个数都不印**，只说不知道与依据", async () => {
    const out = fmt.release(await world(true));
    expect(out, "陈旧的 0 不许被当成此刻的答案给出去").not.toContain("未上线 0 件");
    expect(out).toContain("不知道有多少件在等上线");
    expect(out).toContain("deployed.tasks");
  });
});
