#!/bin/sh
# t-185 判据 2：三道闸的范围**真的**扩到了那些文件——往范围之外加一句，它必须红。
#
# 在 repo 根目录跑：  sh packages/core/test/scan-range.inject.sh
#
# 这里改的是磁盘上的真文件（内存里的注入写在 scan-range.test.ts 里，两种都留着：内存那份逐个文件证一遍并且
# 跑在 CI 里，这份证的是「闸读的确实是磁盘上的这些文件」）。
# **恢复用文件副本，不用 git** —— 同一批文件上可能有别人还没提交的改动，一个证明用的脚本不该有能力删掉它们。
set -e
cd "$(dirname "$0")/../../.."
BAK=$(mktemp -d)
save() { mkdir -p "$BAK/$(dirname "$1")"; cp "$1" "$BAK/$1"; }
restore() { for f in $FILES; do cp "$BAK/$f" "$f"; done; }

FILES="packages/server/src/alerts.ts packages/core/src/rules.ts packages/core/manual/roles/dev.md"
for f in $FILES; do save "$f"; done
cleanup() { restore; rm -rf "$BAK"; }
trap cleanup EXIT

check() { # <标题> <该红的 describe 片段> <跑哪个包>
  if pnpm --filter "$3" test >"$BAK/log" 2>&1; then
    echo "  ✗ 没红——这道闸看不见刚加的那一句"
  elif grep -q "FAIL.*$2" "$BAK/log"; then
    echo "  ✓ 红了：$(grep -m1 -E '存量没变|不在名单里|会说人话' "$BAK/log" | sed 's/^ *//' | cut -c1-110)"
  else
    echo "  ✗ 红的是别的测试，不是这道闸"; grep -m3 '×' "$BAK/log"
  fi
}

echo "① 存量那道闸：往老名单之外的 alerts.ts（发到人手机上的告警就在这儿）加一句"
printf '\nconst 探针 = "这是一句注入进来的、人会读到的中文。";\n' >> packages/server/src/alerts.ts
check "存量" "t-185" "@ateam/core"
restore

echo "② KEY_SYMBOLS 那道闸：往老范围之外的 rules.ts 加一个会说人话的新符号"
printf '\nexport const 探针常量 = "这是一句注入进来的、人会读到的中文。";\n' >> packages/core/src/rules.ts
check "KEY_SYMBOLS" "t-170" "@ateam/core"
restore

echo "③ 说明书那道闸：往 roles/ 底下（老范围要靠第二段代码才走得到）抄一句 core 的话"
printf '\n空着不算「没影响」，只说明没人问过这个问题\n' >> packages/core/manual/roles/dev.md
check "说明书拷贝" "t-179" "@ateam/core"
restore

echo "恢复完毕（用的是文件副本，git 没被碰过）"
