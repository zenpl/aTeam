#!/usr/bin/env sh
# t-153/t-163/t-173：把在途六组那几条规则逐条删掉，看 inflight-move.test.ts 哪几条会红。
#
# t-177：注入与还原的机制搬到 bin/inject 了，这里只剩「注入哪几处」。原来这份脚本自己做备份与还原，
# 两个坑都是那样来的：cp 备份把损坏的树备份了进去；写死 cd 让它在 worktree 里去改另一棵树。
# 那两条现在由 bin/inject 一处管着，别再各写一份。
set -e
root="$(cd "$(dirname "$0")/../../.." && pwd)"
T=packages/core/test/inflight-move.test.ts

run() { printf '\n=== 注入：%s ===\n' "$1"; shift; "$root/bin/inject" packages/core/src/board.ts "$@" -- "$T" 2>&1 | grep -E "^ *(×|Tests|注入之后)" | sed 's/^ */  /' || true; }

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
printf '\n=== 还原后 ===\n'
(cd "$root" && pnpm --filter @ateam/core build >/dev/null 2>&1 && npx vitest run "$T" 2>&1 | grep -E "^ *Tests" | sed 's/^ */  /')
