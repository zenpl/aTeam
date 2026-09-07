/**
 * t-131: board() had a cliff — 3.65ms at 2800 events, 131ms at 3725. 74% of it was in the similarity pass that
 * allocation() runs over instruction bodies: every pairing re-cut both bodies into bigrams, so a busy hour of long
 * messages cost quadratically in text length as well as in pairs.
 *
 * The speed-ups here must not change a single answer, so that is what these tests pin: the fast path is compared
 * against the plain definition, not against itself.
 */
import { describe, it, expect } from "vitest";
import { similarity, similarAtLeast, type GramCache } from "../src/allocation.js";

/** The definition, written the slow obvious way: what the optimised path has to agree with. */
function plain(a: string, b: string): number {
  const grams = (x: string) => {
    const cs = [...x.replace(/\s+/g, "")];
    const g = new Set<string>();
    for (let i = 0; i + 1 < cs.length; i++) g.add(cs[i] + cs[i + 1]);
    return g;
  };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}

const CORPUS = [
  "", "a", "ab", "abc",
  "请把牌桌地址整条粘进来", "请把牌桌地址整条粘进来。", "请把牌桌地址整条粘进来，或只粘 k= 后面那一段",
  "t-131：曲线量出来了", "t-131：曲线量出来了，而它推翻了判据 1 的前提",
  "完全不相干的一句话", "外呼卡正文末尾加一句：不想要就点不要了，之后不再问你",
  "外呼卡正文末尾加一句：不想要就点不要了", "aaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaab",
  "  空白   会被   去掉  ", "空白会被去掉",
];

describe("t-131 · 快的那条路必须给出一模一样的答案", () => {
  it("similarity agrees with the plain definition on every pair, including empty and whitespace-only differences", () => {
    for (const a of CORPUS) for (const b of CORPUS) {
      expect(similarity(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBeCloseTo(plain(a, b), 12);
      // and it is symmetric, which the small-set-first loop must not break
      expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 12);
    }
  });

  it("similarAtLeast answers exactly what comparing the ratio would, at every threshold", () => {
    for (const min of [0, 0.3, 0.6, 0.9, 1]) {
      for (const a of CORPUS) for (const b of CORPUS) {
        expect(similarAtLeast(a, b, min), `${min}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(plain(a, b) >= min);
      }
    }
  });

  it("the size filter and the early exit never reject a pair that would have passed", () => {
    // pairs built to sit right at the boundary: same text plus a growing tail
    const base = "牌桌上那一行灰字说的是能不能送到，不是有没有配";
    for (let extra = 0; extra < 40; extra++) {
      const b = base + "补".repeat(extra);
      for (const min of [0.5, 0.6, 0.7, 0.8]) expect(similarAtLeast(base, b, min), `extra=${extra} min=${min}`).toBe(plain(base, b) >= min);
    }
  });

  it("a shared cache cuts each distinct text once, however many pairings it takes part in", () => {
    const cache: GramCache = new Map();
    const texts = CORPUS.slice(0, 8);
    let pairs = 0;
    for (const a of texts) for (const b of texts) { similarAtLeast(a, b, 0.6, cache); pairs++; }
    expect(pairs).toBe(texts.length * texts.length);
    // one entry per distinct text — not one per pairing, which is what made the board slow
    expect(cache.size).toBe(new Set(texts).size);
  });

  it("passing no cache still works: the cache is an optimisation, not a requirement", () => {
    expect(similarAtLeast("abc", "abc", 1)).toBe(true);
    expect(similarity("abc", "abd")).toBeCloseTo(plain("abc", "abd"), 12);
  });
});
