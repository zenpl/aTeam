import { SEAM_UNDECIDED, SEAM_SAME_FILE, lightSeamLine, DEPLOY_SOURCE, ago as agoOf, waitingUnknownLine } from "@ateam/core";
/**
 * Every UI string on GET /, in one table (docs/board.md, pd). Content written by the team (titles, bodies,
 * criteria, notes, reading values) is never translated. Shipped language: zh. A second language is a second table.
 */
export const UI = {
  title: "aTeam",
  header: "aTeam · 牌桌",
  refreshes: (s: number) => `每 ${s} 秒刷新`,
  buildLabel: "服务器版本",
  sameAs: "与",
  sameAsTail: "同一份数据",

  // 需要你
  needsYou: "需要你",
  nothingForYou: "没有等你的事。",
  kind: { ask: "问你", do: "请你做", tell: "告诉你" } as Record<string, string>,
  askedBy: (who: string, when: string) => `${who} · ${when}`,
  // t-181：这句由 core 的 DEFAULT_LINES 按真状态算出来（board 的 says_default），页面直接印它。
  // 留在这里的是它的名字，不是它的字——之前这一句在任何状态下都说「到期按 X」，包括默认根本还没生效的时候。
  defaultTag: "默认",
  didIt: "做好了",
  notNow: "先不做",
  gotIt: "知道了",
  detail: "细节",
  youJust: "你刚定了：",
  // 起项目第二张卡：你不在时怎么找你 (t-069, pd 21:08)
  // t-117 · pd 01:17: the body ends by saying what the button does. A card whose body teaches the opposite
  // of the button right above it undoes the button (pd: 正文与按钮是一体的，改了一个必须回头读另一个).
  // t-118: 卡上那句话只有一处出处——指令正文（core 的 CONTACT_ASK）。这里不再存第二份问句，
  // 页面渲染时从卡自己的正文拆出标题与正文，pd 改一次就是全改。下面剩的都是按钮与占位符，不是问句。
  contactPlaceholder: "https://…",
  saySomething: "想说一句就说",
  contactSet: (v: string) => `找你用 ${v}`,
  contactNone: "你不在时，我们找不到你。",
  /**
   * t-126 · pd 02:52: an address is recorded but the running version cannot say whether anything ever reached it.
   * 「线上这一版」 rather than 「这台服务」: a person should not have to reason about which build they are talking to,
   * and the words sit directly under the 线上 row where the sha they name is already on screen.
   */
  contactUnknown: "记下了外呼地址，线上这一版还看不出有没有真发成功过。",
  contactInvalid: "填一个 https:// 开头的 webhook 地址",
  youJustDid: "你刚点了：",
  notNowWhy: "点了「先不做」，没写原因",

  answerBelow: "在下面「说一句」就是回答。",
  inviteLine: "要更多 agent，把这个链接给它们：",
  copy: "复制",
  copied: "已复制",
  missing: (min: number) => `缺人 ${min} 分钟`,
  missingNever: "缺人",
  /**
   * t-140 · pd 05:42: the board says only what the server can actually see — how long since this role last read the
   * log. Not 「没在听」: whether it is listening is a state we do not observe. Whether its own watch process died is
   * something only that node knows, and it says so in its own terminal (t-102).
   */
  deaf: (min: number) => `${min} 分钟没读日志了`,
  deafNever: "没读过日志",
  undelivered: (n: number) => `${n} 条还没送到`,
  started: "起好了",

  // 说一句
  say: "说",
  sayPlaceholder: "跟团队说一句：想要什么、什么坏了",
  sayHint: "你说过的会出现在这里，并显示它变成了什么：已收到 → 已成为需求 → 已成为任务。",
  said: "你说过的",
  moreSaid: (n: number) => `还有 ${n} 句`,
  saidStatus: { received: "已收到", requirement: "已成为需求", task: "已成为任务", live: "已上线" } as Record<string, string>,

  // 现在
  now: "现在",
  focus: "焦点",
  noFocus: "还没有焦点",
  setBy: (who: string, when: string) => `${who} 设的，${when}`,
  live: "线上",
  verifiedCount: (n: number) => `在生产上验过 ${n} 件`,
  // t-086: who pushed this version and who only checked which one is live are different claims, and never merged into one.
  // t-162：这两句搬到 core 的 DEPLOY_SOURCE 一处，命令行也用它。这里保留同名入口，页面调用点不必改。
  pushedBy: DEPLOY_SOURCE.pushed,
  checkedBy: DEPLOY_SOURCE.checked,
  noDeployReading: "还没人核对过线上是哪一版",
  thisVersionUnverified: "这一版刚上线，还没在生产验过",
  // t-091: what is verified and still waiting for a deploy, so nobody has to send a card per batch
  waitingDeploy: (n: number) => `${n} 件验过了，等一次上线。`,
  waitingAlsoUnknown: (n: number) => `另有 ${n} 件不知道上没上。`,
  /** t-221：搬进 core 了，两处共用一份（这里只是转手，不再是第二个出处）。 */
  waitingUnknown: waitingUnknownLine,
  // t-095 (S9/M4): the migration check card's result lines; the card itself is worded by the service (t-092)
  migrationOk: "清单对",
  migrationMissing: (who: string | null) => who ? `清单有漏，已让 ${who} 回去补` : "清单有漏",
  migrationPatching: (who: string) => `等 ${who} 补漏`,
  // t-099: where a carried-in task or decision came from (pd 23:42: machine strings are code, after the human words, a
  // link only when the link goes somewhere)
  carriedFrom: "来自",
  // t-110 (pd 00:28 ②③): whether this board has an owner's key yet, in the 谁在 row; a statement, never a card
  noOwnerKey: "这张牌桌还没有主人的钥匙。",
  ownerKeyUnused: "已把牌桌地址给出去了，还没人打开过。",
  thisVersion: "这一版带来了什么",
  earlier: (n: number) => `更早的 ${n} 件`,
  sinceLast: (sha: string) => `自上一版 ${sha} 以来`,
  inFlight: "在途",
  nothingInFlight: "没有在途的事",
  groups: {
    working: "在做",
    blocked: "卡住",
    done: "做完了，等验",
    /**
     * t-152 · pd 06:59: after the split this group is divided by whether it has shipped, not by which surface
     * verified it — so 「仓库」 goes, and it reads as the standing line says it, being the same set of tasks.
     */
    verifiedElsewhere: "验过了，等上线",
    open: "没开始",
    failed: "验收未过",
  } as Record<string, string>,
  items: (n: number) => `${n} 件`,
  moreItems: (n: number) => `还有 ${n} 件`,
  who: "谁在",
  nobody: "还没有人",
  team: "团队",
  coverage: "没人管的事",
  held: (n: number, m: number) => `职责 ${n} 项：${m} 有人`,
  canPushProduction: "能推上线",

  // 其余
  rest: "其余：团队自己的状态",
  restSummary: (agents: number, overdue: number, seams: number, facts: number) => `session 之间的指令 ${agents} · 到期没人选 ${overdue} · 接缝 ${seams} 条未解决 · 事实 ${facts} 条有效`,
  collabReport: "最近一份协作报告：",
  collabNone: "还没有协作报告",
  // t-147: 「逾期」不再是「没回执」。这里只剩一件事：带选项的卡到点了还没有人给答案。没人动的那一堆在它下面，
  // 用 core 算好的三句话（pd 的措辞），这里不另写一遍。
  overdue: "到期没人选",
  overdueLine: (to: string, body: string, from: string) => `${to} 还没有回答 ${from} 的「${body}」`,
  owed: "没人办",
  due: (when: string) => `期限 ${when}`,
  none: "无",
  agentInstructions: "session 之间的指令",
  notPulled: "未拉取",
  decided: "已定",
  chosen: (who: string, option: string) => `${who} 选择了「${option}」`,
  tasks: "任务",
  taskStatus: {
    open: "没开始", working: "在做", blocked: "卡住", done: "做完",
    failed: "验收未过", verified: "验过", withdrawn: "已撤回", obsolete: "已取代",
  } as Record<string, string>,
  criteriaBy: (who: string, when: string) => `验收标准由 ${who} 制定，${when}创建`,
  touches: "涉及",
  evidence: "证据",
  verifiedOn: "验过，在",
  failedOn: "验收未过，在",
  by: "由",
  withdrawnBy: (who: string, when: string) => `${who} 于${when}撤回`,
  obsoleteBy: (decision: string, who: string, when: string) => `已被决策 ${decision} 取代（${who} 于${when}）`,
  decisionTag: "决策",
  // t-133 · pd 03:32: the words are the ones the product already uses. No shipping metaphor, no second vocabulary —
  // a person who has to learn two sets of words has none.
  releaseTitle: "上线",
  releaseNow: "线上这一版",
  releaseNext: "下一次上线",
  releaseBrings: "这次能带上",
  releaseTogether: "必须一起上的几件",
  releaseNothing: "没有可上线的东西。",
  /**
   * pd 05:12: 「按住」 means a person deliberately held it back, so it is not the word for anything else. A unit that
   * is simply not verified yet is waiting, not held; a batch that would roll production back says so in core's own
   * sentence, with nothing of ours in front of it.
   */
  releaseNotVerified: (who: string) => `还没验，带不上：${who}`,
  releaseBatches: "装好的几批",
  /** t-169 (pd 08:13)：已经上过线的那几批不占上线清单的位置，它们属于「已经发生了什么」，列在「线上这一版」那一段下。 */
  releaseShipped: "上过线的几批",
  /** t-129: a batch packed on the head production is actually running has nothing standing in its way. */
  releaseCanGo: "可以推",
  releaseUnitMore: (n: number) => `还有 ${n} 件`,
  releaseFrom: (sha: string) => `从 ${sha} 快进`,
  releaseDetail: "上线详情",
  seams: "接缝",
  openCount: (n: number) => `${n} 条未解决`,
  seamOpen: "未解决",
  olderStale: (n: number) => `另有 ${n} 条更早的已失效`,
  seamsElsewhere: (n: number) => `另有 ${n} 条已解决或先后落地，见各任务页`,
  // t-114 · pd 01:01: the dig layer splits seams in two. A light seam is a heads-up for whoever merges second,
  // never a thing to do — no button, no red, and it is not counted in "N 条未解决".
  // The words live in core (SEAM_UNDECIDED / SEAM_SAME_FILE / lightSeamLine): the CLI says the same thing (pm 01:20).
  seamsUndecided: SEAM_UNDECIDED,
  seamsSameFile: SEAM_SAME_FILE,
  seamLight: lightSeamLine,
  // 任务页 (t-065)
  taskPage: "任务",
  backToBoard: "← 回牌桌",
  taskNotFound: "没有这个任务",
  status: "状态",
  details: "看详情",
  notesCount: (n: number) => `${n} 条留言`,
  forAgents: "给 agent 看的",
  seamWith: "与",
  taskSeams: "接缝",
  seamStacked: "先后落地，不冲突",
  seamResolvedBy: (who: string) => `${who} 已解决`,
  bothTouch: "都涉及",
  readings: "事实",
  readingCount: (v: number, s: number) => `${v} 条有效，${s} 条失效`,
  /** t-155: 已在牌桌别处说过的那几条不在这里重复。不显示 ≠ 不存在，所以说一句、不留一个静默的差额。 */
  saidElsewhere: (n: number) => `另有 ${n} 条牌桌上别处已经说过，这里不重复`,
  /** t-155: 挖层里那一行的名字——一句话上面，值在下面。 */
  rawValue: "它记下来的值",
  valid: "有效",
  stale: "失效",
  assumes: "假设",
  supersededBy: "已被取代",
  invalidatedBy: "已失效，原因",
  expired: "已过期",
  surface: { repo: "仓库", staging: "staging", production: "生产" } as Record<string, string>,

  // token 小页面
  tokenTitle: "输入 token",
  // t-110 (pd 00:28 ④): what the human has is the whole board address, not a key they must cut out of it
  tokenLead: "把牌桌地址整条粘进来，或只粘地址里 k= 后面那一段。",
  tokenLabel: "牌桌地址",
  tokenSubmit: "继续",
  /**
   * t-115 (pd 01:17)：不说「token 不对」——人手上有的是一条地址，不是一个 token，用他没有的词说他手上的东西，
   * 他不知道该找什么；也不说「再试一次」，他会粘同一个东西，除非我们先告诉他形态。
   */
  tokenWrong: "这不像一条牌桌地址。把 agent 给你的那条整个粘进来就行，末尾带 k= 的那种。",
  /** 完整形态、明显的假值，让人一眼对照；不拿真项目名当例子。 */
  tokenExample: "https://ateam.fly.dev/p/demo/?k=xxxxxxxx",
  /**
   * t-115 (pd 01:23)：说形状，不说内容。回显是让人自己去 diff，说形状是直接告诉他差在哪；而一次被拒的粘贴里可能
   * 正含着真钥匙，所以这些句子里不出现原文的任何片段——长度、有没有 k= 这类判断可以说，字符不可以。
   */
  shapeNoKey: "像一条地址，但没找到 k= 那一段。",
  shapeKeyUnknown: "像一条地址，k= 那一段也在，但这张牌桌不认那把钥匙。",
  shapeKeyShort: "像一段钥匙，但长度对不上。",
  shapeKeyUnknownBare: "像一段钥匙，长度也对，但这张牌桌不认它。",
  shapeNoKeyAnywhere: "这一整段里没有 k=。",
  unauthorized: "这个页面需要项目 token。请打开一次",
  unauthorizedTail: "，之后会保存在 cookie 里。",

  /**
   * Relative time, in words — core's ladder, not a second one (t-180). The page used to round and to run its
   * minute band out to 90 minutes, so the same instant read differently here and in a sentence core handed over.
   */
  ago: (sec: number): string => agoOf(Math.max(0, sec) * 1000)!,
  // t-200：core 的 ago 对负数答 null（见 otherSideOfNow）。**页面的决定是「未来的时刻就说刚刚」**，而这个决定
  // 不是这次新做的：两个喂进来的 secAgo 早就写着 Math.max(0, …)（html.ts:166 与 :672）。所以这里的 clamp 是
  // 把那个已经存在的决定说出来、并且放在一处，不是在梯子里又偷偷加一档。这一路的负数只来自钟不同步。
};
