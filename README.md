# ZoomClone backend

Backend for a multi-party video meeting system (see `video-meeting-backend-spec.pdf`). MVP slice:
Meeting API (control plane), signaling + room controller, mediasoup SFU.

## Run locally

```sh
corepack enable            # provides pnpm 9.15.9
pnpm install
pnpm infra:up              # Postgres on :55432, Redis on :56379 (docker compose)
cp .env.example .env
pnpm db:migrate
pnpm dev                   # every service, watch mode
```

To keep a stable signing key across restarts, run `pnpm --filter @zoomclone/tokens gen-key` and put
the PEM in `SIGNING_KEY_PEM` (multi-line values need quoting in `.env`).

## Test

```sh
pnpm check                 # typecheck + prettier + unit/integration tests (needs pnpm infra:up)
```

Design: `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`.

## Meeting API (port 8080)

| Method | Path                     | Auth                                   |
| ------ | ------------------------ | -------------------------------------- |
| POST   | `/v1/meetings`           | bearer                                 |
| GET    | `/v1/meetings/{id}`      | bearer (same org)                      |
| PATCH  | `/v1/meetings/{id}`      | organizer                              |
| DELETE | `/v1/meetings/{id}`      | organizer                              |
| POST   | `/v1/meetings/{id}:end`  | organizer                              |
| POST   | `/v1/join`               | optional bearer (guests allowed)       |
| GET    | `/v1/me`                 | bearer                                 |
| GET    | `/.well-known/jwks.json` | none                                   |
| POST   | `/dev/oidc/token`        | none, only with `AUTH_DEV_ISSUER=true` |

Errors: `{ "error": { "code": "...", "message": "..." } }` with spec 5.1 codes
(`MEETING_NOT_FOUND`, `LOCKED`, `ENDED`, `CAPACITY`, `NO_CAPACITY`, `RATE_LIMITED`, ...).

Smoke test with the dev issuer:

```sh
TOKEN=$(curl -s -X POST localhost:8080/dev/oidc/token -H 'content-type: application/json' -d '{"name":"Host"}' \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).access_token))')
CODE=$(curl -s -X POST localhost:8080/v1/meetings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Smoke"}' \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).code))')
curl -s -X POST localhost:8080/v1/join -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"display_name\":\"Guest\"}"
```
