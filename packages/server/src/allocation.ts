/**
 * t-061: the service writes 分配预警 as the fact project:allocation. Pure: given the state, the reading to append, or null
 * when the current fact still stands (same patterns, within the period). One entry per pattern, each with its numbers.
 */
import { allocation, ALLOCATION_KEY, ALLOCATION_PERIOD_MS, SERVICE_ACTOR, PROJECT_SURFACE, type NewEvent, type State, type AllocationWarning } from "@ateam/core";

export function currentAllocationFact(s: State): { at: string; warnings: AllocationWarning[] } | null {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ALLOCATION_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  if (!r || !r.valid || r.expired) return null;
  const v = r.reading.value as { warnings?: unknown };
  return { at: r.reading.at, warnings: Array.isArray(v?.warnings) ? (v.warnings as AllocationWarning[]) : [] };
}

export function allocationFact(s: State, human: string, now: Date): NewEvent | null {
  const warnings = allocation(s, now, human);
  const current = currentAllocationFact(s);
  const patterns = (ws: AllocationWarning[]) => ws.map((w) => w.pattern).join("|");
  if (current && patterns(current.warnings) === patterns(warnings) && now.getTime() - Date.parse(current.at) < ALLOCATION_PERIOD_MS) return null;
  if (!current && !warnings.length) return null; // nothing to say, nothing said before: no fact yet
  return {
    kind: "reading", actor: SERVICE_ACTOR, surface: PROJECT_SURFACE, key: ALLOCATION_KEY,
    value: { count: warnings.length, warnings },
    method: "服务按 responsibilities.md「分配预警」从角色声明与最近 4 小时日志算出；每种模式每期最多一条",
    valid_until: new Date(now.getTime() + ALLOCATION_PERIOD_MS).toISOString(),
  };
}
