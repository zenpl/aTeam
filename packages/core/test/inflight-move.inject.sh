#!/bin/sh
# t-173 判据 2/3：把 core 里被守的规则逐条删掉，看 inflight-move.test.ts 哪几条会红。
# 可重跑。还原用 git checkout，不用快照——第一版用 cp 备份，一次失败的注入把损坏的树备份了进去，
# 后面每一轮都从损坏的树开始，最后把 board.ts 留在损坏状态。备份的是「此刻的样子」，git 记的是「本该的样子」。
cd /home/user/aTeam
F=packages/core/src/board.ts
git diff --quiet -- $F || { echo "board.ts 有未提交的改动，先提交或 stash，否则还原会连它一起丢"; exit 1; }
run() {
  printf '\n=== 注入：%s ===\n' "$1"
  python3 - "$2" "$3" <<'PY' || { echo "  注入点没找到，跳过"; exit 1; }
import sys
p = "packages/core/src/board.ts"
s = open(p, encoding="utf-8").read()
old, new = sys.argv[1], sys.argv[2]
assert old in s, old
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
  pnpm --filter @ateam/core build >/dev/null 2>&1
  npx vitest run packages/core/test/inflight-move.test.ts 2>&1 | grep -E "^ *(×|Tests)" | sed 's/^ */  /'
  git checkout -- $F
}
run "去掉『已在生产跑着的不进任何一组』" \
    '.filter((tk) => !waiting.has(tk.id) && !running.has(tk.id))' \
    '.filter((tk) => !waiting.has(tk.id))'
run "去掉『有 shows 就说 shows』（t-163）" \
    'return { title: task?.shows ?? x.title,' \
    'return { title: x.title,'
run "去掉『卡住那组带上原因』" \
    'why: k === "blocked" && task?.blocked_on ? blockedWhy(task.blocked_on) : undefined' \
    'why: undefined'
run "去掉 blockedWhy 对 ULID/sha/路径的遮蔽" \
    'b[0-9A-HJKMNP-TV-Z]{26}' \
    'bTHIS_MATCHES_NOTHING_AT_ALL'
pnpm --filter @ateam/core build >/dev/null 2>&1
printf '\n=== 还原后 ===\n'
npx vitest run packages/core/test/inflight-move.test.ts 2>&1 | grep -E "^ *Tests" | sed 's/^ */  /'
