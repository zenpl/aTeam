/**
 * t-224：**S9 搬家这条路带不上 `from`。**
 *
 * 平台那一侧 t-088 早就做好了——带 `from` 的事件只写一次，重导一遍不翻倍。**而我们指给客户的那支 CLI 送不出
 * `from`**：t-088 上线至今 7051 条事件里它出现过 0 次。一条从来没有人走得通的路，和没有这条路，对一个要搬家
 * 的人是同一件事。
 *
 * 这一份守的是判据 1 与 3：**`from` 的值逐字来自被搬的那份记录**，工具不替它编一个；没给就不写，并说清不带
 * 会怎样。
 */
import { describe, it, expect } from "vitest";
import { parseImport, IMPORT_MINTED, importNoFrom } from "@ateam/core";

const line = (o: unknown) => JSON.stringify(o);
const ok = { kind: "note", body: "旧队伍的一条记录", from: "JIRA-142" };

describe("t-224 判据 1 · 每条都带 from，值由调用者给", () => {
  it("一份正常的清单：逐条读出来，from 逐字就是文件里写的那个", () => {
    const { records, problems } = parseImport([line(ok), line({ ...ok, from: "https://old/ticket/7" })].join("\n"));
    expect(problems).toEqual([]);
    expect(records.map((r) => r.from)).toEqual(["JIRA-142", "https://old/ticket/7"]);
    // **写进事件里的也是同一个值**：判据 1 要的不是「解析时见过 from」，是「写进去的那条带着它」
    expect(records.map((r) => (r.event as unknown as { from: string }).from)).toEqual(["JIRA-142", "https://old/ticket/7"]);
  });

  it("**工具不替它编一个**：同一条记录挪到第几行，from 都是同一个字符串", () => {
    const one = parseImport(line(ok)).records[0];
    const five = parseImport(`#\n#\n#\n#\n${line(ok)}`).records[0];
    expect(one.line).toBe(1);
    expect(five.line, "行号变了").toBe(5);
    expect(five.from, "而 from 一个字没变——行号、文件名、时刻都没有被拼进去").toBe(one.from);
    expect(five.from).toBe("JIRA-142");
  });

  it("空行与 # 注释跳过：人手工整理出来的清单里本来就有这两样", () => {
    const { records, problems } = parseImport(`# 从旧系统导出的在途单据\n\n${line(ok)}\n  \n`);
    expect(problems).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0].line, "行号是文件里的真行号，人拿它去改文件").toBe(3);
  });
});

describe("t-224 判据 3 · 不给 from 不许静默照写", () => {
  it("没有 from：这一条不写，那句话说清了不带会怎样", () => {
    const { records, problems } = parseImport(line({ kind: "note", body: "没出处" }));
    expect(records).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0].why).toBe(importNoFrom(1));
    expect(problems[0].why, "要说出不带会怎样，不能只说「缺字段」").toContain("重导一遍");
  });

  it("**空的 from 不算给**：一个空串去重不了任何东西，而它长得像给了", () => {
    for (const from of ["", "   ", null, 7, { id: 1 }]) {
      const { records, problems } = parseImport(line({ kind: "note", body: "x", from }));
      expect(records, `from=${JSON.stringify(from)}`).toEqual([]);
      expect(problems[0].why).toBe(importNoFrom(1));
    }
  });

  it("一份里有一行不合格：那一行被点名，**另一行也不发**（半份搬进去最贵）", () => {
    const { records, problems } = parseImport([line(ok), line({ kind: "note", body: "没出处" })].join("\n"));
    expect(problems.map((p) => p.line)).toEqual([2]);
    // records 里仍有第一条，但调用方看见 problems 非空就一条都不发——这条约定由 cli/test/import.test.ts 守
    expect(records).toHaveLength(1);
  });
});

describe("t-224 · 文件给不了的那几样，明说，不悄悄换掉", () => {
  it.each([...IMPORT_MINTED])("自带 %s：这一条不写，并说清它由谁定", (field) => {
    const { records, problems } = parseImport(line({ ...ok, [field]: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }));
    expect(records).toEqual([]);
    expect(problems[0].why).toContain(field);
  });

  it("不是 JSON、不是对象、没有 kind：三种各自说得出是哪一种", () => {
    const p = parseImport(["这不是 json", line([1, 2]), line({ from: "a", body: "b" })]. join("\n")).problems;
    expect(p.map((x) => x.line)).toEqual([1, 2, 3]);
    expect(p[0].why).toContain("JSON");
    expect(p[1].why).toContain("对象");
    expect(p[2].why).toContain("kind");
  });
});
