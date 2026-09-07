#!/bin/sh
# t-179 判据 3：这道闸真的会红，而且是**通用的**——不是只认被钉过的那几句。
#
# 在 repo 根目录跑：  sh packages/core/test/manual-copy.inject.sh
#
# ① 把一句从来没被钉过的 core 中文抄进说明书  → 该红（判据 2：通用，不是逐句）
# ② 改 core 那句的字，不动说明书              → 说明书跟着变，不是一声不吭（判据 1）
# ③ 只抄命令名与开关                          → 不该红（判据 3 的反例）
#
# **恢复用的是文件副本，不是 git。** 上一版用 `git checkout --` 恢复，跑的时候把同一批文件上还没提交的改动
# 一起冲掉了（我自己被冲过一次）。一个证明用的脚本不该有能力删掉别人正在写的东西。
set -e
cd "$(dirname "$0")/../../.."
MD=packages/core/manual/common.md
EV=packages/core/src/events.ts
BAK=$(mktemp -d)
cp "$MD" "$BAK/common.md"
cp "$EV" "$BAK/events.ts"

restore() {
  cp "$BAK/common.md" "$MD"
  cp "$BAK/events.ts" "$EV"
}
cleanup() { restore; pnpm --filter @ateam/core build >/dev/null 2>&1 || true; rm -rf "$BAK"; }
trap cleanup EXIT

GUARD='t-179 · core 的句子在说明书里没有第二份'
run() { pnpm --filter @ateam/core test >"$BAK/log" 2>&1; }
# 只认这道闸红，别的测试红了不算数——否则「红了」可能是别处的问题
guard_failed() { grep -q "FAIL.*$GUARD" "$BAK/log"; }

echo "① 抄一句没被钉过的 core 中文进说明书"
printf '\n一件任务里，接缝是两个人碰到同一处地方。\n' >> "$MD"
printf '\nexport const T179_PROBE = "一件任务里，接缝是两个人碰到同一处地方。";\n' >> "$EV"
if run; then echo "  ✗ 没红——这道闸没抓到"; else
  if guard_failed; then echo "  ✓ 这道闸红了："; grep -A12 "× $GUARD" "$BAK/log" | grep -E "说明书里此刻有|→ manual/" | sed 's/^ */    /' ; else echo "  ✗ 红的是别的测试，不是这道闸"; fi
fi
restore

echo "② 改 core 那句的字，说明书跟着变"
python3 - "$EV" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = "空着不算「没影响」，只说明没人问过这个问题"
assert old in s, "找不到那句常量，注入没生效"
open(p, "w", encoding="utf8").write(s.replace(old, "空着不算「没影响」——改这一句是为了看说明书跟不跟着变", 1))
PY
pnpm --filter @ateam/core build >/dev/null 2>&1
node --input-type=module -e '
import { manual } from "./packages/core/dist/manual.js";
const m = manual("dev");
console.log(m.includes("改这一句是为了看说明书跟不跟着变") ? "  ✓ 说明书跟着变了（同一处出处）" : "  ✗ 说明书没变——那就是两份");
'
restore
pnpm --filter @ateam/core build >/dev/null 2>&1

echo "③ 只抄命令名与开关，不该红"
printf '\n再说一次：`ateam task done <id> --evidence "..."` 与 `--no-human-impact`。\n' >> "$MD"
if run; then echo "  ✓ 绿的（不该报的没报）"; else
  if guard_failed; then echo "  ✗ 误报了：命令名被当成抄的"; grep -m3 '×' "$BAK/log"; else echo "  ✓ 这道闸没报（红的是别的测试）"; fi
fi
restore

echo "恢复完毕（用的是文件副本，git 没被碰过）"
