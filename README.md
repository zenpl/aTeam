# aTeam

A shared log for a team of independent sessions (AI or human) working on one project. It keeps them agreeing on **what is true right now** and **what must happen right now**, which git cannot do.

Design: [docs/design.md](docs/design.md). Why: [docs/sources/field-report.md](docs/sources/field-report.md).

## Layout

- `packages/core` — event types, the rules, the reducer, the board. Pure. Tests replay a real day.
- `packages/server` — HTTP API on `node:sqlite`. One project, one token, identity via `X-Actor`. Long-poll for instructions.
- `packages/cli` — `ateam`, what a session runs every turn.

## Run

```sh
pnpm install && pnpm build && pnpm test
ATEAM_TOKEN=secret pnpm --filter @ateam/server start          # :8080, db at ./data/ateam.db
```

Deploy to fly.io (from repo root):

```sh
fly launch --no-deploy --copy-config --name <app>
fly volumes create ateam_data --size 1
fly secrets set ATEAM_TOKEN=$(openssl rand -hex 24)
fly deploy
```

## A session's turn

```sh
export ATEAM_URL=https://<app>.fly.dev ATEAM_TOKEN=... ATEAM_ME=backend
node packages/cli/bin/ateam.js sync --wait 25s   # what happened; instructions for me are marked
ateam ack <id>                                   # for each instruction addressed to me
ateam board                                      # focus, needs-human, tasks, seams, readings, presence
```

Say things:

```sh
ateam focus "P0: staging login broken"
ateam tell backend "claim t-cookie and ship to staging" --ack-by 10m
ateam reading users.count 128 --surface production --method "select count(*)" \
      --assumes "prod and roster have zero overlap" --depends-on production:users
ateam note "imported roster batch 3" --writes production:users      # invalidates the reading above
ateam task create t-cookie "Session cookie flags" --criteria "cookie is SameSite=Lax"
ateam task claim t-cookie --touches auth.session_cookie,api/session.ts
ateam task done t-cookie --evidence "PR #12"
ateam task verify t-cookie --surface staging --pass                 # rejected if you are the owner, wrote the criteria, or a seam is open
```

Rejections are exit code 2 with the rule that fired. `ateam help` lists everything.

## API

| | |
|---|---|
| `GET /events?after=<id>&wait=<ms>` | pull since cursor (records delivery, advances cursor); long-polls up to 30 s |
| `POST /events` | append one event; 409 with `{rule, message}` when a rule rejects it |
| `GET /` | the board as read-only HTML for the human; refreshes every 30 s. Browsers cannot send the header, so open `/?token=<ATEAM_TOKEN>` once and it is kept in a cookie |
| `GET /board` | the derived board |
| `GET /log?after=<id>` | raw events, no side effects |

Headers: `Authorization: Bearer <ATEAM_TOKEN>`, `X-Actor: <name>`.
