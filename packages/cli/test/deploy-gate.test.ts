/**
 * t-282：**发车路上原来一步测试都不跑。** `deploy.yml` 与 `bin/deploy` 都直通 `fly deploy`。
 *
 * 这里验的是那道闸，而**不碰真的 fly、不碰生产**：把 `bin/deploy` 逐字复制进一个临时目录（复制前后对一次
 * sha256，对不上当场红），在那儿造一个只有 `package.json` 与 `node_modules` 的假仓库，`PATH` 上放两个桩：
 * 一个 `pnpm`（按环境变量决定绿或红），一个 `fly`（被调用就写一个标记文件）。
 * **「有没有发车」就看那个标记文件在不在** ——比读输出可靠，因为输出可以写得像拦住了而其实没有。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, existsSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const SRC = join(REPO, "bin", "deploy");
let dir = "";
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(join(dir, "stub"));
  copyFileSync(SRC, join(dir, "bin", "deploy"));
  chmodSync(join(dir, "bin", "deploy"), 0o755);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", private: true }));
  // pnpm 桩：TESTS_RED=1 就红
  writeFileSync(join(dir, "stub", "pnpm"), `#!/bin/sh\nif [ "\${TESTS_RED:-}" = "1" ]; then echo "1 failed" >&2; exit 1; fi\necho "all green"\n`);
  chmodSync(join(dir, "stub", "pnpm"), 0o755);
  // fly 桩：被调用就留下标记，绝不真的发车。
  // t-282 第二版：**参数之间用 \0 隔开**（原来是 `echo "$@"`，参数之间的界在文件里就没了，而这次判 fail 的
  // 恰恰是参数的界）。qa 03:29 的量法就是这个：看 fly 收到的是「FOO=a b」一个，还是「FOO=a」「b」两个。
  // **不用换行作分隔**：判据 7④ 要验的正是带换行的值，用换行隔开就分不出「一个带换行的参数」与「两个参数」。
  writeFileSync(join(dir, "stub", "fly"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${join(dir, "FLY_WAS_CALLED")}"\n`);
  chmodSync(join(dir, "stub", "fly"), 0o755);
});

/** 跑一次那个脚本；`path` 决定桩在不在。返回退出码、两股输出，以及 fly 有没有被调用。 */
function run(args: string[], env: Record<string, string> = {}, withStub = true) {
  const marker = join(dir, "FLY_WAS_CALLED");
  rmSync(marker, { force: true });
  const r = spawnSync(join(dir, "bin", "deploy"), args, {
    cwd: dir, encoding: "utf8",
    // 「没有 pnpm」那一条要的是**环境里没有 pnpm**，不是「连 sh 都没有」：把 PATH 收到系统目录
    // （这台机器上 pnpm 在 /opt/node22/bin，不在 /usr/bin 或 /bin），并且不挂桩目录。
    // 第一版我把 PATH 设成一个不存在的目录，脚本自己都起不来（127），量的就不是那道闸了。
    env: { ...process.env, ...env, PATH: withStub ? `${join(dir, "stub")}:${process.env.PATH}` : "/usr/bin:/bin" },
  });
  const raw = existsSync(marker) ? readFileSync(marker, "utf8") : null;
  const seen = raw === null ? null : raw.split("\0").slice(0, -1);   // 每个参数后面都跟一个 \0，末尾那截是空的
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", deployed: existsSync(marker), seen };
}

/** fly 在 `$@` 之前固定收到的三个：`deploy --build-arg GIT_SHA=…`。转发的部分是它们之后那一截。 */
const forwarded = (seen: string[] | null) => (seen ?? []).slice(3);

