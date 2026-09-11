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

## Test

```sh
pnpm check                 # typecheck + prettier + unit/integration tests (needs pnpm infra:up)
```

Design: `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`.
