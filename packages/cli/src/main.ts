import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { WATCH_INTERVAL, CLI_REFUSAL_BATCH_MAX, DEADLINE_WORDS, OWED_LEGACY_HELP, QUIET_HELP, BODY_FILE_HELP, UNSEEN_HEAD, UNSEEN_DROPPED, UNSEEN_MAX, roleNamer, boardTask, Rejected, type ClientEvent, SAID_PREFIX, SAID_MAX_CHARS, PUSH_LEVELS, NODE_SURFACE, CLI_SHA_METHOD, capabilityKey, SEAM_VERDICTS, overlapOf, alsoHere, nobodyElse, symbolsMeasured, symbolsUnnamed, WHOLE_GATE_OFF, cannotMeasureHere, partRefused, PART_NAMES, EXIT_PARTIAL, exitCodeLine, type Board, type SeamVerdict } from "@ateam/core";
import { parse, fromFiles, str, list, bool, duration, exact, measuredAtOf, UsageError, type Args } from "./args.js";
import { sendAll as sendParts } from "./send.js";
import { Client, ClientError, ShapeError, BadResponse, seen } from "./client.js";
import { resolveConfig, initFields, joinOutput, type Config } from "./config.js";
import * as fmt from "./format.js";
import { trace, isSha } from "./trace.js";
import { seamWarnings, seamCheck, gitCommitsSince, gitChangedSince, gitIsAncestor, gitHasObject } from "./seamcheck.js";
import { verifyParts } from "./verifyparts.js";
import { blockingLock, writeLock, removeLock } from "./lock.js";
import { watchState, listeningNotices, pullIdle } from "./deaf.js";
import { revise, baseAt, changedFiles, changedSymbols, type Diff } from "./touches.js";
import { readRefusal, refusalNotice, clearsAfterNotice, actionOf, type Refusal } from "./rejected.js";
import { stashUnseen, unseenLines, clearUnseen, capUnseen } from "./unseen.js";
import { queueRefusal, pendingRefusals, clearRefusals, cliOpOf } from "./refusalqueue.js";
import { deploy, rollback, realGit, realBehind, containment, containmentFact } from "./release.js";
import { fixtureText } from "./fixture.js";
import { splitTitle, TITLE_MAX_CHARS, type InstructionIntent } from "@ateam/core";
import { sync, watch, type CursorStore } from "./loop.js";
import { decide } from "./decide.js";
import { runImport, type Written } from "./import.js";

const HELP = `ateam — the shared log for a team of sessions

setup
  ateam join --me <role> [--url <server>] [--token <t>] [--push none|own-branch|integration|production]   become a node: writes .ateam/config.json, syncs once, prints the role's manual (init is an alias); --push records what you may push as the fact node:<role>:能力
  ateam init --me <role> [--url <server>] [--token <t>]   writes the given fields to .ateam/config.json
                                                          precedence per field: env ATEAM_ME / ATEAM_URL / ATEAM_TOKEN beats the file; the file fills what the env leaves unset

every turn
  ateam sync [--wait 25s] [--quiet]   pull new events since your cursor; instructions for you are marked. --wait long-polls.
                                 ${QUIET_HELP}
  ateam ack <id>                 acknowledge an instruction addressed to you
  ateam untell <id> --reason "..."   take back an instruction you sent, before it is acked or decided; the recipient sees 已撤回
  ateam board [--json] [--full]           what is true, what is open, who is here
  ateam fixture [--start <iso>] [--step 1m]   a sample log (events, cursors, deliveries) built with the server's own code, to stdout; no server needed
  ateam release [--json] [--deploy <sha>] [--rollback <sha>] [--anyway "<理由>"]   --deploy 推的是一个 sha，不是分支名（分支头随时会前进到还没验收的提交）；含未验收任务时拒绝，--anyway 带理由可越过并留痕
      --rollback <sha> 回到我们上过的某一版：造一个内容与它逐字相同的新提交再快进推上去（不强推、不改历史）。目标必须当过生产头
      what passed on repo and not yet on production; --deploy pushes that sha to the production branch (fact project:deploy.enabled, credential ATEAM_DEPLOY_TOKEN)

say things
  ateam tell <to> <body> [--ack-by 15m] [--kind ask|do|info] [--depends-on surface:key,...]   instruction: one recipient, ≤280 chars, must be acked; --kind only for human; --depends-on says what this card is true of, and the board marks it when that fact changes
  ateam tell human <body> --option A --option B [--default B]        a decision for the human; the board shows one button per option
  ateam decide <id> <option>                                         choose for an instruction with options: acks it and records the decision
  ateam premise <instruction-id> [--depends-on surface:key,...] [--valid-until <iso> | --valid-for 8h]   say what an already-sent card is true of, or when it stops being true; the board marks it, nothing is deleted
  ateam reading <key> <value> --surface <s> [--depends-on a,b] [--assumes "..."]... [--valid-for 6h] [--method m]
                                    [--shape <regex>] [--enum a,b,c]   declare once what values <key> may take; later mismatches are rejected
                                    [--measured-at <ISO | 10m>]        when the world was measured (10m = ten minutes ago); validity counts from it
  ateam say <正文>                                                   human only: one sentence to the team; the board shows where it went
  ateam focus <body>                                                 the one thing that matters most right now
  ateam note <body | --body-file 路径> [--decision] [--supersedes <id>] [--task <id>]    --task attaches it to a task (task show, board, GET /); "evidence: ..." updates the evidence

tasks
  ateam task show <id>                       title, status, owner, criteria, touches, evidence, verifications, seams
  ateam task create <id> <title> --criteria "..." [--criteria "..."]
  ateam task claim <id> --touches a,b        declare the paths/symbols/fields you will change
  ateam task done <id> [--evidence "..."] [--shows "一句话：人能看到什么" | --no-human-impact] [--touches 符号,字段] [--no-touches] [--no-seam-check] [--no-seam-check-for <接缝 id>]
                                             --internal-only "文件#符号,…" 碰了人可见的文件、但只动了里面的内部符号时，具体说出是哪几个
                                             claim 的 touches 是声明，done 的是事实：默认从本分支相对 claim 起点的 diff 量出实际改动的文件，
                                             --touches 补 diff 量不到的（符号、字段、接口名）；量不出来时（没有 git、没起点）--touches 就是最终值，覆盖声明那份；
                                             --touches-only 表示「我写的这几条就是全部」——一条分支上连做几件时 diff 分不出是哪一件的，
                                             
                                             --no-touches 原样沿用声明。重算后冒出新接缝会挡住 done。另外，若已定接缝的另一侧没并进你的证据 sha，会告警
  ateam task verify <id> --surface <s> (--pass|--fail) [--evidence "..."] [--shows "..."]
  ateam task block <id> --on "..." | ateam task unblock <id>
  ateam task withdraw <id> --reason "..."   terminal; only open/blocked tasks, by the criteria author, pm or human
  ateam task obsolete <id> --by <decision note id> [--reason "..."]   terminal; a done/failed task a decision made moot, by the criteria author, pm, pd or human
  ateam task reopen <id> --reason "..."     done/failed -> working again, same owner and touches; by the owner, pm or human
  ateam task criteria add <id> "..."         one more criterion, numbered after the rest; by a criteria author, pm, pd or human; not once verified
  ateam task criteria moved <id> <n> --to <task-id>   mark criterion n as taken over by another task; the text stays, by a criteria author, pm or human
  ateam task seam <a> <b> --resolution "..." [--verdict real|false] [--missed]
  ateam touches <路径…>                       此刻还有谁在动这些东西（不必先 claim；只看在途，不算你自己）

any emit accepts --refs <ids> (what you build on; stale readings are rejected) and --writes <surface:key,...> (what you changed).
${BODY_FILE_HELP}

  ateam trace <task-id | sha>    the story of a change: what asked for it, who decided, who judged it where
  ateam import <file>            搬家：把别处的记录写进日志，一行一条 JSON，每条必带 from（它在原处的单号/路径/链接，原样抄来，工具不替你编）
                                 带着 from 重导一遍不会多出第二份；有一行不合格就一条都不发，改好再跑一次
  ateam log [--after <id>]       raw events
  ${OWED_LEGACY_HELP}
  ateam watch [--interval ${WATCH_INTERVAL}] [--once] [--force]   keep listening: prints what arrives and "instruction received" each time; --once exits on the first instruction; one watch per identity per checkout (--force overrides the lock)
\n牌桌上那三个与期限有关的数，各自覆盖什么（t-229）：
  ${DEADLINE_WORDS.join("\n  ")}
\n${exitCodeLine}\n`;

