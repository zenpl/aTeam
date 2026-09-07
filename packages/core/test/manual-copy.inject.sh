#!/bin/sh
# t-179 判据 3：这道闸真的会红，而且是通用的——不是只认被钉过的那几句。
#
# 三次注入，每次都从干净的树开始，跑完自己恢复。在 repo 根目录跑：
#   sh packages/core/test/manual-copy.inject.sh
#
# ① 把一句从来没被钉过的 core 中文抄进说明书  → 应该红（这是判据 2：通用，不是逐句）
# ② 改 core 那句的字，不动说明书              → 说明书跟着变，不会一声不吭（判据 1）
# ③ 只抄命令名与开关                          → 不该红（判据 3 的反例）
set -e
cd "$(dirname "$0")/../../.."
MD=packages/core/manual/common.md
EV=packages/core/src/events.ts

restore() { git checkout -- "$MD" "$EV" 2>/dev/null || true; }
trap restore EXIT

red() { pnpm --filter @ateam/core test >/tmp/t179.log 2>&1 && echo "  ✗ 没红——这道闸没抓到" || echo "  ✓ 红了：$(grep -m1 -o '说明书里还有第二份.*\|to have a length of.*' /tmp/t179.log || echo '见 /tmp/t179.log')"; }
green() { pnpm --filter @ateam/core test >/tmp/t179.log 2>&1 && echo "  ✓ 绿的（不该报的没报）" || { echo "  ✗ 误报了"; grep -m3 '×' /tmp/t179.log; }; }

echo "① 抄一句没被钉过的 core 中文进说明书"
restore
printf '\n一件任务里，接缝是两个人碰到同一处地方。\n' >> "$MD"
python3 - "$EV" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
s += '\nexport const T179_PROBE = "一件任务里，接缝是两个人碰到同一处地方。";\n'
open(p, "w", encoding="utf8").write(s)
PY
red

echo "② 改 core 那句的字，说明书跟着变"
restore
python3 - "$EV" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
s = s.replace("空着不算「没影响」，只说明没人问过这个问题", "空着不算「没影响」——改这一句是为了看说明书跟不跟着变", 1)
open(p, "w", encoding="utf8").write(s)
PY
pnpm --filter @ateam/core build >/dev/null 2>&1
node --input-type=module -e '
import { manual } from "./packages/core/dist/manual.js";
const m = manual("dev");
console.log(m.includes("改这一句是为了看说明书跟不跟着变") ? "  ✓ 说明书跟着变了" : "  ✗ 说明书没变——那就是两份");
'
restore
pnpm --filter @ateam/core build >/dev/null 2>&1

echo "③ 只抄命令名与开关，不该红"
restore
printf '\n再说一次：`ateam task done <id> --evidence "..."` 与 `--no-human-impact`。\n' >> "$MD"
green

restore
pnpm --filter @ateam/core build >/dev/null 2>&1
echo "恢复完毕"
