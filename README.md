# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/samoyz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/samoyz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node 22 file: git smart HTTP (protocol v2 + v0, upload-pack / receive-pack), REST v3, GraphQL v4 and an MCP endpoint, all over one deterministic in-memory store. No model calls, no dependencies, no secrets — the trial's bearer token names its viewer from the scenario seed, and every timestamp and id comes from counters, never the wall clock.

Local grade (kit `grade-local`, `--driver process`): **120/120 conformance checks** — feature 600/600, agent 200/200, perf 93/200, total **893**.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there. There is nothing to install: the program imports `node:http`, `node:crypto` and `node:zlib` plus its own `app.ts` only. The harness sets `MAKEFUN_ENV_URL` (the env to register with) and `MAKEFUN_SHOP_TOKEN` (the bearer token); without `MAKEFUN_ENV_URL` the entry exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, including introspection, cursor pagination and batched operations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover` (2026-07-28) and the legacy `initialize` handshake, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0, shallow fetch and deepen), `git-receive-pack` (fast-forward only, sideband report) |
| anything else | 404 `{"message":"Not Found"}` |

## Layout

- `main.ts`: the entry lifecycle (bind an ephemeral port, register with the env, poll for done, exit 0). Kept as shipped.
- `app.ts`: the server — the whole forge.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wfayqtx9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