describe("t-282 · 发车前那道测试闸", () => {
  it("复制进来的就是仓库里那一份（逐字）", () => {
    expect(sha(join(dir, "bin", "deploy"))).toBe(sha(SRC));
  });

  it("反：测试红 ⇒ 不发车，退出码非 0，并说得出为什么", () => {
    const r = run(["--remote-only"], { TESTS_RED: "1" });
    expect(r.deployed, "fly 一次都不该被调用").toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("测试没全绿");
    expect(r.err).toContain("没有发车");
  });

  it("正：测试绿 ⇒ 照旧发车", () => {
    const r = run(["--remote-only"]);
    expect(r.deployed, "绿了就该发").toBe(true);
    expect(r.code).toBe(0);
    expect(forwarded(r.seen)).toEqual(["--remote-only"]);
  });

  it("越过要带理由，而且理由会被打出来——红着也能发，但留下名字", () => {
    const r = run(["--skip-tests", "生产在燃，先发车后补", "--remote-only"], { TESTS_RED: "1" });
    expect(r.deployed).toBe(true);
    expect(r.err).toContain("生产在燃，先发车后补");
    expect(forwarded(r.seen)).toEqual(["--remote-only"]);
  });

  it("越过不给理由 ⇒ 当场拒，且不发车", () => {
    const r = run(["--skip-tests"], { TESTS_RED: "1" });
    expect(r.deployed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.err).toContain("要一个理由");
  });

  it("**跑不了也算拦住**：环境里没有 pnpm ⇒ 不发车，而不是静默放行", () => {
    const r = run(["--remote-only"], {}, false);
    expect(r.deployed, "这一条是这道闸最容易做错的地方").toBe(false);
    expect(r.code).toBe(2);
    expect(r.err).toContain("跑不了");
  });
});

/**
 * t-282 第二版：**「参数原样传下去」这句话，第一版并没有验。**
 *
 * qa 03:29 判 fail 的就是这一处：样本只有 `--remote-only`——**不含空格、不含通配、不是空串**，
 * 于是一条拼字符串再分词的实现照样绿。三条用例逐条对着它量过的三种坏法，**并且都是改动前就成立的行为**
 * （`e3b5fe1` 那版直接 `"$@"`），所以它们量的是「有没有被这次改动弄坏」，不是新功能。
 *
 * 口径，这条是这次买来的：**一条断言不该比它真正验到的东西说得多。** 名字里写「原样」，样本就得包含
 * 会被「不原样」弄坏的那几种；否则它绿着，而它守的那件事没人守。
 */
describe("t-282 · 转发给 fly 的参数一个字不差", () => {
  it("带空格的一个参数，到 fly 手上仍是一个", () => {
    const r = run(["--build-arg", "FOO=a b", "--remote-only"]);
    expect(forwarded(r.seen)).toEqual(["--build-arg", "FOO=a b", "--remote-only"]);
  });

  it("通配符不被当时目录里的文件名替换掉——**这一种是静默的**", () => {
    writeFileSync(join(dir, "aaa.txt"), "");
    writeFileSync(join(dir, "bbb.txt"), "");
    const r = run(["--label", "*.txt"]);
    expect(forwarded(r.seen), "它不报错，只是把你的参数换成了别的东西").toEqual(["--label", "*.txt"]);
  });

  it("空串是一个参数，不是零个", () => {
    const r = run(["--label", "", "--remote-only"]);
    expect(forwarded(r.seen)).toEqual(["--label", "", "--remote-only"]);
  });

  it("`--skip-tests <理由>` 连它的理由一起摘掉，其余顺序不变；理由本身带空格与通配也不作数", () => {
    const r = run(["--build-arg", "FOO=a b", "--skip-tests", "生产在燃 *.txt", "--label", ""], { TESTS_RED: "1" });
    expect(r.deployed).toBe(true);
    expect(r.err).toContain("生产在燃 *.txt");
    expect(forwarded(r.seen)).toEqual(["--build-arg", "FOO=a b", "--label", ""]);
  });

  it("换行与制表也一个字不差（判据 7④）", () => {
    const r = run(["--build-arg", "FOO=a\nb\tc", "--remote-only"]);
    expect(forwarded(r.seen)).toEqual(["--build-arg", "FOO=a\nb\tc", "--remote-only"]);
  });

  it("`--skip-tests` 之后什么都没有时照旧拒——摘理由不许把「没有理由」变成摘走下一个参数", () => {
    const r = run(["--remote-only", "--skip-tests"], { TESTS_RED: "1" });
    expect(r.deployed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.err).toContain("要一个理由");
  });
});
