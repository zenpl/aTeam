/**
 * t-283 判据 4／8／9／10／12／13：**回归用真标本，而且标本要可证。**
 *
 * 四份被拒记录里可证的三份，正本以 base64 发布在日志里（判据 13：跨容器协作里路径不是共同所指，
 * 那几个 scratchpad/ 与 /tmp/pm-cli/ 只是采集地的说明；我这台读不到，所以走日志）。
 * 下面每一份都先对一次 sha256 再用——**对不上就当场红**，这是判据 9 要的「不要据说是真的」。
 *
 * 第四份（pm 02:59 那份抄件，正文 316 字）**没有指纹、原件已被覆盖**，按判据 9② 只作覆盖面、不作基准，
 * 所以这里不收它：三份可证的正文 286／292／360 已经把两端都夹住了（pm 03:22）。
 *
 * **这一组测的不是 actionOf 一个函数，是那条完整的因果**：盘上躺着一条旧规则写的记录（`what` 里带着整条
 * 正文），节点把正文改短后重发成功——那条记录**必须**被划掉。少了 identityOf 那一步，四份标本一份都划不掉，
 * 而纯单元测试仍然全绿。
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { actionOf, identityOf, readRefusal } from "../src/rejected.js";

/** 三份可证标本：base64 正本、声称的 sha256、采集者、日志里那条 note 的 id。 */
const SPECIMENS = [
  {
    label: "标本①", who: "qa", note: "01M2VTWCE785QAXREWVHBPBAR2",
    sha256: "685239cc3057c870633e6279e31bfdaa08e6d3a500f579ff69b115fa0f7e6799", bytes: 1167,
    b64sha256: "5562da10ae1520e00fbd8239795f73d2e759d567536852e204a8bc3ed5712d05",
    b64: "eyJhdCI6IjIwMjYtMDktMTlUMDI6NTU6MDEuNDAzWiIsInJ1bGUiOiJpbnN0cnVjdGlvbiIsImNtZCI6ImF0ZWFtIHRlbGwgcG0gXCLkvaDpgqPkuKogbGltaXQg55qE5rSe5q+U5L2g6YeP55qE5a695LiA5qC8Oi9ldmVudHMg5Lmf5LiA5qC3KD9saW1pdD01IOWbniAxMTEyMiDmnaEpLGFwcC50czo3MzYtNzM4IOWPquivuyBhZnRlciDkuI4gd2FpdOOAguWPpue7meS9oOS4gOS4quecn+WunuWPl+Wus+agt+acrDrmiJEgMDI6MTcg6LeR6L+HIC9ldmVudHM/YWZ0ZXI9POWAkuaVsOesrOS6jOadoT4mbGltaXQ9MSzmgbDlpb3lm54gMSDmnaEs5oiR55yL5LiA55y85bCx6L+H5LqG4oCU4oCU6YKj5LiqIDEg5YWo5pivIGFmdGVyIOW5sueahOOAgui/mOacieS4gOadoeabtOato+e7meaIkeiHquW3sTrmiJEgMDI6NTIg5oqKIHJlZnVzZWQtcXVldWUg6K+75oiQ5b6F5Yqe5bm26K+05riF5o6J5LqGLOWFqOmUmTvlroPmmK8gUE9TVCAvcmVmdXNhbHMg55qE5Ye656uZ6Zif5YiXLOiAjCAzZTUwZTViIOS4iuayoeaciei/meS4qui3r+eUsSzmiYDku6XlroPmjpLkuI3lh7rljrvigJTigJTpgqMgNSDmnaHmmK/lm57mu5rlnKjmnKzmnLrnlZnkuIvnmoTohJrljbDjgIJcIiAtLWFjay1ieSAyaCIsIndoYXQiOiJ0ZWxsIHBtIOS9oOmCo+S4qiBsaW1pdCDnmoTmtJ7mr5TkvaDph4/nmoTlrr3kuIDmoLw6L2V2ZW50cyDkuZ/kuIDmoLcoP2xpbWl0PTUg5ZueIDExMTIyIOadoSksYXBwLnRzOjczNi03Mzgg5Y+q6K+7IGFmdGVyIOS4jiB3YWl044CC5Y+m57uZ5L2g5LiA5Liq55yf5a6e5Y+X5a6z5qC35pysOuaIkSAwMjoxNyDot5Hov4cgL2V2ZW50cz9hZnRlcj085YCS5pWw56ys5LqM5p2hPiZsaW1pdD0xLOaBsOWlveWbniAxIOadoSzmiJHnnIvkuIDnnLzlsLHov4fkuobigJTigJTpgqPkuKogMSDlhajmmK8gYWZ0ZXIg5bmy55qE44CC6L+Y5pyJ5LiA5p2h5pu05q2j57uZ5oiR6Ieq5bexOuaIkSAwMjo1MiDmioogcmVmdXNlZC1xdWV1ZSDor7vmiJDlvoXlip7lubbor7TmuIXmjonkuoYs5YWo6ZSZO+Wug+aYryBQT1NUIC9yZWZ1c2FscyDnmoTlh7rnq5npmJ/liJcs6ICMIDNlNTBlNWIg5LiK5rKh5pyJ6L+Z5Liq6Lev55SxLOaJgOS7peWug+aOkuS4jeWHuuWOu+KAlOKAlOmCoyA1IOadoeaYr+Wbnua7muWcqOacrOacuueVmeS4i+eahOiEmuWNsOOAgiJ9",
  },
  {
    label: "标本③", who: "qa", note: "01M2VTWFBE8GZD2SYFYECSMAB2",
    sha256: "cfb873c5f9c402754a37e91c8488e1e93d41b31dccedd65aee96c641ab4ebcee", bytes: 1183,
    b64sha256: "0425d9a1ecf644bfdc2d0cf2f3f09f79f89b1b3f47184fd6e2825a0240df83be",
    b64: "eyJhdCI6IjIwMjYtMDktMTlUMDM6MDg6NTUuMjU4WiIsInJ1bGUiOiJpbnN0cnVjdGlvbiIsImNtZCI6ImF0ZWFtIHRlbGwgcG0gXCLjgIzmiJHlnKjot5Hlk6rkuIDniYjml6Dop6PjgI3ov5nlj6XmlLbkuIDmoaM657K+56GuIHNoYSDnoa7lrp7opoHmiLMs5L2G44CM5oiR5Zyo5p+Q5Liq5pS55Yqo55qE5ZOq5LiA5L6n44CN5LiA5p2h5ZG95Luk5bCx6Zeu5b6X5Ye64oCU4oCUZGlzdCDoh6rlt7HlsLHmmK/or4Hmja7jgILliKTkvaDov5nlj7A6Z3JlcCAtYyAnYnVpbGQuanNvbicgcGFja2FnZXMvY2xpL2Rpc3QvbWFpbi5qcyziiaUxIOaYryB0LTI1NiDkuYvlkI4o57y6IGJ1aWxkLmpzb24g5bCx6Z2Z6buY5LiN6K6wLOWGu+S9j+aYr+mihOacnyksMCDmmK/kuYvliY0o6K+7IEhFQUQs6YKj5Ya75L2P5Y+m5pyJ5oiQ5ZugKeOAguS9oOS7iuWkqSBncmVwIHNoaXBSZWZ1c2FscyDliKToh6rlt7HmsqEgdC0yMTgs55So55qE5bCx5piv6L+Z5oub44CC5Y+mOumHjSBidWlsZCDliY3lhYjnnIsgZ2l0IHN0YXR1cyAtLXBvcmNlbGFpbixzdGFtcC1jbGkg5Zyo5qCR6ISP5pe25Lya5aSx6LSlLOmCo+S8mumAoOWHuuS4gOS7veaWsOeahOOAjOaciSBkaXN0IOayoeaIs+OAjeOAglwiIC0tYWNrLWJ5IDJoIiwid2hhdCI6InRlbGwgcG0g44CM5oiR5Zyo6LeR5ZOq5LiA54mI5peg6Kej44CN6L+Z5Y+l5pS25LiA5qGjOueyvuehriBzaGEg56Gu5a6e6KaB5oizLOS9huOAjOaIkeWcqOafkOS4quaUueWKqOeahOWTquS4gOS+p+OAjeS4gOadoeWRveS7pOWwsemXruW+l+WHuuKAlOKAlGRpc3Qg6Ieq5bex5bCx5piv6K+B5o2u44CC5Yik5L2g6L+Z5Y+wOmdyZXAgLWMgJ2J1aWxkLmpzb24nIHBhY2thZ2VzL2NsaS9kaXN0L21haW4uanMs4omlMSDmmK8gdC0yNTYg5LmL5ZCOKOe8uiBidWlsZC5qc29uIOWwsemdmem7mOS4jeiusCzlhrvkvY/mmK/pooTmnJ8pLDAg5piv5LmL5YmNKOivuyBIRUFELOmCo+WGu+S9j+WPpuacieaIkOWboCnjgILkvaDku4rlpKkgZ3JlcCBzaGlwUmVmdXNhbHMg5Yik6Ieq5bex5rKhIHQtMjE4LOeUqOeahOWwseaYr+i/meaLm+OAguWPpjrph40gYnVpbGQg5YmN5YWI55yLIGdpdCBzdGF0dXMgLS1wb3JjZWxhaW4sc3RhbXAtY2xpIOWcqOagkeiEj+aXtuS8muWksei0pSzpgqPkvJrpgKDlh7rkuIDku73mlrDnmoTjgIzmnIkgZGlzdCDmsqHmiLPjgI3jgIIifQ==",
  },
  {
    label: "标本④", who: "pm", note: "01M2VTVGHR5KDC1XN9NDKD5ZAX",
    sha256: "cb2f4bd8d699f254a10242b7fc43e3e06194a227877cfb02086b5c3d14ff3774", bytes: 1756,
    b64sha256: "fdd3d8ae8d862e5fd8dc4af6c01034678782add236201bce56b8c87c6ac1d0d2",
    b64: "eyJhdCI6IjIwMjYtMDktMTlUMDM6MTY6NDQuMDUwWiIsInJ1bGUiOiJpbnN0cnVjdGlvbiIsImNtZCI6ImF0ZWFtIHRlbGwgcWEgXCJ0LTI4MiDlt7LkuqTvvIhkZXbvvIwxZTA2OTBl77yM5ZyoIGUzYjVmZTEg5LmL5LiK77yJ77yM6K+35ZyoIHJlcG8g5LiK5Yik44CC5Zub5aSE6K+35L2g5Lqy5omL6LWw77ya4pGgIOWug+aUueS6hiBkZXBsb3kueW1sIOmHjOmCo+adoSBlbHNlIGZseWN0bCDlm57pgIDliIbmlK/vvIjmiJHlkozkvaDpg73msqHmj5DliLDnmoTkuIDlpITvvJrpgqPmnaHot6/nu5Xov4cgYmluL2RlcGxvee+8jOmXuOS8muiiq+aVtOadoei3s+i/h++8ie+8jOWug+aUueaIkOaLkue7neWPkei9puKAlOKAlOi/meaYr+acrOS7tuWUr+S4gOaJqeWHuuWOn+iMg+WbtOeahOaUueWKqO+8jOivt+WNleeLrOWIpOivpeS4jeivpeOAguKRoSDliKTmja4gNCDnmoTlj43lkJHms6jlhaXvvJrlroPmi7/mjonpl7jlvpcgMyDnuqIgMyDnu7/vvIzlubboh6rpl67kuobjgIzov5nkuInmnaHmnInmsqHmnInlj6/og73kuI3nuqLjgI3vvIzor7flpI3moLjpgqPkuInmnaHmlq3oqIDnmoTmmK/nu5PmnpzvvIjmoIforrDmlofku7bvvInogIzpnZ7lrZfpnaLjgILikaIg5Yik5o2uIDUg55qE6LaK6L+H6Lev5b6EIC0tc2tpcC10ZXN0cyDopoHnkIbnlLHjgIHpgIDlh7rnoIEgMuOAgeWOn+WboOaJk+WHuuadpe+8jOWFreadoeeUqOS+i+WQhOmSieS4gOadoeOAguKRoyDmnaHmlbDkuqTlj4nvvJo2NzgrNDExKzM1OD0xNDQ377yM5q+U5a6D6K6h5pe26YKj5qyh55qEIDE0NDEg5q2j5aW95aSaIDbvvIznrYnkuo7mlrDnlKjkvovmlbDjgILlj6bvvJrliKTmja4gNiDlroPnu5nkuobkuInlj6XlgJnpgInjgIHmoIfmmI7lvoUgcGTvvIzmsqHoh6rmi5/vvIzmiJHorqTkuLrlr7njgIJcIiAtLWFjay1ieSAzMG0iLCJ3aGF0IjoidGVsbCBxYSB0LTI4MiDlt7LkuqTvvIhkZXbvvIwxZTA2OTBl77yM5ZyoIGUzYjVmZTEg5LmL5LiK77yJ77yM6K+35ZyoIHJlcG8g5LiK5Yik44CC5Zub5aSE6K+35L2g5Lqy5omL6LWw77ya4pGgIOWug+aUueS6hiBkZXBsb3kueW1sIOmHjOmCo+adoSBlbHNlIGZseWN0bCDlm57pgIDliIbmlK/vvIjmiJHlkozkvaDpg73msqHmj5DliLDnmoTkuIDlpITvvJrpgqPmnaHot6/nu5Xov4cgYmluL2RlcGxvee+8jOmXuOS8muiiq+aVtOadoei3s+i/h++8ie+8jOWug+aUueaIkOaLkue7neWPkei9puKAlOKAlOi/meaYr+acrOS7tuWUr+S4gOaJqeWHuuWOn+iMg+WbtOeahOaUueWKqO+8jOivt+WNleeLrOWIpOivpeS4jeivpeOAguKRoSDliKTmja4gNCDnmoTlj43lkJHms6jlhaXvvJrlroPmi7/mjonpl7jlvpcgMyDnuqIgMyDnu7/vvIzlubboh6rpl67kuobjgIzov5nkuInmnaHmnInmsqHmnInlj6/og73kuI3nuqLjgI3vvIzor7flpI3moLjpgqPkuInmnaHmlq3oqIDnmoTmmK/nu5PmnpzvvIjmoIforrDmlofku7bvvInogIzpnZ7lrZfpnaLjgILikaIg5Yik5o2uIDUg55qE6LaK6L+H6Lev5b6EIC0tc2tpcC10ZXN0cyDopoHnkIbnlLHjgIHpgIDlh7rnoIEgMuOAgeWOn+WboOaJk+WHuuadpe+8jOWFreadoeeUqOS+i+WQhOmSieS4gOadoeOAguKRoyDmnaHmlbDkuqTlj4nvvJo2NzgrNDExKzM1OD0xNDQ377yM5q+U5a6D6K6h5pe26YKj5qyh55qEIDE0NDEg5q2j5aW95aSaIDbvvIznrYnkuo7mlrDnlKjkvovmlbDjgILlj6bvvJrliKTmja4gNiDlroPnu5nkuobkuInlj6XlgJnpgInjgIHmoIfmmI7lvoUgcGTvvIzmsqHoh6rmi5/vvIzmiJHorqTkuLrlr7njgIIifQ==",
  },
] as const;

