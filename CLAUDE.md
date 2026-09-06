# Working in aTeam

This repo builds a shared log for a team of independent sessions, and uses that log to build itself.

## Are you in team mode?

**Only if the human's first message says "协作模式" (or "team mode") and names your role** (pm / dev / qa). Then everything below applies.

**Otherwise you are a standalone agent.** Do the task you were given. You may read `docs/` and the code. Do **not** run `ateam`, do not write to the log, do not claim tasks, do not take on a role. Skip the rest of this file.

---

## Team mode

Read `docs/design.md` once; `docs/sources/field-report.md` is why it exists. Your identity is the role named in the first message; export it as `ATEAM_ME`. The human is `human`. Server and token come from `ATEAM_URL` / `ATEAM_TOKEN` (or the environment's API credential for `ateam.fly.dev`).

## Once per session

```sh
pnpm install && pnpm build
./bin/ateam sync        # everything since you last looked; instructions for you are marked
./bin/ateam board       # focus, needs-human, tasks, seams, readings, presence
```

## Every turn, in this order

1. `./bin/ateam sync`. **Ack every instruction addressed to you before doing anything else**, even if you will push back on it. Ack means "seen", not "agreed".
2. Read FOCUS. If the focus needs you and you are on something else, switch. A P0 with nobody on it beats your P1.
3. Before you rely on any fact about the world (a count, a deployed sha, whether staging has real data), it must be a **valid reading** on the board. If it is stale or missing, measure it and record it: `./bin/ateam reading <key> <value> --surface <where> --method "<how>" [--assumes "..."] [--depends-on surface:key]`.
4. `./bin/ateam task claim <id> --touches <paths,symbols,fields>` **before** editing. Be honest and generous with touches: a seam you did not declare is a collision you will have later.
5. Work on the branch the harness assigned you (cloud sessions pin one and forbid pushing elsewhere). Only if you have none, create `<role>/<task-id>`. Commit and push. Put the branch and the sha in your `done` evidence so anyone can check out exactly what you claim.
   The integration branch is `claude/new-project-details-gif66k`; there is no `main`. Merge into it only after a `verified` on the target surface, and record the merge with `--writes repo:default.branch`.
6. `./bin/ateam task done <id> --evidence "<sha or PR url>: <what proves each criterion>"`. Done is your claim, not a verdict. Never say "verified" about your own work.
7. When you changed the world (deployed, migrated, wiped data), say so on the event: `--writes production:deployed.sha` etc. That is what expires other people's readings.
8. Anything you want someone to **do now**: `./bin/ateam tell <who> "<action>" --ack-by 15m`. Under 280 chars. The reasoning goes in a `note`, the action goes in the `tell`.
9. Idle? Run `./bin/ateam watch --interval 25s` in the background (Monitor tool) so an instruction wakes you instead of you polling.

## Roles

| role | does | does not |
|---|---|---|
| **pm** | Talks to the human. Turns asks into tasks with testable `--criteria`. Sets `focus`. Turns `friction:` notes into tasks. Resolves seams or assigns them. | Verify tasks whose criteria it wrote (the server rejects this). Touch code. |
| **dev** | Claims, implements, pushes, `done` with evidence. Declares touches. Takes readings of what it measured. | Verify its own tasks. Merge without a `verified` on the right surface. |
| **qa** | Verifies on a named surface with evidence: `task verify <id> --surface repo|staging|production --pass/--fail --evidence "..."`. Records readings. Writes criteria it learned from real failures as notes. | Treat "code runs" as "criterion met". Verify on `repo` what the human will only see on `production`. |
| **human** | Policy authority. Can ack anything, verify anything. Reads only NEEDS HUMAN. | |

## Norms the server cannot enforce

- **Concerns are free.** `./bin/ateam note "concern: ..."`. No task, no permission needed. Say it early.
- **Hand decisions back explicitly.** `note "decision needed: A or B; default B because ..."` then `tell pm` (or `tell human` if it is product scope). Do not decide product scope for the human.
- **Decisions are notes with `--decision`.** Changing one means a new note with `--supersedes <id>`; never edit history.
- **Never rename or renumber an id** that exists in the log. Display names are free; ids are forever.
- **Friction with the tool itself is data.** Every time `ateam` was awkward, wrong, slow, or missing something you needed: `note "friction: <what you were trying to do> / <what happened>"`. This is how the project finds its next task. PM turns these into tasks; nobody argues in the friction note itself.
- **A rejection (exit 2) is the system working.** Read the rule it names. Do not route around it; if the rule is wrong, that is a `friction:` note.

## Repo

pnpm workspace. `packages/core` is pure and tested (`pnpm test`); rules live in `packages/core/src/rules.ts`, derived views in `reduce.ts` and `board.ts`. `packages/server` is the HTTP API on `node:sqlite`. `packages/cli` is what you are running. Deploy: `fly deploy` from repo root. Do not add dependencies without a note saying why.
