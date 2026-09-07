/**
 * t-080: a server that speaks a newer board shape is refused whole with one sentence and exit 2, never a field error;
 * an equal or older shape changes nothing; the CLI tells the server which shape it speaks.
 */
import { describe, it, expect, afterEach } from "vitest";
import { BOARD_SHAPE } from "@ateam/core";
import { Client, ShapeError, checkShape } from "../src/client.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("t-080 · shape check", () => {
  it("newer shape: ShapeError with the two numbers and the fix; equal, older or absent: fine", () => {
    expect(() => checkShape({ shape: BOARD_SHAPE + 1 })).toThrow(ShapeError);
    try { checkShape({ shape: BOARD_SHAPE + 5, tasks: {} }); } catch (e) {
      expect((e as ShapeError).message).toBe(`服务端的看板结构比你的 CLI 新（服务 ${BOARD_SHAPE + 5} / 你 ${BOARD_SHAPE}），请 git pull && pnpm build`);
      expect((e as ShapeError).server).toBe(BOARD_SHAPE + 5);
    }
    expect(() => checkShape({ shape: BOARD_SHAPE })).not.toThrow();
    expect(() => checkShape({ shape: 1 })).not.toThrow();
    expect(() => checkShape({ events: [] })).not.toThrow();
    expect(() => checkShape([])).not.toThrow();
  });

  it("the client refuses a newer board, task and pull before reading any field, and announces its own shape in X-Ateam-Client", async () => {
    const seen: Record<string, string>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ shape: BOARD_SHAPE + 1, tasks: undefined, seams: undefined }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const c = new Client({ url: "http://x", me: "dev", token: "t" });
    await expect(c.board()).rejects.toBeInstanceOf(ShapeError);
    await expect(c.task("t-1")).rejects.toBeInstanceOf(ShapeError);
    await expect(c.pull(null)).rejects.toBeInstanceOf(ShapeError);
    for (const h of seen) expect(h["x-ateam-client"]).toBe(String(BOARD_SHAPE));
    // the same shape: read as usual
    globalThis.fetch = (async () => new Response(JSON.stringify({ shape: BOARD_SHAPE, events: [], for_me: [], cursor: null }), { status: 200 })) as typeof fetch;
    expect((await c.pull(null)).events).toEqual([]);
  });
});