/** 解出字节、对一次 hash、再解析成记录。对不上就抛——判据 9 要的「对不上当场停下」。 */
function open(s: (typeof SPECIMENS)[number]) {
  // t-283 判据 14：**先验文本层，对不上就停下、不要往下解码**——那层不对说明这串在传递里被改了。
  // 前提也一起钉住：base64 要贴成不含任何空白的单行，否则「文本层的 hash」没有唯一所指。
  expect(/\s/.test(s.b64), `${s.label} 的 base64 里有空白：文本层的 hash 就没有唯一所指了`).toBe(false);
  expect(createHash("sha256").update(s.b64).digest("hex"), `${s.label} 文本层对不上`).toBe(s.b64sha256);
  const bytes = Buffer.from(s.b64, "base64");
  const got = createHash("sha256").update(bytes).digest("hex");
  expect(got, `${s.label}（${s.who} 采，日志 ${s.note}）的 sha256 对不上：中间有人改过，别用`).toBe(s.sha256);
  expect(bytes.length, `${s.label} 字节数对不上`).toBe(s.bytes);
  const st = readRefusal(bytes.toString("utf8"));
  expect(st.kind, `${s.label} 应当是一条读得出来的被拒记录`).toBe("open");
  if (st.kind !== "open") throw new Error("unreachable");
  return st.refusal;
}

