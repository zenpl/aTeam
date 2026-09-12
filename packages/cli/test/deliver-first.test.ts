/**
 * t-240：**游标在「拉到」与「被读到」之间推进，watch 一死那一批对这个节点永久消失，而 sync 诚实地说「nothing new」。**
 *
 * frontend 20:07 真撞上：容器重启打死它的 watch，重启后游标已越过它最后看到的那条，那十几条永久消失——
 * **「没有新的」那句话是诚实的，它就是没有新的了。** pm 20:12 宣布本件的那条 tell 自己被这道缝吃掉，20:36 才
 * 被补读到；同批还有 20:18 那条，两条都带 ack_by，都差点变成「到期未 ack」。
 *
 * 判据 7（frontend 20:37 提、pm 采纳）：**判的是收件人拿没拿到，不是服务算没算进某一批。**
 * 所以这里每一条断言问的都是「这个节点此刻还能不能读到它、还能不能据它去 ack」。
 */
import { describe, it, expect } from "vitest";
import { sync, watch, pullBatch, type CursorStore, type Puller, type PullResult } from "../src/loop.js";

const OLD = "01M00000000000000000000000";
const at = (id: string) => ({ id, at: "2026-09-12T21:00:00.000Z", ack_by: "2026-09-12T21:30:00.000Z" });

const store = (init: string | null): CursorStore & { value: string | null; writes: number } => {
  const s = { value: init, writes: 0, read: () => s.value, write: (c: string | null) => { s.value = c; s.writes += 1; } };
  return s;
};

/** 一台只在「你还没确认收到」时重发同一批的服务：真协议就是这样——after 没动，下一次拉到的还是它。 */
function server(batch: { id: string; kind: string; actor: string; to?: string; body?: string; ack_by?: string }[]): Puller & { pulls: number } {
  const p = {
    pulls: 0,
    async pull(after: string | null): Promise<PullResult> {
      p.pulls += 1;
      const rest = after === null ? batch : batch.filter((e) => e.id > after);
      return { events: rest as unknown as PullResult["events"], for_me: rest.filter((e) => e.to === "dev") as unknown as PullResult["for_me"], cursor: rest.length ? rest[rest.length - 1].id : after };
    },
  };
  return p;
}
const BATCH = [
  { ...at("01M50000000000000000000001"), kind: "instruction", actor: "pm", to: "dev", body: "已建 t-240，下一件做它" },
  { ...at("01M50000000000000000000002"), kind: "instruction", actor: "pm", to: "dev", body: "t-239 排它之后" },
];

describe("t-240 判据 1、2 · 交付之前死掉：那一批下一次还在", () => {
  it("印到一半进程死了（print 抛）⇒ **游标一个字没动**，同一批下一次原样再来", async () => {
    const c = store(OLD);
    const s = server(BATCH);
    const died = () => { throw new Error("容器重启：进程在这一行死掉"); };
    await expect(sync(s, "dev", c, 0, died)).rejects.toThrow("容器重启");
    expect(c.value, "没交付就不许推进").toBe(OLD);
    expect(c.writes).toBe(0);

    // 重启之后：**判的是这个节点还拿不拿得到**（判据 7），不是服务算没算过
    const lines: string[] = [];
    const r = await sync(s, "dev", c, 0, (l) => lines.push(l));
    expect(r.for_me.map((i) => (i as unknown as { id: string }).id)).toEqual(BATCH.map((e) => e.id));
    expect(lines.join("\n")).toContain("已建 t-240");
    expect(c.value, "交付之后才推进").toBe(BATCH[1].id);
  });

  it("watch 那一路同样：死在印之前，重挂之后那一批还在", async () => {
    const c = store(OLD);
    const s = server(BATCH);
    const died = () => { throw new Error("watch 被打死"); };
    await expect(watch(s, "dev", c, 10, died, { once: true })).rejects.toThrow("watch 被打死");
    expect(c.value).toBe(OLD);

    const lines: string[] = [];
    const r = await watch(s, "dev", c, 10, (l) => lines.push(l), { once: true });
    expect(lines.join("\n")).toContain("已建 t-240");
    expect(r.for_me).toHaveLength(2);
    expect(c.value).toBe(BATCH[1].id);
  });

  it("交付成功的那一次才推进，而且只推一次——重跑不会把同一批再发一遍", async () => {
    const c = store(OLD);
    const s = server(BATCH);
    await sync(s, "dev", c, 0, () => {});
    expect(c.writes).toBe(1);
    const again = await sync(s, "dev", c, 0, () => {});
    expect(again.events, "第二次就真的没有新的了").toHaveLength(0);
  });

  it("拉与推进是两步：`pullBatch` 自己不碰游标（判据 1 的形状）", async () => {
    const c = store(OLD);
    const s = server(BATCH);
    const { after, r } = await pullBatch(s, c, 0);
    expect(after).toBe(OLD);
    expect(r.events).toHaveLength(2);
    expect(c.writes, "拉这一步一个字都不写").toBe(0);
  });
});
