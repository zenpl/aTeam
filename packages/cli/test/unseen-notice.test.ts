/**
 * t-293 判据 7 的另一半（pd 07:39 定、pm 07:35 批）：**那一叠数的是事件，通知不算进那个数。**
 *
 * pd 的原话：一个数只许数一种东西。「还没人看过的」数的是日志里的事件；通知是我们对人说的话。两者混在
 * 一个数里之后，人拿那个数做的判断（我落下了多少）就不再对应那个数算的东西（屏幕上有多少行）。
 *
 * 这不是新加的洁癖：`UNSEEN_DROPPED` 那一行从一开始就是通知，而它一直被数进去——这里一并归位。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNSEEN_DROPPED } from "@ateam/core";
import { stashUnseen, stashNotice, unseenLines, unseenRows, capUnseen, unseenFile } from "../src/unseen.js";

const ME = "dev";
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "t293-pile-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("t-293 判据 7 · 一叠两种行，数的只有事件", () => {
  it("通知不进那个数：三条事件 ＋ 一条通知 ⇒ 数是 3", () => {
    stashUnseen(dir, ME, ["事件一", "事件二", "事件三"]);
    stashNotice(dir, ME, ["这台机器以前没在这儿读过日志，所以下面是从头开始的 3 条（01A 到 01C）。这一批只送一次：…"]);
    expect(unseenLines(dir, ME), "那个数的分母只许是事件").toHaveLength(3);
    expect(unseenRows(dir, ME).notices).toHaveLength(1);
  });

  it("顺序保住：通知与事件各自成一串，谁也不吃掉谁", () => {
    stashNotice(dir, ME, ["通知甲"]);
    stashUnseen(dir, ME, ["事件一"]);
    stashNotice(dir, ME, ["通知乙"]);
    const rows = unseenRows(dir, ME);
    expect(rows.notices).toEqual(["通知甲", "通知乙"]);
    expect(rows.events).toEqual(["事件一"]);
  });

  it("老文件一个字节不用动：裸 JSON 字符串照旧读成事件", () => {
    stashUnseen(dir, ME, ["升级之前落下的一行"]);
    const raw = readFileSync(unseenFile(dir, ME), "utf8");
    expect(raw.trim()).toBe(JSON.stringify("升级之前落下的一行"));
    expect(unseenLines(dir, ME)).toEqual(["升级之前落下的一行"]);
  });

  it("上限管事件那一串，通知一条都不丢——上限防的是会长的那一串", () => {
    stashNotice(dir, ME, ["通知要留着"]);
    stashUnseen(dir, ME, Array.from({ length: 10 }, (_, i) => `事件 ${i}`));
    expect(capUnseen(dir, ME, 4), "丢掉 6 条事件").toBe(6);
    const rows = unseenRows(dir, ME);
    expect(rows.events).toEqual(["事件 6", "事件 7", "事件 8", "事件 9"]);
    expect(rows.notices, "通知没被上限带走").toEqual(["通知要留着"]);
  });

  it("**UNSEEN_DROPPED 本来就是一条通知**——它此前被数进那个数里，这一条钉住它归位了", () => {
    stashUnseen(dir, ME, ["事件一", "事件二"]);
    stashNotice(dir, ME, [UNSEEN_DROPPED(7)]);
    expect(unseenLines(dir, ME), "「丢了 7 条」不是第 3 条事件").toHaveLength(2);
    expect(unseenRows(dir, ME).notices[0]).toBe(UNSEEN_DROPPED(7));
  });

  it("读不动的一行只跳过它自己，不让整叠都印不出来", () => {
    stashUnseen(dir, ME, ["好的一行"]);
    appendFileSync(unseenFile(dir, ME), "{ 这不是 JSON\n");
    stashNotice(dir, ME, ["后面这条通知照旧读得到"]);
    expect(unseenLines(dir, ME)).toEqual(["好的一行"]);
    expect(unseenRows(dir, ME).notices).toEqual(["后面这条通知照旧读得到"]);
  });
});
