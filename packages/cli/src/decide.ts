import { Rejected, type Board, type ClientEvent, type Event } from "@ateam/core";

/** What `decide` needs from the server: the board to validate against, and a way to emit. */
export interface Decider {
  board(): Promise<Board>;
  emit(e: ClientEvent): Promise<Event>;
}

/**
 * `ateam decide <id> <option>`: choose for an instruction that carries options.
 * Validates against the board BEFORE writing anything, so a bad option emits nothing (t-014):
 * an ack without a decision would make the board say "answered" when nothing was decided (F11).
 * Then acks (if not yet acked) and records the decision note, the same two events POST /decide writes.
 */
export async function decide(client: Decider, of: string, option: string): Promise<Event[]> {
  const b = await client.board();
  const i = b.instructions.find((x) => x.id === of);
  if (!i) throw new Rejected("decide", `${of} is not an instruction in the log`);
  if (!i.options?.length) throw new Rejected("decide", `${of} carries no options; ack it instead`);
  if (!i.options.includes(option)) throw new Rejected("decide", `"${option}" is not one of: ${i.options.join(" | ")}`);
  if (i.chosen) throw new Rejected("decide", `${of} already decided: ${i.chosen.option} by ${i.chosen.by}`);

  const out: Event[] = [];
  if (i.status !== "acked") out.push(await client.emit({ kind: "ack", of }));
  out.push(await client.emit({ kind: "note", body: `decision: ${i.body} -> ${option}`, decision: true, decides: { of, option } }));
  return out;
}
