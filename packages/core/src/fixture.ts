/**
 * t-062: one sample log with everything a verifier keeps needing: an instruction and its delivery, cursors, a decision,
 * and a task that went through two rounds. Built with the Builder, so it is exactly what the server would have written.
 */
import { Builder, type BuilderOptions } from "./build.js";
import type { Log } from "./events.js";

export async function sampleBuilder(opts: BuilderOptions = {}): Promise<Builder> {
  const b = new Builder({ stepMs: 60_000, ...opts });
  await b.reading("pm", "focus", "S1 开工：牌桌显示部署的版本", { surface: "team" });
  await b.task.create("pm", "t-1", "牌桌显示部署的版本", ["GET /health 返回 {ok, sha}", "牌桌「线上」一行显示 sha"]);
  const ask = await b.tell("pm", "dev", "先做 t-1，claim 时把 touches 写宽", { ackByMs: 15 * 60_000 });
  await b.pull("dev"); // delivered to dev; dev's cursor now points at the instruction
  await b.ack("dev", ask.id);
  await b.task.claim("dev", "t-1", ["packages/server/src/app.ts#health", "packages/server/src/html.ts#live"]);
  await b.pull("qa");
  await b.task.done("dev", "t-1", { evidence: "abc1234: /health 本地返回 sha", shows: "线上牌桌第一行是版本号" });
  await b.task.verify("qa", "t-1", "repo", false, { evidence: "判据 2 未满足：牌桌没有「线上」一行" });
  await b.pull("dev");
  await b.task.reopen("dev", "t-1", "补牌桌那一行");
  await b.task.done("dev", "t-1", { evidence: "def5678: 牌桌「线上」一行显示 sha", shows: "线上牌桌第一行是版本号" });
  await b.task.verify("qa", "t-1", "repo", true, { evidence: "本地起服务，两条判据都看到了" });
  const q = await b.tell("pd", b.human, "牌桌的「线上」放首屏还是挖层？A 首屏；B 挖层。默认 A。", { options: ["A", "B"], default: "A", intent: "ask", ackByMs: 24 * 3600_000 });
  await b.ack(b.human, q.id);
  await b.note(b.human, `decision: ${q.id} -> A`, { decision: true, decides: { of: q.id, option: "A" }, refs: [q.id] });
  await b.note("dev", "friction: 想造一份样本日志时没有入口，只能手写 JSON", { task: "t-1" });
  await b.pull("pm");
  return b;
}

/** The sample as a Log: events, cursors, deliveries — what `ateam fixture` prints. */
export async function sampleLog(opts: BuilderOptions = {}): Promise<Log> {
  return (await sampleBuilder(opts)).log();
}