const configFile = () => join(process.cwd(), ".ateam", "config.json");

/**
 * t-240：**等 stdout 真的排空。** `console.log` 写进管道只是排队；读它的那一头（Monitor、`| grep`、另一个进程）
 * 慢一点或者正好死了，那几行还在这一头没出去。游标要等它出去之后才推进，所以这里把「出去了没有」变成一件
 * 等得到的事。写不满缓冲区时它当场就返回——文件与终端上这一步是免费的。
 */
const flushOut = (): Promise<void> =>
  // 零长度的一次写＋回调＝一道屏障：它排在前面那些行之后，**前面的真的出去了它才回来**。
  // （第一版写的是 `write("") ? done() : once("drain")`——零长度那次写一律返回 true，于是它当场就回来了，
  //   管道明明是满的。真路那份用例当场把它照了出来。）
  new Promise((done) => { process.stdout.write("", () => done()); });

function loadConfig(): Config {
  const file = configFile();
  const f = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  return resolveConfig(f, process.env);
}

function cursorFile(me: string) { return join(process.cwd(), ".ateam", `cursor.${me}`); }
function fileCursor(me: string): CursorStore {
  return {
    read() { const f = cursorFile(me); return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null; },
    write(c) { mkdirSync(join(process.cwd(), ".ateam"), { recursive: true }); writeFileSync(cursorFile(me), c ?? ""); },
  };
}

/**
 * t-211 判据 2：**本机构建的 sha 落成节点事实**（`node:<role>` 表面上的 `cli.sha`），牌桌上因此看得出谁在跑
 * 旧的，一条判决的证据也说得出它是用哪一版命令行量出来的。
 *
 * 只在**变了**的时候落一条：同一个值每回合重发一遍是噪音，而读数本来就是「同键更新」。上一次落的什么记在
 * `.ateam/` 里，与 cursor 同一处——这是本节点自己的事，不进日志也不该进日志。
 * 落不下去（服务拒、网络断）不挡 sync：这一句是顺带说的，不是 sync 的活。
 */
async function recordCliSha(client: { emit(e: ClientEvent): Promise<unknown> }, me: string, head: string | null): Promise<void> {
  if (!head) return;                                  // 说不出就不说
  const file = join(process.cwd(), ".ateam", `cli.sha.${me}`);
  if (existsSync(file) && readFileSync(file, "utf8").trim() === head) return;
  try {
    await client.emit({ kind: "reading", actor: me, surface: NODE_SURFACE, key: `${me}:cli.sha`, value: head,
      method: CLI_SHA_METHOD } as ClientEvent);
    mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
    writeFileSync(file, head);
  } catch { /* 顺带说的一句，落不下去不挡 sync */ }
}

