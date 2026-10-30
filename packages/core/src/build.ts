/**
 * t-062: build a log the way the server builds one. Every constructor goes through `append`, so the field names are
 * the server's (the types say so) and an illegal move (done before claim, verifying your own task) is rejected while
 * you build, not discovered after you drew a conclusion. `pull` records deliveries and cursors with the real field
 * names (Delivery.event_id, Cursor.last_event_id) and the clock stamps ids and times, so ULID time bits are true.
 */
import { MemoryStore, append } from "./store.js";
import { ulidAt } from "./ulid.js";
import { runFollowUps } from "./verifyflow.js";
import { pull, type PullResult } from "./pull.js";
import { reduce, type State } from "./reduce.js";
import { SERVICE_ACTOR } from "./events.js";
import { board, cliShaUnknownCard, projectRoles, type Board } from "./board.js";
import type { Event, NewEvent, Log, TaskOp, ReadingShape, InstructionIntent } from "./events.js";

type Op<K extends TaskOp["op"]> = Omit<Extract<TaskOp, { op: K }>, "op" | "task">;
type ActorLess<T> = Omit<T, "actor">;

export type Step =
  | { kind: "event"; at: string; event: Event; /** what the service appended after it */ followed: Event[] }
  | { kind: "pull"; at: string; actor: string; after: string | null; result: PullResult }
  /**
   * t-278：**有人打开了牌桌**——`GET /board` 那条路上服务会自己发卡（`remindFor`），所以它是一步操作，
   * 不是一次纯读。`sent` 是这一步服务自己追加的那几条，重放的一侧按位置对上 id（同 `followed` 那条口径）。
   */
  | { kind: "remind"; at: string; sent: Event[] };

export interface BuilderOptions {
  human?: string;
  /** Where the clock starts; default one hour ago, so nothing built is in the future. */
  start?: Date | number;
  /** How far the clock moves before each step; default 1 second. */
  stepMs?: number;
}

export class Builder {
  readonly store = new MemoryStore();
  readonly human: string;
  readonly steps: Step[] = [];
  private t: number;
  private readonly stepMs: number;
  private cursors = new Map<string, string | null>();

  constructor(opts: BuilderOptions = {}) {
    this.human = opts.human ?? "human";
    this.t = opts.start === undefined ? Date.now() - 3600_000 : typeof opts.start === "number" ? opts.start : opts.start.getTime();
    this.stepMs = opts.stepMs ?? 1000;
  }

  /** The clock as it stands (the time of the last step). */
  now(): Date { return new Date(this.t); }
  /** Move the clock forward. */
  tick(ms: number): this { this.t += ms; return this; }
  private step(): Date { this.t += this.stepMs; return new Date(this.t); }

  /** Any event, validated against the log so far. Throws Rejected exactly as the server would. */
  async emit(e: NewEvent): Promise<Event> {
    const at = this.step();
    const event = await append(this.store, e, { human: this.human, now: at, mint: ulidAt });
    // what the service appends on its own after this event (a fail notice, a verify ask): the server does the same
    const followed = await runFollowUps(this.store, event, this.human, at, ulidAt);
    this.steps.push({ kind: "event", at: at.toISOString(), event, followed });
    return event;
  }

