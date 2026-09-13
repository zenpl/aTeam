import { PART_NAMES, Rejected, type Board, type ClientEvent } from "@ateam/core";
import type { Part } from "./send.js";

/** What `decide` needs from the server: the board to validate against. 发是调用方的事（t-232）。 */
export interface Decider {
  board(): Promise<Board>;
}

/**
 * `ateam decide <id> <option>`: choose for an instruction that carries options.
 * Validates against the board BEFORE writing anything, so a bad option emits nothing (t-014):
 * an ack without a decision would make the board say "answered" when nothing was decided (F11).
 * Then acks (if not yet acked) and records the decision note, the same two events POST /decide writes.
 *
 * t-232：**这里只把要发的两件排好，不自己发**。两件之间有先后——「记下决定」靠那次 ack，所以 ack 带着
 * `stopOnFail`：它没成就停下并把「后面没发」印出来。在这之前是靠 `emit` 抛出来中止的，**而异常当控制流的
 * 代价是终端上看不出「没发」与「本来就只有一件」的差别**。
 */
export async function decide(client: Decider, of: string, option: string): Promise<Part<ClientEvent>[]> {
  const b = await client.board();
  const i = b.instructions.find((x) => x.id === of);
  if (!i) throw new Rejected("decide", `${of} is not an instruction in the log`);
  if (!i.options?.length) throw new Rejected("decide", `${of} carries no options; ack it instead`);
  if (!i.options.includes(option)) throw new Rejected("decide", `"${option}" is not one of: ${i.options.join(" | ")}`);
  // a default that took effect at ack_by (t-022) is still the human's to override; a real decision is final
  if (i.chosen && i.chosen.by !== "default") throw new Rejected("decide", `${of} already decided: ${i.chosen.option} by ${i.chosen.by}`, { at: i.chosen.at ?? null });

  const out: Part<ClientEvent>[] = [];
  if (i.status !== "acked") out.push({ what: PART_NAMES.decideAck(of), event: { kind: "ack", of } as ClientEvent, stopOnFail: true });
  out.push({ what: PART_NAMES.decideNote(of, option), event: { kind: "note", body: `decision: ${i.body} -> ${option}`, decision: true, decides: { of, option } } as ClientEvent });
  return out;
}