function parseValue(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function common(a: Args): { refs?: string[]; writes?: string[] } {
  const out: { refs?: string[]; writes?: string[] } = {};
  const refs = list(a, "refs"); if (refs?.length) out.refs = refs;
  const writes = list(a, "writes"); if (writes?.length) out.writes = writes;
  return out;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

/**
 * t-105: this project's way of knowing what a task actually touched. The base is the branch's head at claim time,
 * kept beside the cursor in .ateam/ — local, never in the log, because it is this checkout's business. A checkout
 * with no git, or a task claimed before this existed, simply has no base, and the revision falls back to hand.
 */
function baseFile(task: string) { return join(process.cwd(), ".ateam", `base.${task}`); }
/** t-135: record where this round starts. `baseAt` decides; this only writes what it decided. */
function stampBase(task: string, op: "claim" | "reopen") {
  const next = baseAt(op, gitDiff().head(), gitDiff().base(task));
  if (!next) return;
  mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
  writeFileSync(baseFile(task), next + "\n");
}
/** t-183: 与 gitDiff 用同一个跑法，只是把 stdout 直接给出来——changedSymbols 要自己发几条 git 问句。 */
function realGitCmd() {
  return (args: string[]) => { const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" }); return r.status === 0 ? r.stdout : null; };
}
function gitDiff(): Diff {
  const git = (args: string[]) => spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return {
    head: () => { const r = git(["rev-parse", "HEAD"]); return r.status === 0 ? r.stdout.trim() : null; },
    base: (task) => { try { return readFileSync(baseFile(task), "utf8").trim() || null; } catch { return null; } },
    // t-138: what this task changed, not what the branch did — a merge brings in other people's files, and merging
    // is what the seam rules ask for. The three questions and their blind spots live next to changedFiles.
    changed: (base) => changedFiles((args) => { const r = git(args); return r.status === 0 ? r.stdout : null; }, base),
  };
}

/** t-105: assemble the final touches for a done. `--no-touches` keeps the claim declaration as the final value. */
function touchesAtDone(task: string, declared: string[], extra: string[], keep: boolean, only = false): { touches: string[] | undefined; lines: string[]; measured: boolean; changed_files?: number } {
  if (keep) return { touches: undefined, lines: ["触点不改，沿用 claim 时声明的（--no-touches）"], measured: false };
  if (only) return revise(declared, null, extra, "", true);
  const d = gitDiff();
  const base = d.base(task);
  if (!base) return revise(declared, null, extra, `没记下 claim 起点：.ateam/base.${task} 不在，这件是这个功能之前 claim 的，或者这里没有 git`);
  const changed = d.changed(base);
  const r = revise(declared, changed, extra, changed === null ? `git 说不出 ${base.slice(0, 7)} 到现在改了什么` : `相对 claim 起点 ${base.slice(0, 7)}`);
  // t-183：量出来的路径再往下问一层——每个文件里改到的是哪几个顶层符号。判定早就是符号级的（t-170 的闸、
  // t-113 的轻接缝都读「文件#符号」），而 done 量出来的只有路径，于是符号级那一半形同虚设。
  // 算不出符号的按 pd 08:22 的退路走：**只补路径、不编符号名，并说出算不出的是哪几个**——编出来的符号名比
  // 没有更糟（t-170 判据 8 就是为它加的）。
  if (!changed || !r.touches) return r;
  const git = realGitCmd();
  const symbols: string[] = [];
  const unnamed: string[] = [];
  for (const f of changed) {
    const syms = changedSymbols(git, base, f);
    if (syms?.symbols.length) symbols.push(...syms.symbols);
    if (!syms?.symbols.length || syms.partial) unnamed.push(f);   // 归不出来，或只归出一部分：这个文件仍按文件级算
  }
  if (!symbols.length && !unnamed.length) return r;
  const touches = [...new Set([...r.touches, ...symbols])];
  const lines = [...r.lines];
  if (symbols.length) lines.push(symbolsMeasured(symbols));   // 整句来自 core：这里不新造人可见的话
  if (unnamed.length) lines.push(symbolsUnnamed(unnamed));
  return { ...r, touches, lines };
}

async function main(argv: string[]) {
  const a = parse(argv);
  // t-246：`--X-file <路径>` 从文件读 `--X`（正文、证据、理由……）。**文件里的字不会再被 shell 解释一遍**，
  // 这正是今天咬了三个人五次的那件事：反引号、`$`、换行，写进文件就一个字不差。
  fromFiles(a, (p) => readFileSync(p, "utf8"));
  const [cmd, ...rest] = a._;
  if (!cmd || cmd === "help" || bool(a, "help")) { console.log(HELP); return; }

  if (cmd === "fixture") {
    exact(rest);
    console.log(await fixtureText({ start: str(a, "start"), stepMs: str(a, "step") !== undefined ? duration(str(a, "step")!) : undefined }));
    return;
  }

  if (cmd === "init" || cmd === "join") {
    exact(rest);
    const fields = initFields({ url: str(a, "url"), me: str(a, "me"), token: str(a, "token") }, process.env);
    mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(fields, null, 2) + "\n");
    const eff = resolveConfig(fields, process.env);
    console.log(`configured as "${eff.me}" against ${eff.url} (wrote ${Object.keys(fields).join(", ")} to .ateam/config.json). Add .ateam/ to .gitignore.`);
    // join: one sync (delivery is recorded, your presence begins), then the manual for the role
    const client = new Client(eff);
    const push = str(a, "push");
    if (push !== undefined) {
      if (!(PUSH_LEVELS as readonly string[]).includes(push)) throw new UsageError(`--push 只能是 ${PUSH_LEVELS.join(" | ")}`);
      const e = await client.emit({ kind: "reading", key: capabilityKey(eff.me), value: { push }, surface: NODE_SURFACE, method: "ateam join --push 自报" } as ClientEvent);
      console.log(`${e.id}  ${fmt.event(e, eff.me)}`);   // t-206：第五处，与其余四处一致——印事件就带上它的 id
    }
    await sync(client, eff.me, fileCursor(eff.me), 0, console.log).catch((err) => console.error(`sync: ${err instanceof Error ? err.message : err}`));
    console.log("");
    console.log(joinOutput(eff.me, await client.manual(eff.me)));
    return;
  }

  const cfg = loadConfig();
  const client = new Client(cfg);
  const emit = async (e: ClientEvent) => {
    const ev = await client.emit({ ...e, ...common(a) } as ClientEvent);
    // t-246 判据 3：**回执本来就回显落库内容**——这一行印的是服务返回的那条事件，而 `fmt.event` 对
    // body／evidence／resolution／reason 一个字都不截断（qa 22:42 在真命令上逐条量过）。所以那一句「我写的
    // 那句原样进去了」，读这一行就能核。我为此加过一行「落库 N 字：首…末」，**它一次都印不出来**（那四个
    // 字段永远已经整句在上面了），已删——**一段走不到的代码，比没有它更坏**（与 t-244 那次同一条）。
    //
    // 更要紧的一句写在这里：**没有任何回执抓得住 shell 吃字**——它发生在命令行看见这段字之前，
    // 命令行拿到的就是被吃过的那份。抓得住它的是 `--X-file`（判据 1 那一半）。
    console.log(`${ev.id}  ${fmt.event(ev, cfg.me)}`);
  };
  /**
   * t-246：**正文可以走 `--body-file <路径>`**（经 `fromFiles` 变成 `--body`）。给了它，位置参数上就不该再有
   * 一份正文——`exact` 会为多出来的那个报用法错，这正是我们要的：**两份正文里挑一份，挑错了是一句没人会核的假话。**
   */
  const withBody = (...names: string[]): string[] => {
    const flag = str(a, "body");
    return flag === undefined ? exact(rest, ...names, "body") : [...exact(rest, ...names), flag];
  };

  /**
   * t-228：**一条命令发多件事时，每一件各自报结果。**
   *
   * 一件被拒不再把整条命令掀翻：成的印成的（带 id），拒的印拒的（带规则名，并说清**是哪一件**），
   * 顺序就是发出去的顺序，所以「done 成功」那一行一定在「解决接缝被拒」之前。退出码按整体算：
   * 全成，0；有成有拒，`EXIT_PARTIAL`（不复用 2，那是「全拒」）；全拒，2。
   *
   * 这两行都走 stdout：看它的进程只把 stdout 当事件流（t-225 那一条）。
   */
  /**
   * t-241：**部件级被拒也进本地那本账。** 记第一件被拒的——一条命令里后面几件多半是被前面那件带倒的，
   * 记第一件才指得着根。`what` 记的是**这条命令的动作**（划掉那条规矩认的就是它：重做同一条命令成了，
   * 这条记录才该消失），部件名记在 `part` 里，提醒那一行印它：**没落下去的是哪一件**，不是整条命令。
   *
   * 一处就够：`sendAll` 的那几条命令与 `import` 走的是同一个它。
   */
  const recordParts = (failed: { what: string; rule: string; why: string }[]): void => {
    if (!failed.length) return;
    const f = failed[0];
    const shell = (x: string) => (/[\s"'$`\\]/.test(x) ? `"${x.replace(/(["\\$`])/g, "\\$1")}"` : x);
    noteRefusal(ARGV, { at: new Date().toISOString(), rule: f.rule, cmd: `ateam ${ARGV.map(shell).join(" ")}`, what: actionOf(ARGV), part: f.what });
  };

  const sendAll = async (items: { what: string; event: ClientEvent; stopOnFail?: boolean }[]): Promise<void> => {
    const r = await sendParts(items, async (e) => {
      const ev = await client.emit({ ...e, ...common(a) } as ClientEvent);
      return { id: ev.id, line: `${ev.id}  ${fmt.event(ev, cfg.me)}` };
    }, console.log, console.error);
    if (r.exit) process.exitCode = r.exit;
    recordParts(r.failed);
  };

  switch (cmd) {
    case "sync": {
      exact(rest);
      // t-211：把「本地这棵树是哪一版」交给 sync 判。git 不在、不是检出、答不上来时 realBehind 全给 null，
      // 那一句就一个字都不说——「不知道」不等于「你是最新的」。
      const behind = realBehind();
      // t-245：`--quiet` 拉到的那一批**不再消失**：它落进本地那一叠「拉到了、还没人看过的」，
      // 下一次真去看的时候先印它、再清掉。**交付的定义没变，变的只是这一次交给谁**（这一次交给磁盘）。
      const quiet = bool(a, "quiet");
      const dir = process.cwd();
      if (!quiet) {
        const waiting = unseenLines(dir, cfg.me);
        if (waiting.length) {
          console.log(UNSEEN_HEAD(waiting.length));
          for (const line of waiting) console.log(line);
          await flushOut();
          clearUnseen(dir, cfg.me);        // 印完了才清——与游标同一条规矩（t-240）
        }
      }
      const keep: string[] = [];
      // t-245（qa 22:21 判 fail 之后重做）：**`--quiet` 那一路的「交付」就是这一叠落盘**，所以它必须在推进游标
      // 之前发生、而且失败要把这条命令掀翻。第一版是「先推进、后写，写失败还默默吞掉」——磁盘写不进时
      // `sync --quiet` 退 0、一声不吭，那一批照样消失。**我刚在 t-240 修过同一形状的东西，转手又在自己的修法里
      // 做了一遍**：交付与推进之间有缝，缝里丢的东西不留痕。现在它走的是同一个屏障参数（`flush`）。
      await sync(client, cfg.me, fileCursor(cfg.me), str(a, "wait") ? duration(str(a, "wait")!) : 0,
        quiet ? (line) => keep.push(line) : console.log, behind,
        quiet
          ? async () => {
              stashUnseen(dir, cfg.me, keep);        // 抛就抛：没落盘就不推进游标，那一批下次还在
              const dropped = capUnseen(dir, cfg.me, UNSEEN_MAX);
              if (dropped) stashUnseen(dir, cfg.me, [UNSEEN_DROPPED(dropped)]);
            }
          : flushOut);
      await recordCliSha(client, cfg.me, behind.head());
      return;
    }
    case "watch": {
      exact(rest);
      const interval = duration(str(a, "interval") ?? WATCH_INTERVAL);   // t-145: one number, from core
      const lockPath = join(process.cwd(), ".ateam", `watch.${cfg.me}.lock`);
      const other = blockingLock(lockPath, new Date(), 3 * interval);
      if (other && !bool(a, "force")) throw new UsageError(`another watch is already listening as ${cfg.me} in this checkout (pid ${other.pid}, heartbeat ${other.at}). Two watches replay old instructions to each other. Stop it first: kill ${other.pid}; or run with --force if it is really gone.`);
      const started = `ateam ${["watch", ...process.argv.slice(3).filter((x) => x !== "--force")].join(" ")}`; // t-102: what to re-run, in this node's own words
      const beat = () => writeLock(lockPath, process.pid, new Date(), started);
      beat();
      const release = () => removeLock(lockPath, process.pid);
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { release(); process.exit(130); });
      await watch(client, cfg.me, fileCursor(cfg.me), interval, console.log, { once: bool(a, "once"), heartbeat: beat, flush: flushOut });
      release();
      return;
    }
    case "ack": return emit({ kind: "ack", of: exact(rest, "id")[0] });
    case "untell": return emit({ kind: "untell", of: exact(rest, "id")[0], reason: str(a, "reason") ?? "" });
    // t-196: 署名更正。只有本人自报或 human 能发（服务端判），历史不改，被更正的那条不再计入状态。
    case "disown": return emit({ kind: "disown", of: exact(rest, "id")[0], reason: str(a, "reason") ?? "" });
    case "board": {
      exact(rest);
      const b = await client.board(bool(a, "full"));
      console.log(bool(a, "json") ? JSON.stringify(b, null, 2) : fmt.board(b, cfg.me));
      return;
    }
    case "release": {
      exact(rest);
      let b = await client.board(true); // candidates and evidence live on the full board (t-070)
      const target = str(a, "deploy");
      const back = str(a, "rollback");
      if (back !== undefined) {
        // t-223：回滚是第二种合法的发车。走的是「反向提交再往前推」，不强推——所以它与 --deploy 共用同一条推送路径。
        const outcome = await rollback(b, back, {
          git: realGit(process.cwd(), process.env.ATEAM_DEPLOY_TOKEN), me: cfg.me, hasCredential: !!process.env.ATEAM_DEPLOY_TOKEN, anyway: str(a, "anyway"),
          reading: async (key, value, extra) => { await emit({ kind: "reading", key, value, surface: extra.surface, method: extra.method, writes: extra.writes } as ClientEvent); },
          note: async (body) => { await emit({ kind: "note", body }); },
          print: console.log,
        });
        if (outcome === "refused" || outcome === "failed") process.exitCode = 2;
        return;
      }
      if (target === undefined) {
        // t-078: measure with git which candidates production already contains, record it when it changed, then show the three groups
        const g = realGit(process.cwd(), undefined);
        const measured = containment(b, gitIsAncestor(), { has: (sha) => g.resolve(sha) !== null, shallow: () => g.isShallow() });
        const fact = containmentFact(b, measured);
        if (fact) { await emit(fact); b = await client.board(true); }
        // t-219：三种「没测」要分得开——尤其第三种（这棵树解不出上线的 sha），因为它此前会写下一份全是 0 的假事实。
        else if (!measured) {
          const dep = b.release.deployed_sha;
          console.error(!dep ? "（没有测包含关系：生产没有 deployed.sha 事实）"
            : g.resolve(dep) === null ? `（${cannotMeasureHere(dep)}）`
            : "（没有测包含关系：项目没有声明 absorb.form=git-ancestor）");
        }
        if (measured?.unmeasured.length) console.error(`（git 判不出 ${measured.unmeasured.join("、")}：本地没有它们的证据 sha，先 git fetch 各分支）`);
        console.log(bool(a, "json") ? JSON.stringify(b.release, null, 2) : fmt.release(b));
        return;
      }
      const outcome = await deploy(b, target, {
        git: realGit(process.cwd(), process.env.ATEAM_DEPLOY_TOKEN), me: cfg.me, hasCredential: !!process.env.ATEAM_DEPLOY_TOKEN, anyway: str(a, "anyway"),
        reading: async (key, value, extra) => { await emit({ kind: "reading", key, value, surface: extra.surface, method: extra.method, writes: extra.writes } as ClientEvent); },
        note: async (body) => { await emit({ kind: "note", body }); },
        print: console.log,
      });
      if (outcome === "refused" || outcome === "failed") process.exitCode = 2;
      return;
    }
    case "trace": {
      const [target] = exact(rest, "task-id | sha");
      const { events } = await client.log(null);
      const lines = trace(events, target);
      if (!lines) throw new Error(isSha(target) ? `没有任务的完成证据里含 sha ${target}` : `日志里没有任务 ${target}（要按 sha 回溯请给 7–40 位十六进制）`);
      console.log(lines.join("\n"));
      return;
    }
    case "log": {
      exact(rest);
      const { events } = await client.log(str(a, "after") ?? null);
      for (const e of events) console.log(`${e.id}  ${fmt.event(e, cfg.me)}`);
      return;
    }
    /**
     * t-224：**S9 搬家的那条路。** 平台那一侧 t-088 早就做好了（带 `from` 的事件只写一次），而我们指给客户的
     * 这支 CLI 一直送不出 `from`——上线至今 7051 条事件里它出现过 0 次。**一条没有人走得通的路，和没有这条路，
     * 对要搬家的人是同一件事。**
     *
     * 一行一条 JSON，`from` 逐字来自被搬的那份记录。**有一行不合格就一条都不发**：半份搬进去之后人要自己
     * 算「哪几条已经在里面了」，而那正是 `from` 本来替他免掉的活。全改完原样再跑一遍，已经搬过的不会重复。
     */
    case "import": {
      const [file] = exact(rest, "file");
      // `common(a)` 不加在这里：--refs / --writes 是给「一条命令一件事」用的，搬家一次几百条，
      // 把同一份 refs 钉在每一条上说的不是真话。每条记录自己带什么就是什么。
      const r = await runImport(readFileSync(file, "utf8"), (e) => client.emit(e) as Promise<Written>, cfg.me, console.log, console.error);
      if (r.exit) process.exitCode = r.exit;
      recordParts(r.failed);   // t-241：搬家那一路的被拒也进本地那本账，与其余几条命令同一处
      return;
    }
    case "tell": {
      const [to, body] = withBody("to");
      const intent = str(a, "kind") as InstructionIntent | undefined;
      if (to === "human" && !splitTitle(body).title) console.error(`提示：第一句超过 ${TITLE_MAX_CHARS} 字或没有句号，牌桌上这张卡没有标题。把要点写成第一句，用句号断开。`);
      // t-215：`--depends-on surface:key` 声明这张卡活着的条件；那条事实一被 writes 命中，牌桌就标出它可能过期。
      // 与读数那一侧同一个开关名，因为是同一件事——只是读数会失效，卡只被标出来。
      return emit({ kind: "instruction", to, body, intent,
        ack_by: new Date(Date.now() + duration(str(a, "ack-by") ?? "15m")).toISOString(),
        options: list(a, "option"), default: str(a, "default"), depends_on: list(a, "depends-on"),
        valid_until: str(a, "valid-for") ? new Date(Date.now() + duration(str(a, "valid-for")!)).toISOString() : str(a, "valid-until") });
    }
    // t-215 判据 7：给一张**已经发出去的**卡补声明条件。卡是不可变事件，所以补声明是一条后发的事件指着它
    // （与 disown、untell 同一路子）。会按默认结掉的那 3 张卡全比 --depends-on 这个字段老，所以这不是补丁，是主路。
    case "premise": {
      const [of] = exact(rest, "instruction-id");
      const validFor = str(a, "valid-for");
      return emit({ kind: "premise", of, depends_on: list(a, "depends-on"),
        valid_until: validFor ? new Date(Date.now() + duration(validFor)).toISOString() : str(a, "valid-until") });
    }
    case "decide": {
      const [id, option] = exact(rest, "id", "option");
      // t-232：两件事，各自报结果；ack 没成就停下并说「后面没发」（decide.ts 给它带了 stopOnFail）
      await sendAll(await decide({ board: () => client.board() }, id, option));
      return;
    }
    case "reading": {
      const [key, value] = exact(rest, "key", "value");
      const validFor = str(a, "valid-for");
      const measuredAt = str(a, "measured-at") ? measuredAtOf(str(a, "measured-at")!, new Date()) : undefined;
      const from = measuredAt ? Date.parse(measuredAt) : Date.now();
      const shapeRe = str(a, "shape"), shapeEnum = list(a, "enum");
      const shape = shapeRe !== undefined || shapeEnum?.length ? { regex: shapeRe, enum: shapeEnum?.map(parseValue) } : undefined;
      return emit({ kind: "reading", key, value: parseValue(value),
        surface: need(str(a, "surface"), "--surface"), method: str(a, "method"), assumptions: list(a, "assumes"),
        depends_on: list(a, "depends-on"), valid_until: validFor ? new Date(from + duration(validFor)).toISOString() : undefined, shape, measured_at: measuredAt });
    }
    case "say": {
      const [text] = withBody();
      if (cfg.me !== "human") throw new UsageError(`say is the human's: you are ${cfg.me}. Put it in a note instead.`);
      if (text.trim().length > SAID_MAX_CHARS) throw new UsageError(`一句话最多 ${SAID_MAX_CHARS} 字（现在 ${text.trim().length}）；不够就再说一句`);
      return emit({ kind: "note", body: `${SAID_PREFIX}${text.trim()}` });
    }
    case "focus": return emit({ kind: "reading", key: "focus", surface: "team", value: withBody()[0] });
    // t-164 判据 4：不必先 claim 就能问「这块地上还有谁」——在决定做不做之前问，正是该问的时候。
    case "touches": {
      if (!rest.length) throw new UsageError("ateam touches <路径…>：说出你打算动的东西，我告诉你此刻还有谁在动它");
      const lines = await whoElse(client, rest, cfg.me);
      if (lines.length) for (const line of lines) console.log(line);
      else console.log(nobodyElse(rest));
      return;
    }
    case "note": return emit({ kind: "note", body: withBody()[0], decision: bool(a, "decision") || undefined, supersedes: str(a, "supersedes"), task: str(a, "task") });
    case "task": {
      const [op, id, ...more] = rest;
      const given = [id, ...more].filter((x): x is string => x !== undefined);
      if (op !== "create" && op !== "seam" && op !== "criteria") exact(given, "id"); // every other task op takes the id and nothing else
      switch (op) {
        case "show": {
          const { task: t, seams } = await client.task(need(id, "<id>")).catch((err) => { if (err instanceof ClientError && err.status === 404) throw new Error(`no task "${id}" in the log`); throw err; });
          // t-107: the same names the board shows; the role set comes from the board, one extra read
          const nb = await client.board().catch(() => null);
          console.log(fmt.task(t, seams, [], nb ? roleNamer(nb) : undefined)); // GET /task/<id> is the whole task: nothing omitted
          return;
        }
        case "create": {
          const [task, title] = exact([id, ...more].filter((x) => x !== undefined), "id", "title");
          const criteria = list(a, "criteria") ?? [];
          // t-171: 承诺那头的闸，与 done 那头同形状——说一句人会看到什么，或者明写它不改变人看到的东西。
          const impact = bool(a, "no-human-impact") ? { no_human_impact: true } : {};
          await emit({ kind: "task", op: "create", task, title, criteria, shows: str(a, "shows"), ...impact });
          console.log(fmt.created(title, criteria));
          return;
        }
        case "claim": {
          const t = need(id, "<id>");
          const declared = list(a, "touches") ?? [];
          await emit({ kind: "task", op, task: t, touches: declared });
          stampBase(t, "claim");   // t-105: remember where this branch stood, so done can measure what it touched
          // t-164: 认领成功之后说一句这块地上还有谁。不阻塞——claim 已经写进去了，这只是让你一进门就看见屋里有人。
          // 查不到（服务端不可达、板子读不到）就什么都不说：这是一句提示，不该因为它自己出问题而挡住任何人。
          for (const line of await whoElse(client, declared, cfg.me, t).catch(() => [] as string[])) console.error(line);
          return;
        }
        case "done": {
          const task = need(id, "<id>"), evidence = str(a, "evidence");
          // t-151: 一句「人现在能看到什么」，或者明写它对人没有影响。两个都不给，服务端会拒绝并说出这两条出路。
          const impact = bool(a, "no-human-impact") ? { no_human_impact: true } : {};
          // t-170 (pd 08:33)：碰了人可见的文件时的具名出路——「文件#符号」，具体到符号才算数。
          const internal = list(a, "internal-only")?.length ? { internal_only: list(a, "internal-only")! } : {};
          // t-105: what this task actually touched, measured from the branch; --touches adds what a diff cannot see
          const rev = touchesAtDone(task, await client.task(task).then((x) => x.task.touches ?? []).catch(() => [] as string[]), list(a, "touches") ?? [], bool(a, "no-touches"), bool(a, "touches-only"));
          // t-209：把这一轮的起点也记进事件。CLI 一直知道它（claim 时 stampBase 戳的），但它只活在本机的
          // .ateam/base.<task> 里——日志里没有，于是「这条提交属于哪件任务」在别的机器上只能靠可达性猜，
          // 而那样任何一条孤儿提交被后来的任务盖在下面就消失（qa 14:29 在真仓库上量到 9ac8cee 正是这样没的）。
          const baseSha = gitDiff().base(task) ?? undefined;
          for (const line of rev.lines) console.error(line);
          // t-201：--no-seam-check 是把所有接缝义务一起免掉的那把钥匙，留着但不再是唯一的出路；
          // --no-seam-check-for <接缝 id | 对方任务 id> 只免一条，其余照判，且被免的那条会随 done 落在日志上。
          const waived = list(a, "no-seam-check-for") ?? [];
          if (bool(a, "no-seam-check")) console.error(WHOLE_GATE_OFF);
          else {
            const b = await client.board();
            const check = seamCheck(b, task, evidence, gitIsAncestor(), gitHasObject(), waived);
            if (check.errors.length) throw new UsageError(check.errors.join("\n"));
            for (const u of check.unverified) console.error(`警告：${u}`);
            for (const w of seamWarnings(b, task, evidence, gitIsAncestor())) console.error(`警告：${w}`);
            // t-228：这条命令要发三种事件（done、退回说明、解决接缝），从此每一件各自报结果——
            // 在这之前，后面任何一件被拒都会让「done 已经落库」这个事实在终端上消失。
            await sendAll([
              { what: PART_NAMES.done(task), event: { kind: "task", op, task, evidence, shows: str(a, "shows"), ...impact, ...internal, touches: rev.touches, ...(rev.changed_files === undefined ? {} : { changed_files: rev.changed_files }), ...(baseSha ? { base_sha: baseSha } : {}) } as ClientEvent },
              // t-074: a fallback is never silent — what could not be verified goes on record next to the done
              ...(check.unverified.length ? [{ what: PART_NAMES.seamFallback(), event: { kind: "note", body: `接缝检查退回（无法验证吸收）：${check.unverified.join("；")}`, task } as ClientEvent }] : []),
              // t-073: seams this done settles by itself: recorded right after, with the basis
              ...check.absorbs.map((e) => ({ what: PART_NAMES.seamAbsorb((e as { a?: string }).a ?? "", (e as { b?: string }).b ?? ""), event: e })),
            ]);
            return;
          }
          return emit({ kind: "task", op, task, evidence, shows: str(a, "shows"), ...impact, ...internal, ...(rev.changed_files === undefined ? {} : { changed_files: rev.changed_files }), ...(baseSha ? { base_sha: baseSha } : {}) });
        }
        case "verify": {
          if (bool(a, "pass") === bool(a, "fail")) throw new Error("say --pass or --fail");
          const task = need(id, "<id>");
          // t-191：落 pass 之前先问一句——挡着它的那几条接缝里，有没有是因为「对方 claim 了却还没写代码」
          // 而无从判定的。判在这一头，因为服务端没有仓库（同 t-160 判据 6）。判不了的照旧挡着，只说一句。
          // fail 不走这一段：一条接缝从来只挡 pass，不挡「它坏了」这条消息（t-112）。
          const verdict = { kind: "task", op, task, surface: str(a, "surface") ?? "", pass: bool(a, "pass"), evidence: str(a, "evidence"), shows: str(a, "shows") } as ClientEvent;
          // t-232：接缝那几条与判决本身从此走 done 那一路同一个公共层，组装在 verifyparts.ts（用例测的就是它）
          const need_ = bool(a, "pass") && !bool(a, "no-seam-check");
          const v = verifyParts(need_ ? await client.board() : ({ seams: [], tasks: {} } as unknown as Board), task, verdict,
            { commitsSince: gitCommitsSince(), changedSince: gitChangedSince() }, need_);
          for (const n of v.notes) console.error(n);   // 整句（含「警告：」）来自 core：这里不新造一句人可见的话
          await sendAll(v.parts);
          return;
        }
        case "block": return emit({ kind: "task", op, task: need(id, "<id>"), on: str(a, "on") ?? "" });
        case "unblock": {
          // t-157 判据 3：**unblock 与 reopen 一视同仁——都是新的一轮，都要移动本轮起点。**
          // 之前它落在 claim 那一边（baseAt("claim", …) 保留原来的起点），于是解除阻塞之后那一轮的账从上一轮的
          // 起点算起，出路只有手改 .ateam/base.<id>；而 t-135 自己说过：只能靠手改的闸，是人学会绕开的闸。
          const t = need(id, "<id>");
          const e = await emit({ kind: "task", op, task: t });
          stampBase(t, "reopen");
          return e;
        }
        case "withdraw": return emit({ kind: "task", op, task: need(id, "<id>"), reason: str(a, "reason") ?? "" });
        case "obsolete": return emit({ kind: "task", op, task: need(id, "<id>"), decision: str(a, "by") ?? "", reason: str(a, "reason") });
        case "reopen": {
          const t = need(id, "<id>");
          const e = await emit({ kind: "task", op, task: t, reason: str(a, "reason") ?? "" });
          stampBase(t, "reopen");   // t-135: a new round is measured from where the round started, not from the first claim
          return e;
        }
        // t-166: two things a criterion can have done to it, and neither is an edit — one more is appended, or an
        // existing one is marked as having moved to another task. The text itself is never touched: ids are forever
        // and so is what was written under them.
        case "criteria": {
          const sub = given[0];
          if (sub === "moved") {
            const [, task, index] = exact(given, "moved", "id", "criterion-number");
            const to = str(a, "to");
            if (!to) throw new UsageError(`task criteria moved <id> <criterion-number> --to <task-id>: say which task took it over`);
            return emit({ kind: "task", op, task, moved: { index: Number(index), to } });
          }
          const [, task, text] = exact(given, "add", "id", "text");
          if (sub !== "add") throw new UsageError(`task criteria ${sub}: only "add" and "moved" exist (criteria are never edited; ids are forever)`);
          return emit({ kind: "task", op, task, add: [text] });
        }
        // t-149: --verdict/--missed judge the *gate*, separately from what the resolution does about the two tasks.
        // Both optional: a resolution that does not judge the gate says nothing about it, and the gate's own line
        // counts it as unjudged rather than as either answer.
        case "seam": {
          const [x, y] = exact([id, ...more].filter((v) => v !== undefined), "a", "b");
          const verdict = str(a, "verdict") as SeamVerdict | undefined;
          if (verdict !== undefined && !SEAM_VERDICTS.includes(verdict)) throw new Error(`--verdict must be one of ${SEAM_VERDICTS.join(" | ")}`);
          return emit({ kind: "task", op, tasks: [x, y], resolution: str(a, "resolution") ?? "", ...(verdict ? { verdict } : {}), ...(bool(a, "missed") ? { missed: true } : {}) });
        }
        default: throw new Error(`unknown task op "${op}"`);
      }
    }
    default:
      throw new Error(`unknown command "${cmd}". Try: ateam help`);
  }
}

/**
 * t-164: 这块地上还有谁。一句话都不说，是「没有别人」，不是「没查」——查不动时调用方吞掉异常，所以这里
 * 只管算，不管兜底。板子取的是瘦身板：在途那几件的触点就在里面（t-164 一并留下的），不必拉完整板。
 */
async function whoElse(client: { board: (full?: boolean) => Promise<Board> }, touches: string[], me: string, exclude?: string): Promise<string[]> {
  if (!touches.length) return [];
  const others = (b: Board) => Object.values(b.tasks ?? {}).flat().filter((t) => t.status === "working" && t.owner && t.owner !== me && t.id !== exclude);
  let b = await client.board();
  // A server from before t-164 leaves working tasks' touches out of the slim board, and then every answer here is
  // 「没有别人」 — the wrong answer, given silently, which is the failure this whole command exists to prevent.
  // So: if somebody is working and nobody has touches, that is the old shape, not an empty field. Ask for the full one.
  const some = others(b);
  if (some.length && !some.some((t) => t.touches)) b = await client.board(true);
  const working = others(b).filter((t) => t.touches?.length);
  const who = roleNamer(b);
  const out: string[] = [];
  for (const t of working.sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const overlap = overlapOf(touches, t.touches!);
    if (overlap.length) out.push(alsoHere(who(t.owner!), t.id, t.title, overlap));
  }
  return out;
}

/**
 * t-102: after any command but `watch` itself, tell this node — and only this node — that its own watch stopped.
 * On stderr so `board --json` stays pipeable while a person still reads it at the end of the output. Best effort:
 * a node with no config, or no readable .ateam/, simply has nothing to say.
 */
/**
 * t-116: a refusal is visible for exactly one second — the moment it happens. At 01:11 I read a successful `tell` and
 * told two people a task was done; its `done` had been refused seconds earlier and I never looked back. So the node
 * writes down its last refusal and says it again on the next `sync` or `board`, until the same action goes through or
 * the person crosses it off. Local, like the deaf notice: no event, no log line — a refusal is this node's business.
 */
function refusalFile(me: string) { return join(process.cwd(), ".ateam", `refused.${me}`); }
function meOf(): string | null {
  try {
    const file = configFile();
    const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
    return process.env.ATEAM_ME || stored.me || null;
  } catch { return null; }
}
/** Called when a write is refused: remember it. Called after any command succeeds: cross off the one it redid. */
function noteRefusal(argv: string[], refusal: Refusal | null): void {
  try {
    const me = meOf();
    if (!me) return;
    const path = refusalFile(me);
    if (refusal) { mkdirSync(join(process.cwd(), ".ateam"), { recursive: true }); writeFileSync(path, JSON.stringify(refusal)); return; }
    // a success crosses off a refusal of the *same* action, and nothing else: redoing `task claim` does not clear a refused `task done`
    const st = readRefusal(existsSync(path) ? readFileSync(path, "utf8") : null);
    if (st.kind === "open" && st.refusal.what !== actionOf(argv)) return;
    if (existsSync(path)) rmSync(path, { force: true });
  } catch { /* the record is a convenience; never let it break the command */ }
}
/** The reminder itself, on the commands a turn starts with. `--clear-refused` crosses it off by hand. */
function sayIfRefused(argv: string[]): void {
  try {
    if (argv[0] !== "sync" && argv[0] !== "board") return;
    const me = meOf();
    if (!me) return;
    const path = refusalFile(me);
    if (argv.includes("--clear-refused")) { if (existsSync(path)) rmSync(path, { force: true }); console.error("已划掉上一次被拒的写入。"); return; }
    const st = readRefusal(existsSync(path) ? readFileSync(path, "utf8") : null);
    const line = refusalNotice(st, new Date());
    if (line) console.error(line);
    // t-233：**「已经办好了」那一类说完就划掉。** 它没有「重做一次就会消失」这条出路（再做一次只会再被拒），
    // 留着就会每一次 sync 都再说一遍同一件不用做的事——一个说不完的提醒，和一个不起作用的期限是同一个病。
    if (line && clearsAfterNotice(st) && existsSync(path)) rmSync(path, { force: true });
  } catch { /* same */ }
}

function sayIfDeaf(argv: string[]): void {
  try {
    if (argv[0] === "watch") return;
    const file = configFile();
    const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
    const me = process.env.ATEAM_ME || stored.me;   // just the identity: a half-configured node still deserves the reminder
    if (!me) return;
    const path = join(process.cwd(), ".ateam", `watch.${me}.lock`);
    // t-137: two ways of not listening, told apart. The heartbeat file says whether this node's own watch died; the
    // header the server sent says whether the server has seen it pull. Same place, same shape, never one verdict.
    const st = watchState(existsSync(path) ? readFileSync(path, "utf8") : null, new Date());
    for (const line of listeningNotices(st, pullIdle(seen.pullIdle))) console.error(line);
  } catch { /* never let the reminder break the command that carried it */ }
}

/**
 * t-218 判据 2：**捎在下一次通信里。** 被拒的那一刻只往本地队列里追一行；这里是「下一次通信」——
 * 一条跑通的命令末尾，把队里的捎给服务，**服务说记下了哪几条才划掉哪几条**。
 *
 * 三条都是有意的：① 捎不上去不吭声也不改退出码（这是顺带说的一句，不是这条命令的活，同 recordCliSha）；
 * ② 队空就一个请求都不发；③ 服务回 `counted: false`（那个存储没有这本账）时一条都不划——
 * **「其实没记下却当成记下了」正是这件任务在修的那个病**。
 */
async function shipRefusals(): Promise<void> {
  try {
    const me = meOf();
    if (!me) return;
    const queued = pendingRefusals(process.cwd(), me);
    if (!queued.length) return;
    const cfg = loadConfig();
    const { recorded } = await new Client(cfg).reportRefusals(queued.slice(0, CLI_REFUSAL_BATCH_MAX));
    clearRefusals(process.cwd(), me, recorded);
  } catch { /* 没捎成就还在队里，下一条命令再捎 */ }
}

const ARGV = process.argv.slice(2);
main(ARGV).then(async () => {
  // t-241：**「这条命令成了」才划掉上一条被拒的**。一条一次发多件的命令里有一件被拒时，它照旧走到这里
  // （被拒不再掀翻整条命令，t-228），于是这一行会把刚刚记下的那条当场划掉——**记了等于没记**。
  // 退出码是这件事唯一的真凭据：非 0 就是「有东西没落下去」。
  if (!process.exitCode) noteRefusal(ARGV, null);
  await shipRefusals(); sayIfRefused(ARGV); sayIfDeaf(ARGV);
}).catch((err) => {
  // the reminders go last, after whatever this command had to say — including its failure
  const bye = (code: number, rule?: string, local = false, already?: { at: string | null }) => {
    // quote what a shell would need quoted, so the line can be pasted back verbatim
    const shell = (a: string) => (/[\s"'$`\\]/.test(a) ? `"${a.replace(/(["\\$`])/g, "\\$1")}"` : a);
    const at = new Date().toISOString();
    // t-233：**类别跟着记下来。** 提醒要分得清「那件事没发生」与「那件事已经发生过了」，而分辨的依据是
    // 拒绝自己带的那一样东西，不是提醒去猜。
    if (rule) noteRefusal(ARGV, { at, rule, cmd: `ateam ${ARGV.map(shell).join(" ")}`, what: actionOf(ARGV), ...(already ? { already } : {}) });
    // t-218：**只有本地抛的那几种要记进队**。服务端 409 那一路在它那边的唯一出口已经记过了（t-212），
    // 这里再记一遍就是同一次拒绝数两遍——而「两个数说同一件事」是这份日志里数了一整天的毛病。
    const me = local && rule ? meOf() : null;
    if (me) queueRefusal(process.cwd(), me, { at, rule: rule!, op: cliOpOf(ARGV) });
    sayIfRefused(ARGV);
    sayIfDeaf(ARGV);
    process.exit(code);
  };
  // t-225 判据 3：**死因要走 stdout。**
  //
  // 看它的进程（Monitor、别人手写的轮询、任何 `cmd | grep`）只把 stdout 当事件流，而这条命令行的每一种失败
  // 都只写 stderr（frontend 18:34 量的那 238 字节、我 repo:cli.errors_stream 量的四支统一出口）。于是一次
  // 「200 带坏正文」在看守那儿长成这样：**没有任何输出，只有一个退出码**——与「今天很安静」不可区分。
  //
  // 所以退出前在 stdout 上留一行，不取代 stderr 那一行（人盯着终端时两处都看得见，管道只看得见这一处）。
  const lastWords = (line: string) => console.log(`ateam: ${line}`);
  if (err instanceof BadResponse) {
    console.error(err.message);
    lastWords(err.message);
    // 游标一个字节没动（advance 只收字符串或 null），退出码不是 1——好让看守分得清「坏响应」和「它自己崩了」
    return bye(3);
  }
  if (err instanceof ClientError) {
    const line = err.status === 409 ? `REJECTED (${err.body.rule}): ${err.body.message}` : `server ${err.status}: ${err.message}`;
    console.error(line);
    lastWords(line);
    return bye(err.status === 409 ? 2 : 1, err.status === 409 ? err.body.rule : undefined, false, err.body.already);
  }
  if (err instanceof ShapeError) { console.error(err.message); lastWords(err.message); return bye(2); } // t-080: a newer server, said plainly
  if (err instanceof Rejected) { console.error(`REJECTED (${err.rule}): ${err.message}`); lastWords(`REJECTED (${err.rule}): ${err.message}`); return bye(2, err.rule, true, err.already); }
  if (err instanceof UsageError) { console.error(`usage: ${err.message}`); lastWords(`usage: ${err.message}`); return bye(2, "usage", true); }
  const what = err instanceof Error ? err.message : String(err);
  console.error(what);
  lastWords(what);
  return bye(1);
});