  reading(actor: string, key: string, value: unknown, opts: { surface?: string; method?: string; assumptions?: string[]; depends_on?: string[]; valid_until?: string; measured_at?: string; shape?: ReadingShape; writes?: string[]; refs?: string[] } = {}): Promise<Event> {
    return this.emit({ kind: "reading", actor, key, value, surface: opts.surface ?? "repo", ...opts });
  }
  /** An instruction. `ackByMs` is how long from now (default 15 minutes); or pass `ack_by` as ISO. */
  tell(actor: string, to: string, body: string, opts: { ackByMs?: number; ack_by?: string; options?: string[]; default?: string; intent?: InstructionIntent; refs?: string[]; writes?: string[] } = {}): Promise<Event> {
    const { ackByMs, ...rest } = opts;
    const ack_by = rest.ack_by ?? new Date(this.t + this.stepMs + (ackByMs ?? 15 * 60_000)).toISOString();
    return this.emit({ kind: "instruction", actor, to, body, ...rest, ack_by });
  }
  ack(actor: string, of: string): Promise<Event> { return this.emit({ kind: "ack", actor, of }); }
  note(actor: string, body: string, opts: { decision?: boolean; supersedes?: string; decides?: { of: string; option: string }; task?: string; refs?: string[]; writes?: string[] } = {}): Promise<Event> {
    return this.emit({ kind: "note", actor, body, ...opts });
  }
  /** Task ops by name: the fields are the server's, the state machine is the server's. */
  task = {
    create: (actor: string, task: string, title: string, criteria: string[], extra: Partial<ActorLess<Op<"create">>> & { refs?: string[] } = {}) => this.emit({ kind: "task", op: "create", actor, task, title, criteria, ...extra }),
    claim: (actor: string, task: string, touches: string[]) => this.emit({ kind: "task", op: "claim", actor, task, touches }),
    done: (actor: string, task: string, extra: Op<"done"> = {}) => this.emit({ kind: "task", op: "done", actor, task, ...extra }),
    verify: (actor: string, task: string, surface: string, pass: boolean, extra: Omit<Op<"verify">, "surface" | "pass"> = {}) => this.emit({ kind: "task", op: "verify", actor, task, surface, pass, ...extra }),
    block: (actor: string, task: string, on: string) => this.emit({ kind: "task", op: "block", actor, task, on }),
    unblock: (actor: string, task: string) => this.emit({ kind: "task", op: "unblock", actor, task }),
    withdraw: (actor: string, task: string, reason: string) => this.emit({ kind: "task", op: "withdraw", actor, task, reason }),
    obsolete: (actor: string, task: string, decision: string, reason?: string) => this.emit({ kind: "task", op: "obsolete", actor, task, decision, reason }),
    reopen: (actor: string, task: string, reason: string) => this.emit({ kind: "task", op: "reopen", actor, task, reason }),
    criteria: (actor: string, task: string, add: string[]) => this.emit({ kind: "task", op: "criteria", actor, task, add }),
    seam: (actor: string, a: string, b: string, resolution: string) => this.emit({ kind: "task", op: "seam", actor, tasks: [a, b] as [string, string], resolution }),
  };

  /** What a node does at the start of a turn: read since its cursor, record the deliveries to it, advance its cursor. */
  async pull(actor: string): Promise<PullResult> {
    const at = this.step();
    const after = this.cursors.get(actor) ?? null;
    // t-257：builder 的这一次拉取就是「一个节点在回合开头做的事」——也就是一次**普通** sync（不带 wait）。
    // 服务端那一侧据此写 `plain_pull_at`，这里不写就会让 built≡served（t-062，它连游标一起比）当场不一致。
    const result = await pull(this.store, actor, after, at, undefined, { plain: true });
    this.cursors.set(actor, result.cursor);
    this.steps.push({ kind: "pull", at: at.toISOString(), actor, after, result });
    return result;
  }

  /**
   * t-278 判据 2：**服务端在 `GET /board` 那条路上（`remindFor`）会自己往日志里发的服务卡，builder 这边也发同一张。**
   *
   * 不发就等于 built≡served（t-062）只在「那张卡没上场」时成立——而它上场的那一天分歧照样在，
   * 只是出现在生产上，而不是一条会红的用例里。所以这不是夹具的副作用，这是夹具的正文。
   *
   * 只发 `cliShaUnknownCard` 这一张：`remindFor` 其余几张（起一个 X、联系方式）在样本里不触发，
   * 而**「此刻不触发」不等于「以后也不会」**——哪一张开始触发，哪一张就该照这条路补进来，t-062 会当场红给你看。
   * 与服务端同一个函数、同一个门槛、同一句话：这里不复制判断，只复制调用。
   */
  async remind(now: Date = this.now()): Promise<Event[]> {
    const state = await this.state(now);
    const out: Event[] = [];
    for (const role of projectRoles(state)) {
      const card = cliShaUnknownCard(state, role, now);
      if (!card) continue;
      out.push(await append(this.store, { kind: "instruction", actor: SERVICE_ACTOR, to: role, body: card,
        ack_by: new Date(now.getTime() + 24 * 3600_000).toISOString() }, { human: this.human, now, mint: ulidAt }));
    }
    this.steps.push({ kind: "remind", at: now.toISOString(), sent: out });
    return out;
  }

  log(): Promise<Log> { return this.store.read(); }
  async state(now: Date = this.now()): Promise<State> { return reduce(await this.log(), now); }
  async board(now: Date = this.now()): Promise<Board> { return board(await this.state(now), this.human, now); }
}
