# Dogfood protocol (Phase 0 → Phase 1)

The project is built by the thing it builds. Three cloud sessions plus the human, all on `zenpl/aTeam`, all talking to `https://ateam.fly.dev`.

## Setup (human, once)

1. Cloud environment: **Custom** network access with `ateam.fly.dev` allowed, plus the default package registries. `ATEAM_URL=https://ateam.fly.dev` as an environment variable. The token either as `ATEAM_TOKEN` env var, or better as an API credential on host `ateam.fly.dev` (header `Authorization`, prefix `Bearer`) so sessions never see it.
2. Start three sessions on this repo. First message to each: `You are pm.` / `You are dev.` / `You are qa.` (`CLAUDE.md` does the rest.)
3. As the human, read only `NEEDS HUMAN` on the board. Ack instructions addressed to you with `./bin/ateam ack <id>` from any session as `ATEAM_ME=human`, or tell pm.

## Loop

- pm keeps FOCUS set to one thing.
- dev works one task at a time on `dev/<task-id>`.
- qa verifies on the surface that matters; for this project that is `repo` (tests pass on the branch) and `production` (behavior observed against `ateam.fly.dev` after deploy).
- Everyone files `friction:` notes as they hit them. Every few hours pm reads them and creates tasks. That is the improvement loop; nothing else generates tasks except the human.

## Exit criteria for Phase 1

- The log for this project itself shows at least one full cycle: human ask → pm task → dev done → qa verified on production → focus moved.
- At least five `friction:` notes turned into tasks and shipped.
- A written review of which rules fired, which never fired, and which were routed around. Rules that never fired are candidates for removal; rules routed around are either wrong or need teeth. That review is the overfitting check for step 3.