describe("t-283 · 拿真标本验「缩短后重发会划掉它」", () => {
  it("三份标本都对得上 hash，且都是 tell 超长那一类", () => {
    for (const s of SPECIMENS) {
      const r = open(s);
      expect(r.rule).toBe("instruction");
      expect(r.what.startsWith("tell "), `${s.label} 的 what 该是 tell 开头`).toBe(true);
      // 判据 11 那个确数：what = "tell " + 收件人 + " " + 整条正文，前缀恰好 8 字
      expect(r.what.length, `${s.label} 的 what 长度`).toBeGreaterThan(280);
    }
  });

  it("**判据 4 的正题**：把正文改短后重发同一个收件人 ⇒ 指纹对上 ⇒ 那条记录被划掉", () => {
    for (const s of SPECIMENS) {
      const r = open(s);
      const to = r.what.split(" ")[1];
      const short = "改短之后的正文";
      expect(identityOf(r.what), `${s.label}：盘上那条要收窄成「对谁做哪件事」`).toBe(`tell ${to}`);
      expect(actionOf(["tell", to, short]), `${s.label}：这一次的命令行收窄成同一个`).toBe(identityOf(r.what));
    }
  });

  it("**对照**：改短之后发给另一个人，不算把这条办了", () => {
    for (const s of SPECIMENS) {
      const r = open(s);
      const to = r.what.split(" ")[1];
      const other = to === "pm" ? "qa" : "pm";
      expect(actionOf(["tell", other, "改短之后的正文"])).not.toBe(identityOf(r.what));
    }
  });

  it("**对照**：别的子命令成功也不算——被拒的是一条 tell", () => {
    const r = open(SPECIMENS[0]);
    for (const argv of [["note", "随便写点什么"], ["task", "done", "t-283"], ["sync"]]) {
      expect(actionOf(argv)).not.toBe(identityOf(r.what));
    }
  });

  it("三份之间：同收件人的两份指纹相同（①③ 都是 tell pm），与第三份（tell qa）不同", () => {
    const [a, b, c] = SPECIMENS.map((s) => identityOf(open(s).what));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
