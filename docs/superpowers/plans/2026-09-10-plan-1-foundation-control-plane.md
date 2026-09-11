# Plan 1: Foundation + Control Plane (Meeting API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm monorepo, shared packages (protocol schemas, db, events, tokens), and a fully tested Meeting API (spec section 5.1) so a client can create a meeting, resolve a code into a join grant with a signed signaling JWT, and end a meeting.

**Architecture:** pnpm workspace with ESM TypeScript run directly by `tsx` (no build step). `packages/protocol` holds every wire contract as zod schemas. `packages/db` is plain SQL through postgres.js with a tiny migration runner and the shared idempotent `endSession`. `packages/tokens` signs and verifies ES256 signaling JWTs (jose). `services/meeting-api` is Fastify 5 with the zod type provider; it verifies OIDC users (dev issuer in local/test), mints join grants, and reads live room state from Redis. Postgres and Redis run in docker-compose.

**Tech Stack:** Node 24, pnpm 9.15.9, TypeScript 5.9.3, vitest 4.1.11, zod 4.6.2, Fastify 5.12.3 + fastify-type-provider-zod 7.0.0, postgres 3.4.9, ioredis 5.11.1, jose 6.2.12, prom-client 15.1.3, prettier 3.9.6, tsx 4.23.13, Docker Compose (postgres:16-alpine, redis:7-alpine).

**Spec:** `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md` (this plan covers its Phases 0, 1, 2; Plans 2, 3, 4 cover the SFU, signaling, and client/e2e). The original product spec is `video-meeting-backend-spec.pdf` at the repo root.

## Global Constraints

- Node `>=24`, pnpm `9.15.9` (pinned via `packageManager`). Every package is ESM (`"type": "module"`).
- TypeScript strict, `module: ESNext`, `moduleResolution: bundler`, `noUncheckedIndexedAccess: true`, `noEmit`. Relative imports have no extension (`./foo`). Workspace packages are imported by name (`@zoomclone/protocol`) and export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). No build step; services run with `tsx`.
- Pinned versions (use exactly these in package.json): typescript 5.9.3, tsx 4.23.13, vitest 4.1.11, prettier 3.9.6, zod 4.6.2, fastify 5.12.3, fastify-type-provider-zod 7.0.0, postgres 3.4.9, ioredis 5.11.1, jose 6.2.12, prom-client 15.1.3, pino-pretty 13.1.3, @types/node 24.13.4.
- Host ports: Postgres `55432`, Redis `56379` (5432 is already used by another project on this machine). meeting-api `8080`. Test database `zoomclone_test`, test Redis db index `1`.
- Tests use the real Postgres and Redis from docker-compose. No mocking of infra. Test files are `*.test.ts` next to the code they test; per-package `vitest run --passWithNoTests`.
- Spec names are used verbatim: REST paths and error codes from spec 5.1, Redis keys `{room:<session_id>}:meta` etc. from spec 4.2, table and column names from spec 4.1.
- Prose in code comments, docs, and commit messages: no em dashes (use commas, colons, periods).
- Before every commit: `pnpm check` (typecheck + prettier + tests) must pass. Run `pnpm format` first if prettier complains.
- Commit message format: Conventional Commits, imperative, subject <= 72 chars, and always end with these two trailer lines:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
  ```
- Work happens on branch `feat/mvp-vertical-slice` (already checked out; `main` has no commits).
- Infra must be up for tests: `pnpm infra:up` (defined in Task 0). Migrations for the test database are applied by the tests themselves (`ensureTestDatabase` + `migrate`).

## File structure (what this plan creates)

```
package.json  pnpm-workspace.yaml  .npmrc  tsconfig.base.json  .prettierrc  .prettierignore  .editorconfig
.env.example  docker-compose.yml  docker/postgres/init.sql  README.md
packages/protocol/            zod contracts (meeting code, errors, roles, claims, REST DTOs, WS messages)
  src/index.ts src/meeting-code.ts src/errors.ts src/roles.ts src/claims.ts src/rest.ts
  src/ws/common.ts src/ws/client.ts src/ws/server.ts src/ws/close-codes.ts src/ws/index.ts
packages/db/                  postgres.js client, migration runner, endSession, test helpers
  migrations/0001_init.sql src/client.ts src/migrate.ts src/migrate-cli.ts src/rows.ts src/end-session.ts src/testing.ts src/index.ts
packages/events/              EventBus, envelope, InMemoryEventBus
  src/index.ts src/bus.ts
packages/tokens/              ES256 keys, signaling JWT sign/verify
  src/index.ts src/keys.ts src/signaling-token.ts src/gen-key.ts
services/meeting-api/
  src/env.ts src/app.ts src/deps.ts src/main.ts src/metrics.ts src/error-handler.ts
  src/auth/user-id.ts src/auth/user-verifier.ts src/auth/hooks.ts src/auth/dev-issuer.ts src/auth/routes.ts
  src/scheduler.ts src/rate-limit.ts src/ice-servers.ts src/room-state.ts src/room-control.ts
  src/meetings/repo.ts src/meetings/service.ts src/meetings/routes.ts src/meetings/mapper.ts
  src/join/service.ts src/join/routes.ts
  test/helpers.ts
```

---

### Task 0: Workspace scaffold and local infra

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.env.example`, `docker-compose.yml`, `docker/postgres/init.sql`, `README.md`
- Modify: `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md` (Drizzle is replaced by plain SQL, see Step 8)

**Interfaces:**
- Produces: root scripts `infra:up`, `infra:down`, `typecheck`, `test`, `format`, `format:check`, `check`, `db:migrate`, `dev`; env var names in `.env.example`; database URLs `postgres://zoomclone:zoomclone@localhost:55432/zoomclone` and `.../zoomclone_test`; Redis `redis://localhost:56379/0` (dev) and `/1` (tests).

- [ ] **Step 1: Root package.json and workspace files**

`package.json`:

```json
{
  "name": "zoomclone",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.9",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "infra:up": "docker compose up -d --wait",
    "infra:down": "docker compose down",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r --workspace-concurrency=1 test",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "check": "pnpm typecheck && pnpm format:check && pnpm test",
    "db:migrate": "pnpm --filter @zoomclone/db migrate",
    "dev": "pnpm -r --parallel dev"
  },
  "devDependencies": {
    "prettier": "3.9.6",
    "typescript": "5.9.3"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "mediasoup", "@bufbuild/buf", "protobufjs"]
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "services/*"
  - "e2e"
```

`.npmrc`:

```
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 2: TypeScript base config**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 3: Formatting and editor config**

`.prettierrc`:

```json
{
  "printWidth": 100,
  "trailingComma": "all"
}
```

`.prettierignore`:

```
node_modules
pnpm-lock.yaml
docs/
*.pdf
packages/sfu-proto/src/gen/
services/signaling/public/
e2e/test-results/
e2e/playwright-report/
```

`.editorconfig`:

```
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
```

- [ ] **Step 4: docker-compose for Postgres and Redis**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: zoomclone
      POSTGRES_PASSWORD: zoomclone
      POSTGRES_DB: zoomclone
    ports:
      - "${POSTGRES_PORT:-55432}:5432"
    volumes:
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zoomclone -d zoomclone"]
      interval: 2s
      timeout: 2s
      retries: 30
  redis:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT:-56379}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 30

volumes:
  postgres-data:
```

`docker/postgres/init.sql` (runs once on first container start; creates the test database):

```sql
CREATE DATABASE zoomclone_test;
```

- [ ] **Step 5: .env.example**

```
# Infra host ports (5432 is taken by another project on this machine)
POSTGRES_PORT=55432
REDIS_PORT=56379
DATABASE_URL=postgres://zoomclone:zoomclone@localhost:55432/zoomclone
REDIS_URL=redis://localhost:56379/0

# meeting-api
NODE_ENV=development
MEETING_API_PORT=8080
LOG_LEVEL=info
TOKEN_ISSUER=meeting-api
# SIGNING_KEY_PEM= PKCS8 ES256 private key; generated per process when unset outside production
SIGNING_KID=dev-1
AUTH_DEV_ISSUER=true
DEV_ISSUER_URL=http://localhost:8080/dev/oidc
OIDC_AUDIENCE=zoomclone
# OIDC_ISSUER= and OIDC_JWKS_URL= are required when AUTH_DEV_ISSUER=false
DEFAULT_ORG_ID=11111111-1111-4111-8111-111111111111
DEFAULT_REGION=local
SFU_ID=sfu-local-1
SIGNALING_PUBLIC_URL=ws://localhost:8081
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=
TURN_SECRET=
TURN_TTL_SECONDS=3600
JOIN_RATE_LIMIT=10
JOIN_RATE_WINDOW_MS=60000
```

- [ ] **Step 6: README stub**

`README.md` (fenced blocks below use four backticks so the inner three-backtick fences survive; write them as normal three-backtick fences in the file):

````markdown
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
````

- [ ] **Step 7: Install and start infra**

Run:

```sh
corepack enable
pnpm install
pnpm infra:up
docker compose exec postgres psql -U zoomclone -d zoomclone -c "\l" | grep zoomclone_test
docker compose exec redis redis-cli ping
pnpm format:check
```

Expected: `pnpm install` writes `pnpm-lock.yaml` with no errors; both containers report healthy; the `\l` line lists `zoomclone_test`; redis prints `PONG`; prettier reports no issues. If `docker compose` reports port 55432 or 56379 in use, set `POSTGRES_PORT`/`REDIS_PORT` in a root `.env` and update `DATABASE_URL`/`REDIS_URL` there to match.

- [ ] **Step 8: Update the design doc: plain SQL instead of Drizzle**

The design doc mentions Drizzle. Fifteen queries do not justify a second schema definition, so the db package uses hand-written SQL migrations plus postgres.js. Apply:

```sh
sed -i 's/Postgres (Drizzle, mirrors spec 4.1, only tables the slice writes)/Postgres (hand-written SQL migrations applied by a small runner, queried through postgres.js; only tables the slice writes)/' docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md
sed -i 's/db\/          Drizzle schema (spec 4.1 tables in use), SQL migrations, pg client factory,/db\/          SQL migrations (spec 4.1 tables in use), postgres.js client factory,/' docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md
sed -i 's/- `meetings\/`: repository (Drizzle) + service/- `meetings\/`: repository (postgres.js SQL) + service/' docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md
grep -n -i drizzle docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md
```

Expected: the final grep prints nothing.

- [ ] **Step 9: Commit**

```sh
git add -A
git commit -F - <<'EOF'
chore: scaffold pnpm workspace and local infra

Postgres and Redis on non-default host ports because 5432 is taken on
this machine. No build step: services run through tsx.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 1: `packages/protocol`: meeting code

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`, `packages/protocol/src/meeting-code.ts`
- Test: `packages/protocol/src/meeting-code.test.ts`

**Interfaces:**
- Produces: `generateMeetingCode(rng?: CodeRng): string`, `normalizeMeetingCode(input: string): string | null`, `MEETING_CODE_RE: RegExp`, `type CodeRng = () => number` (returns 0..35).

- [ ] **Step 1: Package files**

`packages/protocol/package.json`:

```json
{
  "name": "@zoomclone/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "zod": "4.6.2"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`packages/protocol/src/index.ts` (grows in later tasks):

```ts
export * from "./meeting-code";
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing test**

`packages/protocol/src/meeting-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MEETING_CODE_RE, generateMeetingCode, normalizeMeetingCode } from "./meeting-code";

describe("generateMeetingCode", () => {
  it("matches the spec format xxx-xxxx-xxx", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateMeetingCode()).toMatch(MEETING_CODE_RE);
    }
  });

  it("uses the injected rng (index into a-z0-9)", () => {
    let n = 0;
    const code = generateMeetingCode(() => n++ % 36);
    expect(code).toBe("abc-defg-hij");
  });

  it("produces distinct codes", () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateMeetingCode()));
    expect(codes.size).toBe(1000);
  });
});

describe("normalizeMeetingCode", () => {
  it("canonicalizes case, spaces and dashes", () => {
    expect(normalizeMeetingCode("ABC-DEFG-HIJ")).toBe("abc-defg-hij");
    expect(normalizeMeetingCode("abcdefghij")).toBe("abc-defg-hij");
    expect(normalizeMeetingCode(" abc defg hij ")).toBe("abc-defg-hij");
    expect(normalizeMeetingCode("a1b-2c3d-4e5")).toBe("a1b-2c3d-4e5");
  });

  it("rejects wrong length or characters", () => {
    expect(normalizeMeetingCode("abc-defg-hi")).toBeNull();
    expect(normalizeMeetingCode("abc-defg-hij1")).toBeNull();
    expect(normalizeMeetingCode("abc-defg-hi!")).toBeNull();
    expect(normalizeMeetingCode("")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/protocol test`
Expected: FAIL, "Failed to resolve import ./meeting-code".

- [ ] **Step 4: Implement**

`packages/protocol/src/meeting-code.ts`:

```ts
import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Spec 8: 10 alphanumeric chars (about 51.7 bits), displayed as xxx-xxxx-xxx. */
export const MEETING_CODE_RE = /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/;

/** Returns an index into the 36-char alphabet. Injectable for deterministic tests. */
export type CodeRng = () => number;

const defaultRng: CodeRng = () => randomInt(0, ALPHABET.length);

export function generateMeetingCode(rng: CodeRng = defaultRng): string {
  let raw = "";
  for (let i = 0; i < 10; i++) {
    raw += ALPHABET[rng() % ALPHABET.length];
  }
  return group(raw);
}

/** Accepts user input (any case, spaces, missing or misplaced dashes); canonical code or null. */
export function normalizeMeetingCode(input: string): string | null {
  const raw = input.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z0-9]{10}$/.test(raw)) return null;
  return group(raw);
}

function group(raw: string): string {
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 10)}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/protocol test`
Expected: PASS (5 tests).

- [ ] **Step 6: Full check and commit**

Run: `pnpm check`
Expected: typecheck, prettier, tests all pass.

```sh
git add packages/protocol pnpm-lock.yaml
git commit -F - <<'EOF'
feat(protocol): add meeting code generator and normalizer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 2: `packages/protocol`: errors, roles, claims, REST DTOs

**Files:**
- Create: `packages/protocol/src/errors.ts`, `packages/protocol/src/roles.ts`, `packages/protocol/src/claims.ts`, `packages/protocol/src/rest.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/rest.test.ts`, `packages/protocol/src/errors.test.ts`

**Interfaces:**
- Produces: `ERROR_STATUS`, `ErrorCode`, `class ApiError(code, message?, retryAfterSeconds?)` with `.status`, `ErrorBodySchema`; `RoleSchema`, `Role`, `HOST_ROLES`; `SIGNALING_AUDIENCE = "signaling"`, `SIGNALING_TOKEN_TTL_SECONDS = 300`, `SignalingClaimsSchema`, `SignalingClaims`; `MeetingStatusSchema`, `MeetingStatus`, `MeetingSettingsSchema`, `MeetingSettings`, `DEFAULT_MEETING_SETTINGS`, `CreateMeetingRequestSchema`, `CreateMeetingRequest`, `UpdateMeetingRequestSchema`, `UpdateMeetingRequest`, `MeetingResponseSchema`, `MeetingResponse`, `EndMeetingResponseSchema`, `IdParamsSchema`, `MeResponseSchema`, `JoinRequestSchema`, `JoinRequest`, `IceServerSchema`, `IceServer`, `JoinResponseSchema`, `JoinResponse`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/src/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError, ERROR_STATUS, ErrorBodySchema } from "./errors";

describe("ApiError", () => {
  it("maps spec error codes to HTTP statuses", () => {
    expect(new ApiError("MEETING_NOT_FOUND").status).toBe(404);
    expect(new ApiError("LOCKED").status).toBe(403);
    expect(new ApiError("DOMAIN_RESTRICTED").status).toBe(403);
    expect(new ApiError("ENDED").status).toBe(410);
    expect(new ApiError("CAPACITY").status).toBe(429);
    expect(new ApiError("NO_CAPACITY").status).toBe(503);
    expect(new ApiError("RATE_LIMITED").status).toBe(429);
    expect(new ApiError("NOT_LIVE").status).toBe(409);
    expect(ERROR_STATUS.UNAUTHORIZED).toBe(401);
  });

  it("defaults the message to the code and keeps retry-after", () => {
    const err = new ApiError("RATE_LIMITED", undefined, 30);
    expect(err.message).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err).toBeInstanceOf(Error);
  });

  it("validates the error body shape", () => {
    expect(ErrorBodySchema.parse({ error: { code: "ENDED", message: "gone" } }).error.code).toBe(
      "ENDED",
    );
  });
});
```

`packages/protocol/src/rest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SignalingClaimsSchema } from "./claims";
import {
  CreateMeetingRequestSchema,
  DEFAULT_MEETING_SETTINGS,
  JoinRequestSchema,
  JoinResponseSchema,
  MeetingResponseSchema,
  MeetingSettingsSchema,
  UpdateMeetingRequestSchema,
} from "./rest";

describe("MeetingSettingsSchema", () => {
  it("fills defaults: lobby on, 500 participants", () => {
    expect(MeetingSettingsSchema.parse({})).toEqual({ lobby: true, max_participants: 500 });
    expect(DEFAULT_MEETING_SETTINGS).toEqual({ lobby: true, max_participants: 500 });
  });

  it("caps max_participants at 500 and floors at 2", () => {
    expect(MeetingSettingsSchema.safeParse({ max_participants: 501 }).success).toBe(false);
    expect(MeetingSettingsSchema.safeParse({ max_participants: 1 }).success).toBe(false);
  });
});

describe("CreateMeetingRequestSchema", () => {
  it("accepts an empty body and ISO datetimes with offsets", () => {
    expect(CreateMeetingRequestSchema.parse({})).toEqual({});
    const parsed = CreateMeetingRequestSchema.parse({
      title: "  Standup ",
      scheduled_start: "2026-09-10T09:00:00Z",
      scheduled_end: "2026-09-10T09:30:00+02:00",
      settings: { lobby: false },
    });
    expect(parsed.title).toBe("Standup");
    expect(parsed.settings).toEqual({ lobby: false });
  });

  it("rejects non-ISO datetimes and empty titles", () => {
    expect(CreateMeetingRequestSchema.safeParse({ scheduled_start: "tomorrow" }).success).toBe(
      false,
    );
    expect(CreateMeetingRequestSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("update allows explicit nulls", () => {
    expect(UpdateMeetingRequestSchema.parse({ title: null, scheduled_start: null })).toEqual({
      title: null,
      scheduled_start: null,
    });
  });
});

describe("JoinRequestSchema", () => {
  it("defaults client_caps", () => {
    const parsed = JoinRequestSchema.parse({ code: "abc-defg-hij", display_name: "Ana" });
    expect(parsed.client_caps).toEqual({ simulcast: true, av1: false });
  });

  it("requires a display name", () => {
    expect(JoinRequestSchema.safeParse({ code: "abc-defg-hij", display_name: " " }).success).toBe(
      false,
    );
  });
});

describe("response schemas", () => {
  it("MeetingResponseSchema accepts ISO strings with Z and nullable fields", () => {
    const ok = MeetingResponseSchema.safeParse({
      id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      code: "abc-defg-hij",
      org_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
      organizer_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b13",
      title: null,
      scheduled_start: null,
      scheduled_end: null,
      region: "local",
      settings: { lobby: true, max_participants: 500 },
      status: "scheduled",
      created_at: "2026-09-10T09:00:00.000Z",
      ended_at: null,
    });
    expect(ok.success).toBe(true);
  });

  it("JoinResponseSchema matches spec 5.1", () => {
    const ok = JoinResponseSchema.safeParse({
      session_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      participant_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
      role: "attendee",
      lobby: false,
      signaling_url: "wss://sig.example.com/rooms/2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      signaling_token: "x.y.z",
      ice_servers: [
        { urls: "stun:stun.example.com:3478" },
        { urls: ["turn:turn.example.com:443?transport=tcp"], username: "u", credential: "c" },
      ],
      region: "us-west-2",
    });
    expect(ok.success).toBe(true);
  });
});

describe("SignalingClaimsSchema", () => {
  it("requires the spec claims plus room settings", () => {
    const ok = SignalingClaimsSchema.safeParse({
      session_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
      participant_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
      role: "host",
      sfu_hint: "sfu-local-1",
      display_name: "Ana",
      lobby_enabled: true,
      max_participants: 500,
    });
    expect(ok.success).toBe(true);
    expect(SignalingClaimsSchema.safeParse({ role: "admin" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @zoomclone/protocol test`
Expected: FAIL, unresolved imports `./errors`, `./rest`, `./claims`.

- [ ] **Step 3: Implement**

`packages/protocol/src/errors.ts`:

```ts
import { z } from "zod";

/** REST error codes (spec 5.1) plus generic ones, mapped to HTTP status. */
export const ERROR_STATUS = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  LOCKED: 403,
  DOMAIN_RESTRICTED: 403,
  NOT_FOUND: 404,
  MEETING_NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_LIVE: 409,
  ENDED: 410,
  CAPACITY: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NO_CAPACITY: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = ERROR_STATUS[code];
  }
}

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
```

`packages/protocol/src/roles.ts`:

```ts
import { z } from "zod";

export const RoleSchema = z.enum(["host", "cohost", "attendee"]);
export type Role = z.infer<typeof RoleSchema>;

export const HOST_ROLES: ReadonlySet<Role> = new Set<Role>(["host", "cohost"]);
```

`packages/protocol/src/claims.ts`:

```ts
import { z } from "zod";
import { RoleSchema } from "./roles";

export const SIGNALING_AUDIENCE = "signaling";
/** Spec 2.2: per-meeting tokens with 5 min TTL. */
export const SIGNALING_TOKEN_TTL_SECONDS = 300;

/**
 * Custom claims in the signaling JWT (spec 5.1: session_id, participant_id, role, sfu_hint, exp).
 * lobby_enabled and max_participants let the room controller seed room meta without a DB read.
 */
export const SignalingClaimsSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  role: RoleSchema,
  sfu_hint: z.string().min(1),
  display_name: z.string().min(1).max(80),
  lobby_enabled: z.boolean(),
  max_participants: z.number().int().min(2).max(500),
});
export type SignalingClaims = z.infer<typeof SignalingClaimsSchema>;
```

`packages/protocol/src/rest.ts`:

```ts
import { z } from "zod";
import { RoleSchema } from "./roles";

const isoDate = z.iso.datetime({ offset: true });

export const MeetingStatusSchema = z.enum(["scheduled", "live", "ended", "cancelled"]);
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;

export const MeetingSettingsSchema = z.object({
  lobby: z.boolean().default(true),
  max_participants: z.number().int().min(2).max(500).default(500),
});
export type MeetingSettings = z.infer<typeof MeetingSettingsSchema>;
export const DEFAULT_MEETING_SETTINGS: MeetingSettings = MeetingSettingsSchema.parse({});

const title = z.string().trim().min(1).max(200);

export const CreateMeetingRequestSchema = z.object({
  title: title.optional(),
  scheduled_start: isoDate.optional(),
  scheduled_end: isoDate.optional(),
  settings: MeetingSettingsSchema.partial().optional(),
});
export type CreateMeetingRequest = z.infer<typeof CreateMeetingRequestSchema>;

export const UpdateMeetingRequestSchema = z.object({
  title: title.nullable().optional(),
  scheduled_start: isoDate.nullable().optional(),
  scheduled_end: isoDate.nullable().optional(),
  settings: MeetingSettingsSchema.partial().optional(),
});
export type UpdateMeetingRequest = z.infer<typeof UpdateMeetingRequestSchema>;

export const MeetingResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  org_id: z.uuid(),
  organizer_id: z.uuid(),
  title: z.string().nullable(),
  scheduled_start: isoDate.nullable(),
  scheduled_end: isoDate.nullable(),
  region: z.string(),
  settings: MeetingSettingsSchema,
  status: MeetingStatusSchema,
  created_at: isoDate,
  ended_at: isoDate.nullable(),
});
export type MeetingResponse = z.infer<typeof MeetingResponseSchema>;

export const EndMeetingResponseSchema = z.object({ session_id: z.uuid() });

export const IdParamsSchema = z.object({ id: z.uuid() });

export const MeResponseSchema = z.object({ id: z.uuid(), org_id: z.uuid(), name: z.string() });

export const JoinRequestSchema = z.object({
  code: z.string().min(1).max(32),
  display_name: z.string().trim().min(1).max(80),
  client_caps: z
    .object({
      simulcast: z.boolean().default(true),
      av1: z.boolean().default(false),
    })
    .prefault({}),
});
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServerSchema>;

export const JoinResponseSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  role: RoleSchema,
  lobby: z.boolean(),
  signaling_url: z.string(),
  signaling_token: z.string(),
  ice_servers: z.array(IceServerSchema),
  region: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;
```

`packages/protocol/src/index.ts`:

```ts
export * from "./meeting-code";
export * from "./errors";
export * from "./roles";
export * from "./claims";
export * from "./rest";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @zoomclone/protocol test`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add packages/protocol
git commit -F - <<'EOF'
feat(protocol): add error codes, roles, JWT claims and REST DTOs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 3: `packages/protocol`: WebSocket message schemas

**Files:**
- Create: `packages/protocol/src/ws/common.ts`, `packages/protocol/src/ws/close-codes.ts`, `packages/protocol/src/ws/client.ts`, `packages/protocol/src/ws/server.ts`, `packages/protocol/src/ws/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/ws/messages.test.ts`

**Interfaces:**
- Produces (used by Plan 3 signaling and Plan 4 client): `ClientMessageSchema`, `ClientMessage`, `ServerMessageSchema`, `ServerMessage`, `WelcomeSchema`, `Welcome`, `RosterEntrySchema`, `RosterEntry`, `TrackInfoSchema`, `TrackInfo`, `LobbyEntrySchema`, `LobbyEntry`, `RoomMetaSchema`, `RoomMeta`, `TransportParamsSchema`, `TransportParams`, `MediaParamsSchema`, `MediaParams`, `SubscriptionPrefSchema`, `SubscriptionPref`, `ConsumerParamsSchema`, `ConsumerParams`, `PublishAckSchema`, `SubscribeAckSchema`, `MediaKindSchema`, `MediaKind`, `MediaSourceSchema`, `MediaSource`, `WsErrorCodeSchema`, `WsErrorCode`, `CloseCode`, `MAX_CHAT_BYTES = 4096`, `REACTION_RATE_PER_SECOND = 2`, `PING_INTERVAL_MS = 10000`, `MISSED_PINGS_TO_CLOSE = 3`.
- Envelope rule: client requests `{ type, id, payload }`; server room events `{ type, seq, payload }`; `welcome`/`resync` `{ type, payload }` (snapshot seq lives in `payload.seq`); `ack`/`error` carry `id`; `pong` carries neither.

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/ws/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ClientMessageSchema, ServerMessageSchema, SubscribeAckSchema, WelcomeSchema } from "./index";

const pid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12";
const sid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11";

describe("ClientMessageSchema", () => {
  const cases: Array<[string, unknown]> = [
    ["hello", { token: "t", resume_seq: 10, epoch: 2 }],
    ["hello", { token: "t" }],
    ["connect_transport", { transport: "send", dtls_parameters: { role: "client" } }],
    ["publish", { kind: "video", source: "camera", rtp_parameters: { codecs: [] } }],
    ["unpublish", { track_id: "trk_1" }],
    ["subscribe", { track_ids: ["trk_1"], prefs: { trk_1: { max_layer: 1, priority: 10 } } }],
    ["consumer_ready", { track_id: "trk_1" }],
    ["set_media_state", { muted: true }],
    ["raise_hand", {}],
    ["lower_hand", {}],
    ["reaction", { emoji: "👍" }],
    ["chat", { body: "hi", to: pid }],
    ["host.admit", { participant_id: pid }],
    ["host.deny", { participant_id: pid }],
    ["host.mute", { participant_id: pid }],
    ["host.remove", { participant_id: pid }],
    ["host.lock", { locked: true }],
    ["host.end", {}],
    ["restart_ice", { transport: "recv" }],
    ["ping", { ts: 1 }],
  ];

  it.each(cases)("parses %s", (type, payload) => {
    const result = ClientMessageSchema.safeParse({ type, id: "r1", payload });
    expect(result.success, JSON.stringify(result.error)).toBe(true);
  });

  it("defaults publish.paused to false and subscribe.prefs to {}", () => {
    const pub = ClientMessageSchema.parse({
      type: "publish",
      id: "r1",
      payload: { kind: "audio", source: "mic", rtp_parameters: {} },
    });
    expect(pub.type === "publish" && pub.payload.paused).toBe(false);
    const sub = ClientMessageSchema.parse({
      type: "subscribe",
      id: "r2",
      payload: { track_ids: [] },
    });
    expect(sub.type === "subscribe" && sub.payload.prefs).toEqual({});
  });

  it("rejects unknown types, missing id and screen as a kind", () => {
    expect(ClientMessageSchema.safeParse({ type: "nope", id: "r", payload: {} }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "ping", payload: { ts: 1 } }).success).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        type: "publish",
        id: "r",
        payload: { kind: "screen", source: "screen", rtp_parameters: {} },
      }).success,
    ).toBe(false);
  });

  it("limits chat to 4 KB measured in UTF-8 bytes", () => {
    const threeByteChar = "€";
    const ok = ClientMessageSchema.safeParse({
      type: "chat",
      id: "r",
      payload: { body: threeByteChar.repeat(1365) },
    });
    const tooBig = ClientMessageSchema.safeParse({
      type: "chat",
      id: "r",
      payload: { body: threeByteChar.repeat(1366) },
    });
    expect(ok.success).toBe(true);
    expect(tooBig.success).toBe(false);
  });
});

describe("ServerMessageSchema", () => {
  const roster = {
    participant_id: pid,
    name: "Ana",
    role: "attendee",
    muted: false,
    video_off: false,
    hand: false,
    connected: true,
    joined_at: "2026-09-10T09:00:00.000Z",
  };

  it("parses a joined welcome with media", () => {
    const welcome = {
      participant_id: pid,
      role: "attendee",
      epoch: 1,
      seq: 5,
      state: "joined",
      roster: [roster],
      tracks: [
        { track_id: "trk", owner: pid, kind: "video", source: "camera", paused: false, layers: 3 },
      ],
      lobby: [],
      room_meta: {
        session_id: sid,
        locked: false,
        lobby_enabled: true,
        recording: false,
        host_ids: [],
        max_participants: 500,
      },
      media: {
        rtp_capabilities: { codecs: [] },
        send_transport: { id: "t1", ice_parameters: {}, ice_candidates: [], dtls_parameters: {} },
        recv_transport: { id: "t2", ice_parameters: {}, ice_candidates: [], dtls_parameters: {} },
      },
    };
    expect(WelcomeSchema.safeParse(welcome).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "welcome", payload: welcome }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "resync", payload: welcome }).success).toBe(true);
  });

  it("parses a lobby welcome with only ids", () => {
    const ok = ServerMessageSchema.safeParse({
      type: "welcome",
      payload: { participant_id: pid, role: "attendee", epoch: 1, seq: 0, state: "lobby" },
    });
    expect(ok.success).toBe(true);
  });

  it("requires seq on room events and id on ack/error", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "participant.joined",
        seq: 1,
        payload: { participant: roster },
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({ type: "participant.joined", payload: { participant: roster } })
        .success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({ type: "ack", id: "r1", payload: { track_id: "trk" } }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "error",
        id: "r1",
        payload: { code: "FORBIDDEN", message: "host only" },
      }).success,
    ).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "pong", payload: { ts: 1 } }).success).toBe(true);
  });

  it("parses the remaining room events", () => {
    const events: Array<[string, unknown]> = [
      ["participant.left", { participant_id: pid, reason: "timeout" }],
      ["participant.updated", { participant_id: pid, patch: { muted: true, connected: false } }],
      ["track.added", { track: { track_id: "t", owner: pid, kind: "audio", source: "mic", paused: false, layers: 1 } }],
      ["track.removed", { track_id: "t" }],
      ["track.updated", { track_id: "t", patch: { paused: true } }],
      ["active_speakers", { participant_ids: [pid] }],
      ["lobby.request", { participant_id: pid, name: "Ana" }],
      ["lobby.result", { admitted: false }],
      ["chat", { from: pid, body: "hi", sent_at: "2026-09-10T09:00:00.000Z" }],
      ["reaction", { from: pid, emoji: "👍" }],
      ["hand", { participant_id: pid, raised: true }],
      ["room.updated", { locked: true }],
      ["room.ended", { reason: "host_end" }],
    ];
    for (const [type, payload] of events) {
      const result = ServerMessageSchema.safeParse({ type, seq: 7, payload });
      expect(result.success, `${type}: ${JSON.stringify(result.error)}`).toBe(true);
    }
  });

  it("SubscribeAckSchema carries consumer params", () => {
    const ok = SubscribeAckSchema.safeParse({
      consumers: [
        { track_id: "t", consumer_id: "c", kind: "video", rtp_parameters: {}, producer_paused: false },
      ],
      removed: ["old"],
    });
    expect(ok.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/protocol test`
Expected: FAIL, unresolved import `./index` under `src/ws`.

- [ ] **Step 3: Implement**

`packages/protocol/src/ws/close-codes.ts`:

```ts
/** WebSocket close codes used by the signaling gateway (design doc, Contracts). */
export const CloseCode = {
  PING_TIMEOUT: 4000,
  AUTH_FAILED: 4001,
  REMOVED: 4002,
  LOBBY_DENIED: 4003,
  ROOM_ENDED: 4004,
  REPLACED: 4005,
  PROTOCOL_ERROR: 4006,
  CAPACITY: 4007,
  REJOIN_REQUIRED: 4008,
  LOCKED: 4009,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

export const PING_INTERVAL_MS = 10_000;
export const MISSED_PINGS_TO_CLOSE = 3;
```

`packages/protocol/src/ws/common.ts`:

```ts
import { z } from "zod";
import { RoleSchema } from "../roles";

const isoDate = z.iso.datetime({ offset: true });

export const ParticipantIdSchema = z.uuid();
export const TrackIdSchema = z.string().min(1).max(64);
/** mediasoup parameter blobs travel opaque; the SFU validates them. */
export const OpaqueSchema = z.record(z.string(), z.unknown());

export const MediaKindSchema = z.enum(["audio", "video"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;
export const MediaSourceSchema = z.enum(["mic", "camera", "screen", "screen_audio"]);
export type MediaSource = z.infer<typeof MediaSourceSchema>;

export const MAX_CHAT_BYTES = 4096;
export const REACTION_RATE_PER_SECOND = 2;

export const RosterEntrySchema = z.object({
  participant_id: ParticipantIdSchema,
  name: z.string(),
  role: RoleSchema,
  muted: z.boolean(),
  video_off: z.boolean(),
  hand: z.boolean(),
  connected: z.boolean(),
  joined_at: isoDate,
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const TrackInfoSchema = z.object({
  track_id: TrackIdSchema,
  owner: ParticipantIdSchema,
  kind: MediaKindSchema,
  source: MediaSourceSchema,
  paused: z.boolean(),
  layers: z.number().int().min(0),
});
export type TrackInfo = z.infer<typeof TrackInfoSchema>;

export const LobbyEntrySchema = z.object({
  participant_id: ParticipantIdSchema,
  name: z.string(),
  requested_at: isoDate,
});
export type LobbyEntry = z.infer<typeof LobbyEntrySchema>;

export const RoomMetaSchema = z.object({
  session_id: z.uuid(),
  locked: z.boolean(),
  lobby_enabled: z.boolean(),
  recording: z.boolean(),
  host_ids: z.array(ParticipantIdSchema),
  max_participants: z.number().int(),
});
export type RoomMeta = z.infer<typeof RoomMetaSchema>;

export const TransportParamsSchema = z.object({
  id: z.string(),
  ice_parameters: OpaqueSchema,
  ice_candidates: z.array(OpaqueSchema),
  dtls_parameters: OpaqueSchema,
});
export type TransportParams = z.infer<typeof TransportParamsSchema>;

export const MediaParamsSchema = z.object({
  rtp_capabilities: OpaqueSchema,
  send_transport: TransportParamsSchema,
  recv_transport: TransportParamsSchema,
});
export type MediaParams = z.infer<typeof MediaParamsSchema>;

export const SubscriptionPrefSchema = z.object({
  max_layer: z.number().int().min(0).max(2).optional(),
  priority: z.number().int().min(1).max(255).optional(),
  paused: z.boolean().optional(),
});
export type SubscriptionPref = z.infer<typeof SubscriptionPrefSchema>;

export const ConsumerParamsSchema = z.object({
  track_id: TrackIdSchema,
  consumer_id: z.string(),
  kind: MediaKindSchema,
  rtp_parameters: OpaqueSchema,
  producer_paused: z.boolean(),
});
export type ConsumerParams = z.infer<typeof ConsumerParamsSchema>;

export const PublishAckSchema = z.object({ track_id: TrackIdSchema });
export const SubscribeAckSchema = z.object({
  consumers: z.array(ConsumerParamsSchema),
  removed: z.array(TrackIdSchema),
});

export const WsErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID",
  "RATE_LIMITED",
  "CAPACITY",
  "LOCKED",
  "NOT_IMPLEMENTED",
  "CONTROLLER_BUSY",
  "SFU_ERROR",
  "INTERNAL",
]);
export type WsErrorCode = z.infer<typeof WsErrorCodeSchema>;
```

`packages/protocol/src/ws/client.ts`:

```ts
import { z } from "zod";
import {
  MAX_CHAT_BYTES,
  MediaKindSchema,
  MediaSourceSchema,
  OpaqueSchema,
  ParticipantIdSchema,
  SubscriptionPrefSchema,
  TrackIdSchema,
} from "./common";

const encoder = new TextEncoder();

function request<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), id: z.string().min(1).max(64), payload });
}

const transportSchema = z.enum(["send", "recv"]);
const targetSchema = z.object({ participant_id: ParticipantIdSchema });

/** Client to server messages (spec 5.2, mediasoup payloads). Every request carries an id. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  request(
    "hello",
    z.object({
      token: z.string().min(1),
      resume_seq: z.number().int().nonnegative().optional(),
      epoch: z.number().int().positive().optional(),
    }),
  ),
  request(
    "connect_transport",
    z.object({ transport: transportSchema, dtls_parameters: OpaqueSchema }),
  ),
  request(
    "publish",
    z.object({
      kind: MediaKindSchema,
      source: MediaSourceSchema,
      rtp_parameters: OpaqueSchema,
      paused: z.boolean().default(false),
    }),
  ),
  request("unpublish", z.object({ track_id: TrackIdSchema })),
  request(
    "subscribe",
    z.object({
      rtp_capabilities: OpaqueSchema.optional(),
      track_ids: z.array(TrackIdSchema).max(500),
      prefs: z.record(TrackIdSchema, SubscriptionPrefSchema).default({}),
    }),
  ),
  request("consumer_ready", z.object({ track_id: TrackIdSchema })),
  request(
    "set_media_state",
    z.object({ muted: z.boolean().optional(), video_off: z.boolean().optional() }),
  ),
  request("raise_hand", z.object({})),
  request("lower_hand", z.object({})),
  request("reaction", z.object({ emoji: z.string().min(1).max(16) })),
  request(
    "chat",
    z.object({
      body: z
        .string()
        .min(1)
        .refine((s) => encoder.encode(s).length <= MAX_CHAT_BYTES, "chat body over 4 KB"),
      to: ParticipantIdSchema.optional(),
    }),
  ),
  request("host.admit", targetSchema),
  request("host.deny", targetSchema),
  request("host.mute", targetSchema),
  request("host.remove", targetSchema),
  request("host.lock", z.object({ locked: z.boolean() })),
  request("host.end", z.object({})),
  request("restart_ice", z.object({ transport: transportSchema })),
  request("ping", z.object({ ts: z.number() })),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];
```

`packages/protocol/src/ws/server.ts`:

```ts
import { z } from "zod";
import { RoleSchema } from "../roles";
import {
  LobbyEntrySchema,
  MediaParamsSchema,
  ParticipantIdSchema,
  RoomMetaSchema,
  RosterEntrySchema,
  TrackIdSchema,
  TrackInfoSchema,
  WsErrorCodeSchema,
} from "./common";

const isoDate = z.iso.datetime({ offset: true });

/** Full snapshot. state "lobby" carries only the ids; hosts also receive the lobby list. */
export const WelcomeSchema = z.object({
  participant_id: ParticipantIdSchema,
  role: RoleSchema,
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  state: z.enum(["joined", "lobby"]),
  roster: z.array(RosterEntrySchema).optional(),
  tracks: z.array(TrackInfoSchema).optional(),
  lobby: z.array(LobbyEntrySchema).optional(),
  room_meta: RoomMetaSchema.optional(),
  media: MediaParamsSchema.optional(),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), seq: z.number().int().positive(), payload });
}

function snapshot<T extends string>(type: T) {
  return z.object({ type: z.literal(type), payload: WelcomeSchema });
}

export const ServerMessageSchema = z.discriminatedUnion("type", [
  snapshot("welcome"),
  snapshot("resync"),
  z.object({ type: z.literal("ack"), id: z.string(), payload: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal("error"),
    id: z.string().optional(),
    payload: z.object({ code: WsErrorCodeSchema, message: z.string() }),
  }),
  z.object({ type: z.literal("pong"), payload: z.object({ ts: z.number() }) }),
  event("participant.joined", z.object({ participant: RosterEntrySchema })),
  event("participant.left", z.object({ participant_id: ParticipantIdSchema, reason: z.string() })),
  event(
    "participant.updated",
    z.object({
      participant_id: ParticipantIdSchema,
      patch: RosterEntrySchema.pick({
        name: true,
        role: true,
        muted: true,
        video_off: true,
        hand: true,
        connected: true,
      }).partial(),
    }),
  ),
  event("track.added", z.object({ track: TrackInfoSchema })),
  event("track.removed", z.object({ track_id: TrackIdSchema })),
  event(
    "track.updated",
    z.object({
      track_id: TrackIdSchema,
      patch: z.object({
        paused: z.boolean().optional(),
        layers: z.number().int().min(0).optional(),
      }),
    }),
  ),
  event("active_speakers", z.object({ participant_ids: z.array(ParticipantIdSchema) })),
  event("lobby.request", z.object({ participant_id: ParticipantIdSchema, name: z.string() })),
  event("lobby.result", z.object({ admitted: z.boolean() })),
  event(
    "chat",
    z.object({
      from: ParticipantIdSchema,
      to: ParticipantIdSchema.optional(),
      body: z.string(),
      sent_at: isoDate,
    }),
  ),
  event("reaction", z.object({ from: ParticipantIdSchema, emoji: z.string() })),
  event("hand", z.object({ participant_id: ParticipantIdSchema, raised: z.boolean() })),
  event(
    "room.updated",
    z.object({ locked: z.boolean().optional(), recording: z.boolean().optional() }),
  ),
  event("room.ended", z.object({ reason: z.string() })),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
/** Room events: everything with a seq (replayable from the ring buffer). */
export type RoomEvent = Extract<ServerMessage, { seq: number }>;
```

`packages/protocol/src/ws/index.ts`:

```ts
export * from "./close-codes";
export * from "./common";
export * from "./client";
export * from "./server";
```

Append to `packages/protocol/src/index.ts`:

```ts
export * from "./ws/index";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/protocol test`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add packages/protocol
git commit -F - <<'EOF'
feat(protocol): add WebSocket signaling message schemas

mediasoup parameter blobs replace SDP; track ids are server minted;
kind is audio|video with a separate source (spec 5.2 deviations noted
in the design doc).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 4: `packages/db`: client, migration runner, initial schema, test helpers

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.ts`, `packages/db/migrations/0001_init.sql`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/migrate-cli.ts`, `packages/db/src/rows.ts`, `packages/db/src/testing.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/migrate.test.ts`

**Interfaces:**
- Produces: `createDb(url, { max? }): Db` (postgres.js `Sql` with camelCase result columns), `migrate(db): Promise<string[]>`, row types `MeetingRow`, `SessionRow`, `ParticipantRow`; from `@zoomclone/db/testing`: `testDatabaseUrl()`, `ensureTestDatabase(url?)`, `truncateAll(db)`.
- Result rows come back camelCased (`meeting_id` -> `meetingId`) because of `transform: postgres.camel`. Query parameters are written as SQL columns (snake_case) inside the tagged template; JSONB values must be wrapped with `db.json(value)`.

- [ ] **Step 1: Package files**

`packages/db/package.json`:

```json
{
  "name": "@zoomclone/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "migrate": "node --env-file-if-exists=../../.env --import tsx src/migrate-cli.ts"
  },
  "dependencies": {
    "@zoomclone/protocol": "workspace:*",
    "postgres": "3.4.9"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`packages/db/vitest.config.ts` (tests share one database, so files run one at a time):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

Run `pnpm install`.

- [ ] **Step 2: Initial migration (spec 4.1 plus the live-session index)**

`packages/db/migrations/0001_init.sql`:

```sql
-- Spec 4.1 tables used by the MVP slice. Additions to the spec: NOT NULL on foreign keys,
-- CHECK constraints on enums, and a partial unique index so a meeting has at most one live session.

CREATE TABLE meetings (
  id              UUID PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  org_id          UUID NOT NULL,
  organizer_id    UUID NOT NULL,
  title           TEXT,
  scheduled_start TIMESTAMPTZ,
  scheduled_end   TIMESTAMPTZ,
  region          TEXT NOT NULL,
  settings        JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);
CREATE INDEX meetings_org_scheduled_idx ON meetings (org_id, scheduled_start);

CREATE TABLE meeting_sessions (
  id                UUID PRIMARY KEY,
  meeting_id        UUID NOT NULL REFERENCES meetings(id),
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  home_sfu_id       TEXT,
  peak_participants INT
);
CREATE UNIQUE INDEX meeting_sessions_live_idx ON meeting_sessions (meeting_id) WHERE ended_at IS NULL;

CREATE TABLE participants (
  id           UUID PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES meeting_sessions(id),
  user_id      UUID,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('host', 'cohost', 'attendee')),
  joined_at    TIMESTAMPTZ NOT NULL,
  left_at      TIMESTAMPTZ,
  leave_reason TEXT
);
CREATE INDEX participants_session_idx ON participants (session_id);
```

- [ ] **Step 3: Write the failing test**

`packages/db/src/migrate.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { migrate } from "./migrate";
import { ensureTestDatabase, testDatabaseUrl } from "./testing";

let db: Db;

beforeAll(async () => {
  await ensureTestDatabase();
  db = createDb(testDatabaseUrl(), { max: 2 });
  await db`DROP TABLE IF EXISTS participants, meeting_sessions, meetings, schema_migrations CASCADE`;
});

afterAll(async () => {
  await db.end();
});

describe("migrate", () => {
  it("applies pending migrations once", async () => {
    expect(await migrate(db)).toEqual(["0001_init"]);
    expect(await migrate(db)).toEqual([]);
    const tables = await db<{ tableName: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.tableName)).toEqual([
      "meeting_sessions",
      "meetings",
      "participants",
      "schema_migrations",
    ]);
  });

  it("allows only one live session per meeting", async () => {
    const meetingId = "11111111-1111-4111-8111-111111111111";
    await db`
      INSERT INTO meetings (id, code, org_id, organizer_id, region, settings, status)
      VALUES (${meetingId}, 'abc-defg-hij', ${meetingId}, ${meetingId}, 'local',
              ${db.json({ lobby: true, max_participants: 500 })}, 'scheduled')`;
    await db`
      INSERT INTO meeting_sessions (id, meeting_id, started_at)
      VALUES ('22222222-2222-4222-8222-222222222222', ${meetingId}, now())`;
    await expect(
      db`
        INSERT INTO meeting_sessions (id, meeting_id, started_at)
        VALUES ('33333333-3333-4333-8333-333333333333', ${meetingId}, now())`,
    ).rejects.toMatchObject({ code: "23505" });

    await db`UPDATE meeting_sessions SET ended_at = now() WHERE meeting_id = ${meetingId}`;
    await db`
      INSERT INTO meeting_sessions (id, meeting_id, started_at)
      VALUES ('33333333-3333-4333-8333-333333333333', ${meetingId}, now())`;
    const live = await db`
      SELECT id FROM meeting_sessions WHERE meeting_id = ${meetingId} AND ended_at IS NULL`;
    expect(live.length).toBe(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/db test`
Expected: FAIL, unresolved imports `./client`, `./migrate`, `./testing`.

- [ ] **Step 5: Implement**

`packages/db/src/client.ts`:

```ts
import postgres from "postgres";

/** postgres.js connection. Result columns are camelCased (meeting_id -> meetingId). */
export type Db = postgres.Sql;

export function createDb(url: string, options: { max?: number } = {}): Db {
  return postgres(url, {
    transform: postgres.camel,
    max: options.max ?? 10,
    onnotice: () => {},
  });
}
```

`packages/db/src/migrate.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
/** Advisory lock so concurrent migrators (parallel test workers, several pods) serialize. */
const LOCK_ID = 727001;

/** Applies every migrations/*.sql not yet recorded in schema_migrations, in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    const applied = new Set(
      (await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    );
    const ran: string[] = [];
    for (const file of files) {
      const name = file.replace(/\.sql$/, "");
      if (applied.has(name)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      ran.push(name);
    }
    return ran;
  });
}
```

`packages/db/src/migrate-cli.ts`:

```ts
import { createDb } from "./client";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(url, { max: 1 });
try {
  const ran = await migrate(db);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "no pending migrations");
} finally {
  await db.end();
}
```

`packages/db/src/rows.ts`:

```ts
import type { MeetingSettings, MeetingStatus, Role } from "@zoomclone/protocol";

export type MeetingRow = {
  id: string;
  code: string;
  orgId: string;
  organizerId: string;
  title: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  region: string;
  settings: MeetingSettings;
  status: MeetingStatus;
  createdAt: Date;
  endedAt: Date | null;
};

export type SessionRow = {
  id: string;
  meetingId: string;
  startedAt: Date;
  endedAt: Date | null;
  homeSfuId: string | null;
  peakParticipants: number | null;
};

export type ParticipantRow = {
  id: string;
  sessionId: string;
  userId: string | null;
  displayName: string;
  role: Role;
  joinedAt: Date;
  leftAt: Date | null;
  leaveReason: string | null;
};
```

`packages/db/src/testing.ts`:

```ts
import postgres from "postgres";
import { createDb, type Db } from "./client";
import { migrate } from "./migrate";

export function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ?? "postgres://zoomclone:zoomclone@localhost:55432/zoomclone_test"
  );
}

/** Creates the database named in the URL when missing, then applies migrations. */
export async function ensureTestDatabase(url: string = testDatabaseUrl()): Promise<void> {
  const name = new URL(url).pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const adminDb = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await adminDb`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) await adminDb.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await adminDb.end();
  }
  const db = createDb(url, { max: 1 });
  try {
    await migrate(db);
  } finally {
    await db.end();
  }
}

export async function truncateAll(db: Db): Promise<void> {
  await db`TRUNCATE participants, meeting_sessions, meetings`;
}
```

`packages/db/src/index.ts`:

```ts
export { createDb, type Db } from "./client";
export { migrate } from "./migrate";
export type { MeetingRow, ParticipantRow, SessionRow } from "./rows";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/db test`
Expected: PASS (2 tests). Then run `pnpm db:migrate` from the repo root with `.env` copied from `.env.example`: prints `applied: 0001_init` the first time, `no pending migrations` afterwards.

- [ ] **Step 7: Full check and commit**

Run: `pnpm check`

```sh
git add packages/db pnpm-lock.yaml
git commit -F - <<'EOF'
feat(db): add postgres client, migration runner and initial schema

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 5: `packages/db`: shared idempotent `endSession`

**Files:**
- Create: `packages/db/src/end-session.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/end-session.test.ts`

**Interfaces:**
- Produces: `type EndReason = "host_end" | "api_end" | "idle"`, `isEndReason(v: unknown): v is EndReason`, `endSession(db, { sessionId, reason, peakParticipants? }): Promise<EndSessionResult>` with `EndSessionResult = { ended: boolean; meetingId: string | null; meetingStatus: "ended" | "scheduled" | null }`.
- Semantics (design doc, Data model): sets `meeting_sessions.ended_at` and `peak_participants`; `host_end`/`api_end` move the meeting to `ended` (terminal, with `meetings.ended_at`); `idle` moves it back to `scheduled`. A second call for the same session is a no-op (`ended: false`).

- [ ] **Step 1: Write the failing test**

`packages/db/src/end-session.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { endSession } from "./end-session";
import type { MeetingRow, SessionRow } from "./rows";
import { ensureTestDatabase, testDatabaseUrl, truncateAll } from "./testing";

let db: Db;

beforeAll(async () => {
  await ensureTestDatabase();
  db = createDb(testDatabaseUrl(), { max: 2 });
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
});

async function liveMeeting(peak: number | null = null) {
  const meetingId = randomUUID();
  const sessionId = randomUUID();
  await db`
    INSERT INTO meetings (id, code, org_id, organizer_id, region, settings, status)
    VALUES (${meetingId}, ${meetingId.slice(0, 3) + "-" + meetingId.slice(4, 8) + "-" + meetingId.slice(9, 12)},
            ${randomUUID()}, ${randomUUID()}, 'local', ${db.json({ lobby: true, max_participants: 500 })}, 'live')`;
  await db`
    INSERT INTO meeting_sessions (id, meeting_id, started_at, peak_participants)
    VALUES (${sessionId}, ${meetingId}, now(), ${peak})`;
  return { meetingId, sessionId };
}

async function meeting(id: string): Promise<MeetingRow> {
  const [row] = await db<MeetingRow[]>`SELECT * FROM meetings WHERE id = ${id}`;
  return row!;
}

async function session(id: string): Promise<SessionRow> {
  const [row] = await db<SessionRow[]>`SELECT * FROM meeting_sessions WHERE id = ${id}`;
  return row!;
}

describe("endSession", () => {
  it("host_end ends the session and makes the meeting terminal", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    const result = await endSession(db, { sessionId, reason: "host_end", peakParticipants: 7 });
    expect(result).toEqual({ ended: true, meetingId, meetingStatus: "ended" });
    const s = await session(sessionId);
    expect(s.endedAt).toBeInstanceOf(Date);
    expect(s.peakParticipants).toBe(7);
    const m = await meeting(meetingId);
    expect(m.status).toBe("ended");
    expect(m.endedAt).toBeInstanceOf(Date);
  });

  it("api_end is terminal too", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    await endSession(db, { sessionId, reason: "api_end" });
    expect((await meeting(meetingId)).status).toBe("ended");
  });

  it("idle ends the session but returns the meeting to scheduled", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    const result = await endSession(db, { sessionId, reason: "idle" });
    expect(result.meetingStatus).toBe("scheduled");
    const m = await meeting(meetingId);
    expect(m.status).toBe("scheduled");
    expect(m.endedAt).toBeNull();
    expect((await session(sessionId)).endedAt).toBeInstanceOf(Date);
  });

  it("is idempotent", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    await endSession(db, { sessionId, reason: "idle" });
    const second = await endSession(db, { sessionId, reason: "host_end" });
    expect(second).toEqual({ ended: false, meetingId, meetingStatus: null });
    expect((await meeting(meetingId)).status).toBe("scheduled");
  });

  it("keeps an existing peak when none is given", async () => {
    const { sessionId } = await liveMeeting(3);
    await endSession(db, { sessionId, reason: "idle" });
    expect((await session(sessionId)).peakParticipants).toBe(3);
  });

  it("returns ended:false for an unknown session", async () => {
    expect(await endSession(db, { sessionId: randomUUID(), reason: "idle" })).toEqual({
      ended: false,
      meetingId: null,
      meetingStatus: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/db test`
Expected: FAIL, unresolved import `./end-session`.

- [ ] **Step 3: Implement**

`packages/db/src/end-session.ts`:

```ts
import type { Db } from "./client";

export type EndReason = "host_end" | "api_end" | "idle";
const END_REASONS: readonly string[] = ["host_end", "api_end", "idle"];

export function isEndReason(value: unknown): value is EndReason {
  return typeof value === "string" && END_REASONS.includes(value);
}

export type EndSessionResult = {
  ended: boolean;
  meetingId: string | null;
  meetingStatus: "ended" | "scheduled" | null;
};

/**
 * Single writer of session end and the meeting status transition. Idempotent.
 * host_end / api_end: meeting becomes "ended" (terminal, /join answers 410 from then on).
 * idle: meeting returns to "scheduled" so the next /join starts a new session (spec 4.1: one
 * meeting_sessions row per live instance).
 */
export async function endSession(
  db: Db,
  input: { sessionId: string; reason: EndReason; peakParticipants?: number },
): Promise<EndSessionResult> {
  return db.begin(async (tx) => {
    const [session] = await tx<{ id: string; meetingId: string; endedAt: Date | null }[]>`
      SELECT id, meeting_id, ended_at FROM meeting_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
    if (!session) return { ended: false, meetingId: null, meetingStatus: null };
    if (session.endedAt) return { ended: false, meetingId: session.meetingId, meetingStatus: null };

    await tx`
      UPDATE meeting_sessions
      SET ended_at = now(),
          peak_participants = COALESCE(${input.peakParticipants ?? null}::int, peak_participants)
      WHERE id = ${session.id}`;

    const meetingStatus = input.reason === "idle" ? "scheduled" : "ended";
    if (meetingStatus === "ended") {
      await tx`
        UPDATE meetings SET status = 'ended', ended_at = now()
        WHERE id = ${session.meetingId} AND status = 'live'`;
    } else {
      await tx`
        UPDATE meetings SET status = 'scheduled'
        WHERE id = ${session.meetingId} AND status = 'live'`;
    }
    return { ended: true, meetingId: session.meetingId, meetingStatus };
  });
}
```

Add to `packages/db/src/index.ts`:

```ts
export { endSession, isEndReason, type EndReason, type EndSessionResult } from "./end-session";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/db test`
Expected: PASS (8 tests total).

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add packages/db
git commit -F - <<'EOF'
feat(db): add idempotent endSession with meeting status transition

host_end and api_end are terminal; idle returns the meeting to
scheduled so it can go live again with a new session row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 6: `packages/events`: event bus

**Files:**
- Create: `packages/events/package.json`, `packages/events/tsconfig.json`, `packages/events/src/bus.ts`, `packages/events/src/index.ts`
- Test: `packages/events/src/bus.test.ts`

**Interfaces:**
- Produces: `EventMap` (typed payload per event name), `EventType`, `EventEnvelope<T>` = `{ id, type, key, ts, payload }`, `EventHandler<T>`, `interface EventBus { publish(type, key, payload): void; subscribe(type, handler): () => void }`, `class InMemoryEventBus implements EventBus` with `drain(): Promise<void>` for tests, `topicFor(type)` mapping to the spec 4.4 Kafka topic names.
- Handlers run asynchronously (never on the publisher's stack); handler errors go to the `onError` callback and never reach the publisher. Consumers must be idempotent (at-least-once semantics so Kafka can replace this later).

- [ ] **Step 1: Package files**

`packages/events/package.json`:

```json
{
  "name": "@zoomclone/events",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@zoomclone/protocol": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/events/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/events/src/bus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryEventBus, topicFor } from "./bus";

const sid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11";
const pid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12";

describe("InMemoryEventBus", () => {
  it("delivers envelopes asynchronously to subscribers of that type", async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe("participant.joined", (e) => {
      seen.push(`${e.type}:${e.payload.participant_id}:${e.key}`);
    });
    bus.subscribe("participant.left", () => {
      seen.push("wrong");
    });
    bus.publish("participant.joined", sid, {
      session_id: sid,
      participant_id: pid,
      user_id: null,
      display_name: "Ana",
      role: "attendee",
      joined_at: "2026-09-10T09:00:00.000Z",
    });
    expect(seen).toEqual([]);
    await bus.drain();
    expect(seen).toEqual([`participant.joined:${pid}:${sid}`]);
  });

  it("stamps id and ts and isolates handler failures", async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus((err) => errors.push(err));
    let ok = 0;
    bus.subscribe("session.ended", () => {
      throw new Error("boom");
    });
    bus.subscribe("session.ended", async (e) => {
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(e.ts)).not.toBeNaN();
      ok++;
    });
    bus.publish("session.ended", sid, { session_id: sid, reason: "idle", peak_participants: 2 });
    await bus.drain();
    expect(ok).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    const off = bus.subscribe("room.created", () => {
      count++;
    });
    bus.publish("room.created", sid, { session_id: sid, meeting_id: sid, home_sfu: "sfu-1", epoch: 1 });
    off();
    bus.publish("room.created", sid, { session_id: sid, meeting_id: sid, home_sfu: "sfu-1", epoch: 2 });
    await bus.drain();
    expect(count).toBe(1);
  });

  it("maps event types to spec 4.4 topics", () => {
    expect(topicFor("room.created")).toBe("meeting.lifecycle");
    expect(topicFor("session.ended")).toBe("meeting.lifecycle");
    expect(topicFor("host.action")).toBe("meeting.lifecycle");
    expect(topicFor("participant.joined")).toBe("participant.events");
    expect(topicFor("participant.updated")).toBe("participant.events");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/events test`
Expected: FAIL, unresolved import `./bus`.

- [ ] **Step 4: Implement**

`packages/events/src/bus.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Role } from "@zoomclone/protocol";

/** Typed payloads. Names mirror the spec 4.4 Kafka topics (see topicFor). */
export type EventMap = {
  "room.created": { session_id: string; meeting_id: string; home_sfu: string; epoch: number };
  "session.ended": { session_id: string; reason: string; peak_participants: number };
  "host.action": { session_id: string; actor_id: string; action: string; target_id?: string };
  "participant.joined": {
    session_id: string;
    participant_id: string;
    user_id: string | null;
    display_name: string;
    role: Role;
    joined_at: string;
  };
  "participant.left": {
    session_id: string;
    participant_id: string;
    left_at: string;
    reason: string;
  };
  "participant.updated": {
    session_id: string;
    participant_id: string;
    patch: Record<string, unknown>;
  };
};
export type EventType = keyof EventMap;

export type EventEnvelope<T extends EventType = EventType> = {
  id: string;
  type: T;
  /** Partition key: session_id, so one meeting's events stay ordered (spec 4.4). */
  key: string;
  ts: string;
  payload: EventMap[T];
};

export type EventHandler<T extends EventType> = (event: EventEnvelope<T>) => void | Promise<void>;

export interface EventBus {
  publish<T extends EventType>(type: T, key: string, payload: EventMap[T]): void;
  subscribe<T extends EventType>(type: T, handler: EventHandler<T>): () => void;
}

export type Topic = "meeting.lifecycle" | "participant.events";

export function topicFor(type: EventType): Topic {
  return type.startsWith("participant.") ? "participant.events" : "meeting.lifecycle";
}

/** Single-process bus. Handlers run on a microtask, never on the publisher's stack. */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<EventType, Set<EventHandler<EventType>>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly onError: (error: unknown, event: EventEnvelope) => void = () => {},
  ) {}

  publish<T extends EventType>(type: T, key: string, payload: EventMap[T]): void {
    const event: EventEnvelope<T> = { id: randomUUID(), type, key, ts: new Date().toISOString(), payload };
    for (const handler of this.handlers.get(type) ?? []) {
      const run: Promise<void> = Promise.resolve()
        .then(() => (handler as EventHandler<T>)(event))
        .catch((error: unknown) => this.onError(error, event))
        .finally(() => this.pending.delete(run));
      this.pending.add(run);
    }
  }

  subscribe<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as EventHandler<EventType>);
    return () => {
      set.delete(handler as EventHandler<EventType>);
    };
  }

  /** Test helper: resolves once every handler invocation so far has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}
```

`packages/events/src/index.ts`:

```ts
export * from "./bus";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/events test`
Expected: PASS (4 tests). If TypeScript rejects the `handler as EventHandler<EventType>` casts, cast through `unknown` (`handler as unknown as EventHandler<EventType>`).

- [ ] **Step 6: Full check and commit**

Run: `pnpm check`

```sh
git add packages/events pnpm-lock.yaml
git commit -F - <<'EOF'
feat(events): add typed in-memory event bus

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 7: `packages/tokens`: ES256 keys and signaling JWT

**Files:**
- Create: `packages/tokens/package.json`, `packages/tokens/tsconfig.json`, `packages/tokens/src/keys.ts`, `packages/tokens/src/signaling-token.ts`, `packages/tokens/src/gen-key.ts`, `packages/tokens/src/index.ts`
- Test: `packages/tokens/src/signaling-token.test.ts`

**Interfaces:**
- Produces: `type SigningKeys = { kid; alg: "ES256"; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JWK }`, `loadSigningKeys({ pem?, kid }): Promise<SigningKeys>`, `jwks(keys): { keys: JWK[] }`, `signSignalingToken(keys, issuer, claims: SignalingClaims, now?: Date): Promise<string>`, `verifySignalingToken(token, key: CryptoKey | JWTVerifyGetKey, issuer, now?: Date): Promise<VerifiedSignalingToken>` where `VerifiedSignalingToken = SignalingClaims & { exp: number; iat: number }`.
- Token shape: `alg ES256`, header `kid`, `iss` = issuer, `aud` = `"signaling"`, `sub` = participant_id, `iat`, `exp = iat + 300`, plus the `SignalingClaims` fields.

- [ ] **Step 1: Package files**

`packages/tokens/package.json`:

```json
{
  "name": "@zoomclone/tokens",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "gen-key": "tsx src/gen-key.ts"
  },
  "dependencies": {
    "@zoomclone/protocol": "workspace:*",
    "jose": "6.2.12"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/tokens/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/tokens/src/signaling-token.test.ts`:

```ts
import { createLocalJWKSet, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { jwks, loadSigningKeys } from "./keys";
import { signSignalingToken, verifySignalingToken } from "./signaling-token";

const claims = {
  session_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
  participant_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
  role: "attendee" as const,
  sfu_hint: "sfu-local-1",
  display_name: "Ana",
  lobby_enabled: true,
  max_participants: 500,
};

describe("signaling token", () => {
  it("round-trips claims with a 5 minute expiry and kid header", async () => {
    const keys = await loadSigningKeys({ kid: "test-1" });
    const now = new Date("2026-09-10T09:00:00Z");
    const token = await signSignalingToken(keys, "meeting-api", claims, now);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: "test-1" });
    const verified = await verifySignalingToken(token, keys.publicKey, "meeting-api", now);
    expect(verified).toMatchObject(claims);
    expect(verified.exp - verified.iat).toBe(300);
  });

  it("rejects expired tokens, wrong issuer and wrong audience", async () => {
    const keys = await loadSigningKeys({ kid: "test-1" });
    const issued = new Date("2026-09-10T09:00:00Z");
    const token = await signSignalingToken(keys, "meeting-api", claims, issued);
    await expect(
      verifySignalingToken(token, keys.publicKey, "meeting-api", new Date("2026-09-10T09:05:01Z")),
    ).rejects.toThrow();
    await expect(verifySignalingToken(token, keys.publicKey, "other", issued)).rejects.toThrow();
  });

  it("verifies through a JWKS resolver and rejects tokens from another key", async () => {
    const keys = await loadSigningKeys({ kid: "a" });
    const other = await loadSigningKeys({ kid: "b" });
    const token = await signSignalingToken(keys, "meeting-api", claims);
    const resolver = createLocalJWKSet(jwks(keys));
    await expect(verifySignalingToken(token, resolver, "meeting-api")).resolves.toMatchObject(claims);
    await expect(verifySignalingToken(token, other.publicKey, "meeting-api")).rejects.toThrow();
  });

  it("loads a PKCS8 PEM and derives the matching public key", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const keys = await loadSigningKeys({ pem, kid: "pem-1" });
    const token = await signSignalingToken(keys, "meeting-api", claims);
    await expect(verifySignalingToken(token, keys.publicKey, "meeting-api")).resolves.toBeTruthy();
    expect(jwks(keys).keys[0]).toMatchObject({ kid: "pem-1", alg: "ES256", use: "sig", kty: "EC" });
    expect(jwks(keys).keys[0]).not.toHaveProperty("d");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/tokens test`
Expected: FAIL, unresolved imports `./keys`, `./signaling-token`.

- [ ] **Step 4: Implement**

`packages/tokens/src/keys.ts`:

```ts
import { exportJWK, generateKeyPair, importJWK, importPKCS8, type JWK } from "jose";

export type SigningKeys = {
  kid: string;
  alg: "ES256";
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
};

/** Loads the ES256 signing key from a PKCS8 PEM, or generates an ephemeral pair (dev and test). */
export async function loadSigningKeys(opts: { pem?: string; kid: string }): Promise<SigningKeys> {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  if (opts.pem) {
    privateKey = await importPKCS8(opts.pem, "ES256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    delete jwk.d;
    publicKey = (await importJWK(jwk, "ES256")) as CryptoKey;
  } else {
    ({ privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true }));
  }
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: opts.kid, alg: "ES256", use: "sig" };
  return { kid: opts.kid, alg: "ES256", privateKey, publicKey, publicJwk };
}

export function jwks(keys: SigningKeys): { keys: JWK[] } {
  return { keys: [keys.publicJwk] };
}
```

If TypeScript cannot find the global `CryptoKey` type, add `import type { webcrypto } from "node:crypto";` and use `webcrypto.CryptoKey` in its place.

`packages/tokens/src/signaling-token.ts`:

```ts
import { SignJWT, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
  SIGNALING_AUDIENCE,
  SIGNALING_TOKEN_TTL_SECONDS,
  SignalingClaimsSchema,
  type SignalingClaims,
} from "@zoomclone/protocol";
import type { SigningKeys } from "./keys";

export async function signSignalingToken(
  keys: SigningKeys,
  issuer: string,
  claims: SignalingClaims,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", kid: keys.kid })
    .setIssuer(issuer)
    .setAudience(SIGNALING_AUDIENCE)
    .setSubject(claims.participant_id)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SIGNALING_TOKEN_TTL_SECONDS)
    .sign(keys.privateKey);
}

export type VerifiedSignalingToken = SignalingClaims & { exp: number; iat: number };

/** key: a public CryptoKey, or a jose resolver from createRemoteJWKSet / createLocalJWKSet. */
export async function verifySignalingToken(
  token: string,
  key: CryptoKey | JWTVerifyGetKey,
  issuer: string,
  now: Date = new Date(),
): Promise<VerifiedSignalingToken> {
  const options = {
    issuer,
    audience: SIGNALING_AUDIENCE,
    algorithms: ["ES256"],
    currentDate: now,
  };
  const { payload } =
    typeof key === "function"
      ? await jwtVerify(token, key, options)
      : await jwtVerify(token, key, options);
  const claims = SignalingClaimsSchema.parse(payload);
  return { ...claims, exp: payload.exp as number, iat: payload.iat as number };
}
```

`packages/tokens/src/gen-key.ts` (prints a PKCS8 PEM for `SIGNING_KEY_PEM` in production):

```ts
import { exportPKCS8, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
process.stdout.write(await exportPKCS8(privateKey));
```

`packages/tokens/src/index.ts`:

```ts
export { jwks, loadSigningKeys, type SigningKeys } from "./keys";
export {
  signSignalingToken,
  verifySignalingToken,
  type VerifiedSignalingToken,
} from "./signaling-token";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/tokens test`
Expected: PASS (4 tests). Also `pnpm --filter @zoomclone/tokens gen-key` prints a `-----BEGIN PRIVATE KEY-----` block.

- [ ] **Step 6: Full check and commit**

Run: `pnpm check`

```sh
git add packages/tokens pnpm-lock.yaml
git commit -F - <<'EOF'
feat(tokens): add ES256 signing keys and signaling JWT helpers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 8: `services/meeting-api`: env, app skeleton, error envelope, health and metrics

**Files:**
- Create: `services/meeting-api/package.json`, `services/meeting-api/tsconfig.json`, `services/meeting-api/vitest.config.ts`, `services/meeting-api/src/env.ts`, `services/meeting-api/src/metrics.ts`, `services/meeting-api/src/error-handler.ts`, `services/meeting-api/src/deps.ts`, `services/meeting-api/src/app.ts`, `services/meeting-api/test/helpers.ts`
- Test: `services/meeting-api/src/env.test.ts`, `services/meeting-api/src/app.test.ts`

**Interfaces:**
- Produces: `loadEnv(source): Env` (zod-validated, refuses dev issuer / missing signing key in production); `createMetrics(): Metrics` (`registry`, `joinLatency` histogram `join_latency_seconds`, `joinErrors` counter `join_errors_total{code}`); `errorHandler`, `notFoundHandler` (error envelope `{ error: { code, message, details? } }`, `retry-after` header from `ApiError.retryAfterSeconds`); `type AppDeps`, `type Infra`, `createDeps(env, infra): AppDeps`; `buildApp(deps): Promise<App>` with `app.deps`; test helpers `testRedisUrl()`, `testEnv(overrides)`, `createTestContext(overrides?, infraOverrides?)`, `TestContext`.
- Later tasks add fields to `AppDeps`/`Infra`/`createDeps` and register routes inside `buildApp`; the shape here is the base.

- [ ] **Step 1: Package files**

`services/meeting-api/package.json`:

```json
{
  "name": "@zoomclone/meeting-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "dev": "node --env-file-if-exists=../../.env --import tsx --watch src/main.ts",
    "start": "node --env-file-if-exists=../../.env --import tsx src/main.ts"
  },
  "dependencies": {
    "@zoomclone/db": "workspace:*",
    "@zoomclone/events": "workspace:*",
    "@zoomclone/protocol": "workspace:*",
    "@zoomclone/tokens": "workspace:*",
    "fastify": "5.12.3",
    "fastify-type-provider-zod": "7.0.0",
    "ioredis": "5.11.1",
    "jose": "6.2.12",
    "prom-client": "15.1.3",
    "zod": "4.6.2"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "pino-pretty": "13.1.3",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`services/meeting-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`services/meeting-api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

`services/meeting-api/src/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const base = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", AUTH_DEV_ISSUER: "true" };

describe("loadEnv", () => {
  it("applies defaults and parses lists and booleans", () => {
    const env = loadEnv({ ...base, STUN_URLS: "stun:a:3478, stun:b:3478", TURN_URLS: "" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.MEETING_API_PORT).toBe(8080);
    expect(env.AUTH_DEV_ISSUER).toBe(true);
    expect(env.STUN_URLS).toEqual(["stun:a:3478", "stun:b:3478"]);
    expect(env.TURN_URLS).toEqual([]);
    expect(env.DEFAULT_ORG_ID).toBe("11111111-1111-4111-8111-111111111111");
    expect(env.JOIN_RATE_LIMIT).toBe(10);
    expect(env.JOIN_RATE_WINDOW_MS).toBe(60_000);
  });

  it("requires OIDC settings unless the dev issuer is on", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" })).toThrow(
      /OIDC_ISSUER/,
    );
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_JWKS_URL: "https://idp.example.com/jwks",
    });
    expect(env.AUTH_DEV_ISSUER).toBe(false);
  });

  it("refuses the dev issuer and a missing signing key in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", SIGNING_KEY_PEM: "pem" })).toThrow(
      /AUTH_DEV_ISSUER/,
    );
    expect(() =>
      loadEnv({
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        NODE_ENV: "production",
        OIDC_ISSUER: "https://idp.example.com",
        OIDC_JWKS_URL: "https://idp.example.com/jwks",
      }),
    ).toThrow(/SIGNING_KEY_PEM/);
  });
});
```

`services/meeting-api/src/app.test.ts`:

```ts
import { ApiError } from "@zoomclone/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../test/helpers";
import { buildApp } from "./app";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe("app skeleton", () => {
  it("serves /healthz", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "route not found" } });
  });

  it("exposes prometheus metrics", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("join_latency_seconds");
    expect(res.body).toContain("join_errors_total");
  });

  it("renders ApiError with status, code and retry-after, and hides internal errors", async () => {
    const app = await buildApp(ctx.deps);
    app.get("/boom", async () => {
      throw new ApiError("RATE_LIMITED", "slow down", 12);
    });
    app.get("/crash", async () => {
      throw new Error("secret detail");
    });
    await app.ready();
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(429);
    expect(boom.headers["retry-after"]).toBe("12");
    expect(boom.json()).toEqual({ error: { code: "RATE_LIMITED", message: "slow down" } });
    const crash = await app.inject({ method: "GET", url: "/crash" });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    await app.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: FAIL, unresolved imports.

- [ ] **Step 4: Implement**

`services/meeting-api/src/env.ts`:

```ts
import { z } from "zod";

const bool = z.stringbool().default(false);
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    MEETING_API_PORT: z.coerce.number().int().default(8080),
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    TOKEN_ISSUER: z.string().default("meeting-api"),
    SIGNING_KEY_PEM: z.string().optional(),
    SIGNING_KID: z.string().default("dev-1"),
    AUTH_DEV_ISSUER: bool,
    DEV_ISSUER_URL: z.string().default("http://localhost:8080/dev/oidc"),
    OIDC_ISSUER: z.string().optional(),
    OIDC_AUDIENCE: z.string().default("zoomclone"),
    OIDC_JWKS_URL: z.string().optional(),
    DEFAULT_ORG_ID: z.uuid().default("11111111-1111-4111-8111-111111111111"),
    DEFAULT_REGION: z.string().default("local"),
    SFU_ID: z.string().default("sfu-local-1"),
    SIGNALING_PUBLIC_URL: z.string().default("ws://localhost:8081"),
    STUN_URLS: csv,
    TURN_URLS: csv,
    TURN_SECRET: z.string().optional(),
    TURN_TTL_SECONDS: z.coerce.number().int().default(3600),
    JOIN_RATE_LIMIT: z.coerce.number().int().default(10),
    JOIN_RATE_WINDOW_MS: z.coerce.number().int().default(60_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (env.AUTH_DEV_ISSUER) {
        ctx.addIssue({
          code: "custom",
          path: ["AUTH_DEV_ISSUER"],
          message: "AUTH_DEV_ISSUER must be false in production",
        });
      }
      if (!env.SIGNING_KEY_PEM) {
        ctx.addIssue({
          code: "custom",
          path: ["SIGNING_KEY_PEM"],
          message: "SIGNING_KEY_PEM is required in production",
        });
      }
    }
    if (!env.AUTH_DEV_ISSUER && (!env.OIDC_ISSUER || !env.OIDC_JWKS_URL)) {
      ctx.addIssue({
        code: "custom",
        path: ["OIDC_ISSUER"],
        message: "OIDC_ISSUER and OIDC_JWKS_URL are required unless AUTH_DEV_ISSUER=true",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
```

`services/meeting-api/src/metrics.ts`:

```ts
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export type Metrics = {
  registry: Registry;
  joinLatency: Histogram<string>;
  joinErrors: Counter<"code">;
};

/** Spec 9.1 join metrics. A fresh registry per app instance keeps tests independent. */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const joinLatency = new Histogram({
    name: "join_latency_seconds",
    help: "POST /join latency in seconds",
    buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });
  const joinErrors = new Counter({
    name: "join_errors_total",
    help: "POST /join errors by code",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  return { registry, joinLatency, joinErrors };
}
```

`services/meeting-api/src/error-handler.ts`:

```ts
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { ApiError } from "@zoomclone/protocol";

/** Every error leaves as { error: { code, message, details? } }. Internal details never leak. */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    }
    return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply.status(400).send({
      error: { code: "VALIDATION", message: "request validation failed", details: error.validation },
    });
  }
  if (isResponseSerializationError(error)) {
    request.log.error(error, "response serialization failed");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "internal error" } });
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error(error);
    return reply.status(status).send({ error: { code: "INTERNAL", message: "internal error" } });
  }
  const code = status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : "VALIDATION";
  return reply.status(status).send({ error: { code, message: error.message } });
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({ error: { code: "NOT_FOUND", message: "route not found" } });
}
```

`services/meeting-api/src/deps.ts`:

```ts
import type Redis from "ioredis";
import type { Db } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import type { SigningKeys } from "@zoomclone/tokens";
import type { Env } from "./env";
import { createMetrics, type Metrics } from "./metrics";

/** Infrastructure handles created by main.ts or by tests. */
export type Infra = {
  db: Db;
  redis: Redis;
  bus: EventBus;
  keys: SigningKeys;
  clock?: () => Date;
};

export type AppDeps = {
  env: Env;
  metrics: Metrics;
  db: Db;
  redis: Redis;
  bus: EventBus;
  keys: SigningKeys;
  clock: () => Date;
};

export function createDeps(env: Env, infra: Infra): AppDeps {
  return {
    env,
    metrics: createMetrics(),
    db: infra.db,
    redis: infra.redis,
    bus: infra.bus,
    keys: infra.keys,
    clock: infra.clock ?? (() => new Date()),
  };
}
```

`services/meeting-api/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { AppDeps } from "./deps";
import { errorHandler, notFoundHandler } from "./error-handler";

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export type App = FastifyInstance;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({
    logger: deps.env.NODE_ENV === "test" ? false : { level: deps.env.LOG_LEVEL },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.decorate("deps", deps);

  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/healthz", async () => ({ ok: true }));
  r.get("/metrics", async (_req, reply) => {
    reply.header("content-type", deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });

  return app;
}
```

`services/meeting-api/test/helpers.ts`:

```ts
import Redis from "ioredis";
import { createDb, type Db } from "@zoomclone/db";
import { ensureTestDatabase, testDatabaseUrl, truncateAll } from "@zoomclone/db/testing";
import { InMemoryEventBus } from "@zoomclone/events";
import { loadSigningKeys } from "@zoomclone/tokens";
import { buildApp, type App } from "../src/app";
import { createDeps, type AppDeps, type Infra } from "../src/deps";
import { loadEnv, type Env } from "../src/env";

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? "redis://localhost:56379/1";
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    AUTH_DEV_ISSUER: "true",
    STUN_URLS: "stun:stun.example.com:3478",
    TURN_URLS: "turn:turn.example.com:443?transport=tcp",
    TURN_SECRET: "turn-secret",
    JOIN_RATE_LIMIT: "1000",
    ...overrides,
  });
}

export type TestContext = {
  app: App;
  deps: AppDeps;
  env: Env;
  db: Db;
  redis: Redis;
  close: () => Promise<void>;
};

/** Fresh app against the real test Postgres (truncated) and Redis db 1 (flushed). */
export async function createTestContext(
  envOverrides: Record<string, string> = {},
  infraOverrides: Partial<Omit<Infra, "db" | "redis" | "bus" | "keys">> = {},
): Promise<TestContext> {
  await ensureTestDatabase();
  const env = testEnv(envOverrides);
  const db = createDb(env.DATABASE_URL, { max: 10 });
  const redis = new Redis(env.REDIS_URL);
  await truncateAll(db);
  await redis.flushdb();
  const keys = await loadSigningKeys({ kid: env.SIGNING_KID });
  const deps = createDeps(env, { db, redis, bus: new InMemoryEventBus(), keys, ...infraOverrides });
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    env,
    db,
    redis,
    close: async () => {
      await app.close();
      await redis.quit();
      await db.end();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: PASS (7 tests).

- [ ] **Step 6: Full check and commit**

Run: `pnpm check`

```sh
git add services/meeting-api pnpm-lock.yaml
git commit -F - <<'EOF'
feat(meeting-api): add env, app skeleton, error envelope and metrics

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 9: `services/meeting-api`: user auth (OIDC verify, dev issuer, jwks, /v1/me)

**Files:**
- Create: `services/meeting-api/src/auth/user-id.ts`, `services/meeting-api/src/auth/user-verifier.ts`, `services/meeting-api/src/auth/hooks.ts`, `services/meeting-api/src/auth/dev-issuer.ts`, `services/meeting-api/src/auth/routes.ts`
- Modify: `services/meeting-api/src/deps.ts`, `services/meeting-api/src/app.ts`, `services/meeting-api/test/helpers.ts`
- Test: `services/meeting-api/src/auth/user-id.test.ts`, `services/meeting-api/src/auth/auth.test.ts`

**Interfaces:**
- Produces: `type AuthUser = { id: string; orgId: string; name: string }`, `interface UserVerifier { verify(bearer): Promise<AuthUser> }`, `OidcUserVerifier`, `createUserVerifier(env, keys)`, `registerAuthHook(app, verifier)` (sets `req.user`, 401 on a bad bearer anywhere), `requireUser(req): AuthUser`, `userIdFromSubject(issuer, sub)`, `isUuid(s)`, `devIssuerRoutes` (`GET /dev/oidc/jwks.json`, `POST /dev/oidc/token` body `{ sub?, org_id?, name? }`), `authRoutes` (`GET /.well-known/jwks.json`, `GET /v1/me`).
- `AppDeps` gains `userVerifier: UserVerifier`. Test helpers gain `mintUser(ctx, { sub?, org_id?, name? })` returning `{ token, sub, orgId }` and `bearer(token)`.

- [ ] **Step 1: Write the failing tests**

`services/meeting-api/src/auth/user-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isUuid, userIdFromSubject, uuidV5 } from "./user-id";

describe("user ids", () => {
  it("passes UUID subjects through, lowercased", () => {
    expect(userIdFromSubject("https://idp", "2F6A2B6E-6F0B-4C1E-9A52-0C5D3F1A9B12")).toBe(
      "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
    );
  });

  it("maps non-UUID subjects to a stable v5 UUID scoped by issuer", () => {
    const a = userIdFromSubject("https://idp", "alice");
    expect(isUuid(a)).toBe(true);
    expect(a).toBe(userIdFromSubject("https://idp", "alice"));
    expect(a).not.toBe(userIdFromSubject("https://other", "alice"));
    expect(a.charAt(14)).toBe("5");
  });

  it("uuidV5 matches RFC 4122 test vector (DNS namespace, python.org)", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });
});
```

`services/meeting-api/src/auth/auth.test.ts`:

```ts
import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestContext, mintUser, type TestContext } from "../../test/helpers";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe("auth", () => {
  it("publishes the signaling verification key", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: Array<Record<string, unknown>> }>();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kid: ctx.env.SIGNING_KID, alg: "ES256", kty: "EC" });
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("mints dev tokens that identify the user on /v1/me", async () => {
    const { token, sub, orgId } = await mintUser(ctx, { name: "Ana" });
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: sub, org_id: orgId, name: "Ana" });
  });

  it("falls back to the default org and name", async () => {
    const { token } = await mintUser(ctx, {});
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.json()).toMatchObject({ org_id: ctx.env.DEFAULT_ORG_ID, name: "Dev User" });
  });

  it("requires a bearer on /v1/me and rejects bad bearers everywhere", async () => {
    const missing = await ctx.app.inject({ method: "GET", url: "/v1/me" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "bearer token required" },
    });
    const garbage = await ctx.app.inject({
      method: "GET",
      url: "/healthz",
      headers: bearer("not.a.jwt"),
    });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects tokens signed by another key", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: ctx.env.SIGNING_KID })
      .setIssuer(ctx.env.DEV_ISSUER_URL)
      .setAudience(ctx.env.OIDC_AUDIENCE)
      .setSubject("2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
  });

  it("does not serve the dev issuer when it is disabled", async () => {
    const prod = await createTestContext({
      AUTH_DEV_ISSUER: "false",
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_JWKS_URL: "https://idp.example.com/jwks",
    });
    try {
      const res = await prod.app.inject({ method: "POST", url: "/dev/oidc/token", payload: {} });
      expect(res.statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: FAIL, unresolved `./user-id`, and `mintUser`/`bearer` missing from helpers.

- [ ] **Step 3: Implement**

`services/meeting-api/src/auth/user-id.ts`:

```ts
import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Fixed namespace for mapping external OIDC subjects to internal user UUIDs. */
export const USER_ID_NAMESPACE = "0d2a6c5e-5b1e-4f1a-9c3d-2e7f8a9b0c1d";

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** RFC 4122 version 5 (SHA-1) UUID. */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The schema stores organizer_id / user_id as UUIDs while OIDC subjects are arbitrary strings.
 * UUID subjects pass through; anything else maps deterministically, scoped by issuer.
 */
export function userIdFromSubject(issuer: string, sub: string): string {
  return isUuid(sub) ? sub.toLowerCase() : uuidV5(USER_ID_NAMESPACE, `${issuer}|${sub}`);
}
```

`services/meeting-api/src/auth/user-verifier.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ApiError } from "@zoomclone/protocol";
import type { SigningKeys } from "@zoomclone/tokens";
import type { Env } from "../env";
import { isUuid, userIdFromSubject } from "./user-id";

export type AuthUser = { id: string; orgId: string; name: string };

export interface UserVerifier {
  /** Throws ApiError("UNAUTHORIZED") for any invalid token. */
  verify(bearer: string): Promise<AuthUser>;
}

export class OidcUserVerifier implements UserVerifier {
  constructor(
    private readonly opts: {
      key: CryptoKey | JWTVerifyGetKey;
      issuer: string;
      audience: string;
      defaultOrgId: string;
    },
  ) {}

  async verify(bearer: string): Promise<AuthUser> {
    const { key, issuer, audience } = this.opts;
    let payload: JWTPayload;
    try {
      ({ payload } =
        typeof key === "function"
          ? await jwtVerify(bearer, key, { issuer, audience })
          : await jwtVerify(bearer, key, { issuer, audience }));
    } catch {
      throw new ApiError("UNAUTHORIZED", "invalid bearer token");
    }
    if (!payload.sub) throw new ApiError("UNAUTHORIZED", "token has no subject");
    const orgClaim = payload["org_id"];
    const orgId = typeof orgClaim === "string" && isUuid(orgClaim) ? orgClaim : this.opts.defaultOrgId;
    const nameClaim = payload["name"];
    const name = typeof nameClaim === "string" && nameClaim.trim() ? nameClaim.trim() : "User";
    return { id: userIdFromSubject(payload.iss ?? issuer, payload.sub), orgId, name };
  }
}

export function createUserVerifier(env: Env, keys: SigningKeys): UserVerifier {
  if (env.AUTH_DEV_ISSUER) {
    return new OidcUserVerifier({
      key: keys.publicKey,
      issuer: env.DEV_ISSUER_URL,
      audience: env.OIDC_AUDIENCE,
      defaultOrgId: env.DEFAULT_ORG_ID,
    });
  }
  return new OidcUserVerifier({
    key: createRemoteJWKSet(new URL(env.OIDC_JWKS_URL as string)),
    issuer: env.OIDC_ISSUER as string,
    audience: env.OIDC_AUDIENCE,
    defaultOrgId: env.DEFAULT_ORG_ID,
  });
}
```

`services/meeting-api/src/auth/hooks.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "@zoomclone/protocol";
import type { AuthUser, UserVerifier } from "./user-verifier";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/** Verifies any bearer on any request. A bad token is 401 everywhere; no token is allowed (guest routes decide). */
export function registerAuthHook(app: FastifyInstance, verifier: UserVerifier): void {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = bearerFrom(req);
    req.user = token ? await verifier.verify(token) : null;
  });
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new ApiError("UNAUTHORIZED", "bearer token required");
  return req.user;
}
```

`services/meeting-api/src/auth/dev-issuer.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SignJWT } from "jose";
import { z } from "zod";
import type { SigningKeys } from "@zoomclone/tokens";

const DevTokenRequestSchema = z.object({
  sub: z.uuid().optional(),
  org_id: z.uuid().optional(),
  name: z.string().min(1).max(80).optional(),
});

const DevTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  sub: z.string(),
  org_id: z.string(),
});

export type DevIssuerOptions = {
  keys: SigningKeys;
  issuerUrl: string;
  audience: string;
  defaultOrgId: string;
};

/** Local OIDC stand-in. Mints user bearers with the meeting-api signing key. env.ts refuses it in production. */
export const devIssuerRoutes: FastifyPluginAsync<DevIssuerOptions> = async (app, opts) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/dev/oidc/jwks.json", async () => ({ keys: [opts.keys.publicJwk] }));
  r.post(
    "/dev/oidc/token",
    { schema: { body: DevTokenRequestSchema, response: { 200: DevTokenResponseSchema } } },
    async (req) => {
      const sub = req.body.sub ?? randomUUID();
      const orgId = req.body.org_id ?? opts.defaultOrgId;
      const accessToken = await new SignJWT({ org_id: orgId, name: req.body.name ?? "Dev User" })
        .setProtectedHeader({ alg: "ES256", kid: opts.keys.kid })
        .setIssuer(opts.issuerUrl)
        .setAudience(opts.audience)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(opts.keys.privateKey);
      return {
        access_token: accessToken,
        token_type: "Bearer" as const,
        expires_in: 3600,
        sub,
        org_id: orgId,
      };
    },
  );
};
```

`services/meeting-api/src/auth/routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { MeResponseSchema } from "@zoomclone/protocol";
import { jwks } from "@zoomclone/tokens";
import { requireUser } from "./hooks";

export const authRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/.well-known/jwks.json", async () => jwks(app.deps.keys));
  r.get("/v1/me", { schema: { response: { 200: MeResponseSchema } } }, async (req) => {
    const user = requireUser(req);
    return { id: user.id, org_id: user.orgId, name: user.name };
  });
};
```

Modify `services/meeting-api/src/deps.ts`: add the import and field, and construct the verifier.

```ts
import { createUserVerifier, type UserVerifier } from "./auth/user-verifier";
// in AppDeps:
  userVerifier: UserVerifier;
// in createDeps return object:
    userVerifier: createUserVerifier(env, infra.keys),
```

Modify `services/meeting-api/src/app.ts`: after `app.decorate("deps", deps);` add

```ts
  registerAuthHook(app, deps.userVerifier);
  await app.register(authRoutes);
  if (deps.env.AUTH_DEV_ISSUER) {
    await app.register(devIssuerRoutes, {
      keys: deps.keys,
      issuerUrl: deps.env.DEV_ISSUER_URL,
      audience: deps.env.OIDC_AUDIENCE,
      defaultOrgId: deps.env.DEFAULT_ORG_ID,
    });
  }
```

with imports

```ts
import { devIssuerRoutes } from "./auth/dev-issuer";
import { registerAuthHook } from "./auth/hooks";
import { authRoutes } from "./auth/routes";
```

Add to `services/meeting-api/test/helpers.ts`:

```ts
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function mintUser(
  ctx: TestContext,
  body: { sub?: string; org_id?: string; name?: string },
): Promise<{ token: string; sub: string; orgId: string }> {
  const res = await ctx.app.inject({ method: "POST", url: "/dev/oidc/token", payload: body });
  if (res.statusCode !== 200) throw new Error(`dev token failed: ${res.body}`);
  const json = res.json<{ access_token: string; sub: string; org_id: string }>();
  return { token: json.access_token, sub: json.sub, orgId: json.org_id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/meeting-api
git commit -F - <<'EOF'
feat(meeting-api): add OIDC user auth, dev issuer and jwks endpoints

Non-UUID OIDC subjects map to a v5 UUID scoped by issuer because the
spec schema stores organizer and user ids as UUIDs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 10: `services/meeting-api`: meetings CRUD and `:end`

**Files:**
- Create: `services/meeting-api/src/meetings/mapper.ts`, `services/meeting-api/src/meetings/repo.ts`, `services/meeting-api/src/meetings/service.ts`, `services/meeting-api/src/meetings/routes.ts`, `services/meeting-api/src/room-control.ts`
- Modify: `services/meeting-api/src/deps.ts`, `services/meeting-api/src/app.ts`, `services/meeting-api/test/helpers.ts`
- Test: `services/meeting-api/src/meetings/meetings.test.ts`

**Interfaces:**
- Produces: `MeetingsRepo` (`insert`, `byId`, `byCode`, `update`, `setStatus`, `liveSession`), `isUniqueViolation(err)`, `MeetingsService` (`create`, `get`, `update`, `cancel`, `end`), `toMeetingResponse(row)`, `interface RoomControl { publishEnd(sessionId, reason): Promise<void> }`, `RedisRoomControl`, `ctlChannel(sessionId) = "room:<sessionId>:ctl"`, `meetingRoutes` (registered under `/v1`).
- `AppDeps` gains `meetingsRepo`, `meetings`, `roomControl`; `Infra` gains optional `codeRng`. Test helpers gain `startSession(db, meetingId, sfuId?)`.

- [ ] **Step 1: Write the failing test**

`services/meeting-api/src/meetings/meetings.test.ts`:

```ts
import Redis from "ioredis";
import { MEETING_CODE_RE, MeetingResponseSchema, type MeetingResponse } from "@zoomclone/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bearer,
  createTestContext,
  mintUser,
  startSession,
  testRedisUrl,
  type TestContext,
} from "../../test/helpers";
import { ctlChannel } from "../room-control";

let ctx: TestContext;
let host: { token: string; sub: string; orgId: string };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  host = await mintUser(ctx, { name: "Host" });
});

async function createMeeting(token = host.token, body: unknown = {}): Promise<MeetingResponse> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/v1/meetings",
    headers: bearer(token),
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return MeetingResponseSchema.parse(res.json());
}

describe("POST /v1/meetings", () => {
  it("creates a scheduled meeting with a spec-shaped code and default settings", async () => {
    const m = await createMeeting(host.token, { title: "Standup" });
    expect(m.code).toMatch(MEETING_CODE_RE);
    expect(m.status).toBe("scheduled");
    expect(m.settings).toEqual({ lobby: true, max_participants: 500 });
    expect(m.organizer_id).toBe(host.sub);
    expect(m.org_id).toBe(host.orgId);
    expect(m.region).toBe(ctx.env.DEFAULT_REGION);
    expect(m.title).toBe("Standup");
  });

  it("accepts settings and a schedule", async () => {
    const m = await createMeeting(host.token, {
      scheduled_start: "2026-09-10T09:00:00Z",
      scheduled_end: "2026-09-10T09:30:00Z",
      settings: { lobby: false, max_participants: 10 },
    });
    expect(m.settings).toEqual({ lobby: false, max_participants: 10 });
    expect(m.scheduled_start).toBe("2026-09-10T09:00:00.000Z");
  });

  it("rejects an end before the start, malformed JSON and missing auth", async () => {
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/v1/meetings",
      headers: bearer(host.token),
      payload: { scheduled_start: "2026-09-10T09:30:00Z", scheduled_end: "2026-09-10T09:00:00Z" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
    const malformed = await ctx.app.inject({
      method: "POST",
      url: "/v1/meetings",
      headers: { ...bearer(host.token), "content-type": "application/json" },
      payload: "{oops",
    });
    expect(malformed.statusCode).toBe(400);
    const anon = await ctx.app.inject({ method: "POST", url: "/v1/meetings", payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it("retries on a meeting code collision", async () => {
    let draws = 0;
    const rng = () => (draws++ < 20 ? 0 : 1);
    const local = await createTestContext({}, { codeRng: rng });
    try {
      const u = await mintUser(local, {});
      const first = await local.app.inject({
        method: "POST",
        url: "/v1/meetings",
        headers: bearer(u.token),
        payload: {},
      });
      expect(first.json().code).toBe("aaa-aaaa-aaa");
      const second = await local.app.inject({
        method: "POST",
        url: "/v1/meetings",
        headers: bearer(u.token),
        payload: {},
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().code).toBe("bbb-bbbb-bbb");
    } finally {
      await local.close();
    }
  });
});

describe("GET /v1/meetings/:id", () => {
  it("returns own-org meetings and hides others", async () => {
    const m = await createMeeting();
    const ok = await ctx.app.inject({
      method: "GET",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(m.id);
    const stranger = await mintUser(ctx, { org_id: "22222222-2222-4222-8222-222222222222" });
    const hidden = await ctx.app.inject({
      method: "GET",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(stranger.token),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("MEETING_NOT_FOUND");
    const badId = await ctx.app.inject({
      method: "GET",
      url: "/v1/meetings/not-a-uuid",
      headers: bearer(host.token),
    });
    expect(badId.statusCode).toBe(400);
  });
});

describe("PATCH /v1/meetings/:id", () => {
  it("lets the organizer update title, schedule and settings, including nulls", async () => {
    const m = await createMeeting(host.token, { title: "Old" });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
      payload: { title: null, settings: { lobby: false } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBeNull();
    expect(res.json().settings).toEqual({ lobby: false, max_participants: 500 });
  });

  it("is organizer only", async () => {
    const m = await createMeeting();
    const colleague = await mintUser(ctx, { org_id: host.orgId });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(colleague.token),
      payload: { title: "Hijack" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});

describe("DELETE /v1/meetings/:id", () => {
  it("cancels a scheduled meeting", async () => {
    const m = await createMeeting();
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(res.statusCode).toBe(204);
    const after = await ctx.app.inject({
      method: "GET",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(after.json().status).toBe("cancelled");
  });

  it("refuses to cancel a live meeting", async () => {
    const m = await createMeeting();
    await startSession(ctx.db, m.id);
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/meetings/${m.id}`,
      headers: bearer(host.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});

describe("POST /v1/meetings/:id::end", () => {
  it("returns NOT_LIVE when there is no live session", async () => {
    const m = await createMeeting();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/meetings/${m.id}:end`,
      headers: bearer(host.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NOT_LIVE");
  });

  it("ends the live session, marks the meeting ended and notifies the room controller", async () => {
    const m = await createMeeting();
    const sessionId = await startSession(ctx.db, m.id);
    const sub = new Redis(testRedisUrl());
    await sub.subscribe(ctlChannel(sessionId));
    const message = new Promise<string>((resolve) => sub.on("message", (_c, msg) => resolve(msg)));
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/v1/meetings/${m.id}:end`,
        headers: bearer(host.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ session_id: sessionId });
      expect(JSON.parse(await message)).toEqual({ cmd: "end", reason: "api_end" });
      const [session] = await ctx.db`SELECT ended_at FROM meeting_sessions WHERE id = ${sessionId}`;
      expect(session?.endedAt).toBeInstanceOf(Date);
      const after = await ctx.app.inject({
        method: "GET",
        url: `/v1/meetings/${m.id}`,
        headers: bearer(host.token),
      });
      expect(after.json().status).toBe("ended");
    } finally {
      await sub.quit();
    }
  });

  it("is organizer only", async () => {
    const m = await createMeeting();
    await startSession(ctx.db, m.id);
    const colleague = await mintUser(ctx, { org_id: host.orgId });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/meetings/${m.id}:end`,
      headers: bearer(colleague.token),
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: FAIL, unresolved `../room-control`, missing `startSession`.

- [ ] **Step 3: Implement**

`services/meeting-api/src/room-control.ts`:

```ts
import type Redis from "ioredis";
import type { EndReason } from "@zoomclone/db";

/** Control plane to room controller commands (design doc: Redis pub/sub channel per session). */
export interface RoomControl {
  publishEnd(sessionId: string, reason: EndReason): Promise<void>;
}

export function ctlChannel(sessionId: string): string {
  return `room:${sessionId}:ctl`;
}

export class RedisRoomControl implements RoomControl {
  constructor(private readonly redis: Redis) {}

  async publishEnd(sessionId: string, reason: EndReason): Promise<void> {
    await this.redis.publish(ctlChannel(sessionId), JSON.stringify({ cmd: "end", reason }));
  }
}
```

`services/meeting-api/src/meetings/mapper.ts`:

```ts
import type { MeetingRow } from "@zoomclone/db";
import type { MeetingResponse } from "@zoomclone/protocol";

export function toMeetingResponse(row: MeetingRow): MeetingResponse {
  return {
    id: row.id,
    code: row.code,
    org_id: row.orgId,
    organizer_id: row.organizerId,
    title: row.title,
    scheduled_start: row.scheduledStart?.toISOString() ?? null,
    scheduled_end: row.scheduledEnd?.toISOString() ?? null,
    region: row.region,
    settings: row.settings,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
  };
}
```

`services/meeting-api/src/meetings/repo.ts`:

```ts
import type { Db, MeetingRow, SessionRow } from "@zoomclone/db";
import type { MeetingSettings, MeetingStatus } from "@zoomclone/protocol";

export type NewMeeting = Omit<MeetingRow, "createdAt" | "endedAt">;

export type MeetingPatch = {
  title: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  settings: MeetingSettings;
};

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export class MeetingsRepo {
  constructor(private readonly db: Db) {}

  async insert(m: NewMeeting): Promise<MeetingRow> {
    const [row] = await this.db<MeetingRow[]>`
      INSERT INTO meetings (id, code, org_id, organizer_id, title, scheduled_start, scheduled_end,
                            region, settings, status)
      VALUES (${m.id}, ${m.code}, ${m.orgId}, ${m.organizerId}, ${m.title}, ${m.scheduledStart},
              ${m.scheduledEnd}, ${m.region}, ${this.db.json(m.settings)}, ${m.status})
      RETURNING *`;
    return row as MeetingRow;
  }

  async byId(id: string): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`SELECT * FROM meetings WHERE id = ${id}`;
    return row ?? null;
  }

  async byCode(code: string): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`SELECT * FROM meetings WHERE code = ${code}`;
    return row ?? null;
  }

  async update(id: string, patch: MeetingPatch): Promise<MeetingRow | null> {
    const [row] = await this.db<MeetingRow[]>`
      UPDATE meetings
      SET title = ${patch.title}, scheduled_start = ${patch.scheduledStart},
          scheduled_end = ${patch.scheduledEnd}, settings = ${this.db.json(patch.settings)}
      WHERE id = ${id}
      RETURNING *`;
    return row ?? null;
  }

  async setStatus(id: string, status: MeetingStatus): Promise<void> {
    await this.db`UPDATE meetings SET status = ${status} WHERE id = ${id}`;
  }

  async liveSession(meetingId: string): Promise<SessionRow | null> {
    const [row] = await this.db<SessionRow[]>`
      SELECT * FROM meeting_sessions WHERE meeting_id = ${meetingId} AND ended_at IS NULL`;
    return row ?? null;
  }
}
```

`services/meeting-api/src/meetings/service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { endSession, type Db, type MeetingRow } from "@zoomclone/db";
import {
  ApiError,
  MeetingSettingsSchema,
  generateMeetingCode,
  type CodeRng,
  type CreateMeetingRequest,
  type UpdateMeetingRequest,
} from "@zoomclone/protocol";
import type { AuthUser } from "../auth/user-verifier";
import type { RoomControl } from "../room-control";
import { isUniqueViolation, MeetingsRepo } from "./repo";

const CODE_ATTEMPTS = 5;

export class MeetingsService {
  constructor(
    private readonly deps: {
      db: Db;
      repo: MeetingsRepo;
      roomControl: RoomControl;
      region: string;
      codeRng?: CodeRng;
    },
  ) {}

  async create(user: AuthUser, input: CreateMeetingRequest): Promise<MeetingRow> {
    const settings = MeetingSettingsSchema.parse(input.settings ?? {});
    const scheduledStart = input.scheduled_start ? new Date(input.scheduled_start) : null;
    const scheduledEnd = input.scheduled_end ? new Date(input.scheduled_end) : null;
    assertWindow(scheduledStart, scheduledEnd);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.repo.insert({
          id: randomUUID(),
          code: generateMeetingCode(this.deps.codeRng),
          orgId: user.orgId,
          organizerId: user.id,
          title: input.title ?? null,
          scheduledStart,
          scheduledEnd,
          region: this.deps.region,
          settings,
          status: "scheduled",
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= CODE_ATTEMPTS) throw err;
      }
    }
  }

  /** Org-scoped read: meetings of other orgs look like they do not exist. */
  async get(user: AuthUser, id: string): Promise<MeetingRow> {
    const meeting = await this.deps.repo.byId(id);
    if (!meeting || meeting.orgId !== user.orgId) {
      throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    }
    return meeting;
  }

  async update(user: AuthUser, id: string, input: UpdateMeetingRequest): Promise<MeetingRow> {
    const current = await this.organizerOnly(user, id);
    const settings = MeetingSettingsSchema.parse({ ...current.settings, ...(input.settings ?? {}) });
    const scheduledStart = resolveDate(input.scheduled_start, current.scheduledStart);
    const scheduledEnd = resolveDate(input.scheduled_end, current.scheduledEnd);
    assertWindow(scheduledStart, scheduledEnd);
    const title = input.title === undefined ? current.title : input.title;
    const updated = await this.deps.repo.update(id, { title, scheduledStart, scheduledEnd, settings });
    if (!updated) throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    return updated;
  }

  async cancel(user: AuthUser, id: string): Promise<void> {
    const meeting = await this.organizerOnly(user, id);
    if (meeting.status === "live" || (await this.deps.repo.liveSession(id))) {
      throw new ApiError("CONFLICT", "meeting is live; end it first");
    }
    if (meeting.status === "ended") throw new ApiError("ENDED", "meeting has ended");
    await this.deps.repo.setStatus(id, "cancelled");
  }

  /** Spec 5.1 "Host ends for all". Writes Postgres first so it works with no controller alive. */
  async end(user: AuthUser, id: string): Promise<{ sessionId: string }> {
    await this.organizerOnly(user, id);
    const session = await this.deps.repo.liveSession(id);
    if (!session) throw new ApiError("NOT_LIVE", "meeting is not live");
    await endSession(this.deps.db, { sessionId: session.id, reason: "api_end" });
    await this.deps.roomControl.publishEnd(session.id, "api_end");
    return { sessionId: session.id };
  }

  private async organizerOnly(user: AuthUser, id: string): Promise<MeetingRow> {
    const meeting = await this.get(user, id);
    if (meeting.organizerId !== user.id) throw new ApiError("FORBIDDEN", "organizer only");
    return meeting;
  }
}

function resolveDate(input: string | null | undefined, current: Date | null): Date | null {
  if (input === undefined) return current;
  return input === null ? null : new Date(input);
}

function assertWindow(start: Date | null, end: Date | null): void {
  if (start && end && end.getTime() <= start.getTime()) {
    throw new ApiError("VALIDATION", "scheduled_end must be after scheduled_start");
  }
}
```

`services/meeting-api/src/meetings/routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateMeetingRequestSchema,
  EndMeetingResponseSchema,
  IdParamsSchema,
  MeetingResponseSchema,
  UpdateMeetingRequestSchema,
} from "@zoomclone/protocol";
import { requireUser } from "../auth/hooks";
import { toMeetingResponse } from "./mapper";

/** Spec 5.1 meeting routes. Registered with prefix /v1. */
export const meetingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const meetings = app.deps.meetings;

  r.post(
    "/meetings",
    { schema: { body: CreateMeetingRequestSchema, response: { 201: MeetingResponseSchema } } },
    async (req, reply) => {
      const row = await meetings.create(requireUser(req), req.body);
      return reply.status(201).send(toMeetingResponse(row));
    },
  );

  r.get(
    "/meetings/:id",
    { schema: { params: IdParamsSchema, response: { 200: MeetingResponseSchema } } },
    async (req) => toMeetingResponse(await meetings.get(requireUser(req), req.params.id)),
  );

  r.patch(
    "/meetings/:id",
    {
      schema: {
        params: IdParamsSchema,
        body: UpdateMeetingRequestSchema,
        response: { 200: MeetingResponseSchema },
      },
    },
    async (req) =>
      toMeetingResponse(await meetings.update(requireUser(req), req.params.id, req.body)),
  );

  r.delete("/meetings/:id", { schema: { params: IdParamsSchema } }, async (req, reply) => {
    await meetings.cancel(requireUser(req), req.params.id);
    return reply.status(204).send();
  });

  // Literal colon in a Fastify route is written as "::".
  r.post(
    "/meetings/:id::end",
    { schema: { params: IdParamsSchema, response: { 200: EndMeetingResponseSchema } } },
    async (req) => {
      const { sessionId } = await meetings.end(requireUser(req), req.params.id);
      return { session_id: sessionId };
    },
  );
};
```

Modify `services/meeting-api/src/deps.ts`:

```ts
import type { CodeRng } from "@zoomclone/protocol";
import { MeetingsRepo } from "./meetings/repo";
import { MeetingsService } from "./meetings/service";
import { RedisRoomControl, type RoomControl } from "./room-control";
// Infra gains:
  codeRng?: CodeRng;
// AppDeps gains:
  roomControl: RoomControl;
  meetingsRepo: MeetingsRepo;
  meetings: MeetingsService;
// createDeps body becomes:
  const roomControl = new RedisRoomControl(infra.redis);
  const meetingsRepo = new MeetingsRepo(infra.db);
  const meetings = new MeetingsService({
    db: infra.db,
    repo: meetingsRepo,
    roomControl,
    region: env.DEFAULT_REGION,
    codeRng: infra.codeRng,
  });
  return { ...existing fields..., roomControl, meetingsRepo, meetings };
```

Modify `services/meeting-api/src/app.ts`: after the auth registrations add

```ts
  await app.register(meetingRoutes, { prefix: "/v1" });
```

with `import { meetingRoutes } from "./meetings/routes";`.

Add to `services/meeting-api/test/helpers.ts`:

```ts
import { randomUUID } from "node:crypto";

/** Simulates what /join does when a meeting goes live: one session row, meeting status live. */
export async function startSession(db: Db, meetingId: string, sfuId = "sfu-local-1"): Promise<string> {
  const sessionId = randomUUID();
  await db`
    INSERT INTO meeting_sessions (id, meeting_id, started_at, home_sfu_id)
    VALUES (${sessionId}, ${meetingId}, now(), ${sfuId})`;
  await db`UPDATE meetings SET status = 'live' WHERE id = ${meetingId}`;
  return sessionId;
}
```

(`createTestContext`'s `infraOverrides` already accepts `codeRng` because its type omits only db, redis, bus and keys from `Infra`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: PASS. If the `:end` route returns 404, check that the route path is written `/meetings/:id::end` and the request URL is `/v1/meetings/<uuid>:end`.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/meeting-api
git commit -F - <<'EOF'
feat(meeting-api): add meetings CRUD and host end endpoint

The end endpoint writes Postgres synchronously through endSession and
then notifies the room controller over Redis, so it works even when no
controller is alive.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 11: `services/meeting-api`: rate limiter, ICE servers, scheduler, room state reader

**Files:**
- Create: `services/meeting-api/src/rate-limit.ts`, `services/meeting-api/src/ice-servers.ts`, `services/meeting-api/src/scheduler.ts`, `services/meeting-api/src/room-state.ts`
- Test: `services/meeting-api/src/rate-limit.test.ts`, `services/meeting-api/src/ice-servers.test.ts`, `services/meeting-api/src/room-state.test.ts`

**Interfaces:**
- Produces: `interface RateLimiter { hit(key, now?): { allowed; retryAfterSeconds } }`, `SlidingWindowLimiter(limit, windowMs)` with `sweep(now?)`; `buildIceServers(cfg, participantId, now): IceServer[]` (coturn `use-auth-secret` credentials: username `<expiry>:<participantId>`, credential `base64(HMAC-SHA1(secret, username))`); `interface Scheduler { place(req): Promise<Placement> }`, `Placement = { region; sfuId }`, `StaticScheduler({ region, sfuId })`; `RoomStateReader(redis).read(sessionId): Promise<RoomState | null>` with `RoomState = { status; endReason; locked; rosterSize }` read from spec 4.2 keys `{room:<sid>}:meta` (fields `status`, `end_reason`, `locked`) and `{room:<sid>}:roster` (HLEN).

- [ ] **Step 1: Write the failing tests**

`services/meeting-api/src/rate-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows `limit` hits per window then blocks with a retry-after", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.hit("ip", t0).allowed).toBe(true);
    expect(limiter.hit("ip", t0 + 1000).allowed).toBe(true);
    expect(limiter.hit("ip", t0 + 2000).allowed).toBe(true);
    const blocked = limiter.hit("ip", t0 + 3000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(57);
  });

  it("slides: old hits expire", () => {
    const limiter = new SlidingWindowLimiter(2, 10_000);
    limiter.hit("k", 0);
    limiter.hit("k", 1000);
    expect(limiter.hit("k", 5000).allowed).toBe(false);
    expect(limiter.hit("k", 10_001).allowed).toBe(true);
  });

  it("keys are independent and sweep drops idle keys", () => {
    const limiter = new SlidingWindowLimiter(1, 10_000);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("b", 0).allowed).toBe(true);
    expect(limiter.hit("a", 1).allowed).toBe(false);
    limiter.sweep(20_000);
    expect(limiter.hit("a", 20_001).allowed).toBe(true);
  });
});
```

`services/meeting-api/src/ice-servers.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildIceServers } from "./ice-servers";

const pid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12";
const now = new Date("2026-09-10T09:00:00Z");

describe("buildIceServers", () => {
  it("returns STUN only when TURN is not configured", () => {
    const servers = buildIceServers(
      { stunUrls: ["stun:s:3478"], turnUrls: [], turnTtlSeconds: 3600 },
      pid,
      now,
    );
    expect(servers).toEqual([{ urls: ["stun:s:3478"] }]);
  });

  it("adds time-limited TURN credentials in coturn use-auth-secret format", () => {
    const servers = buildIceServers(
      {
        stunUrls: [],
        turnUrls: ["turn:t:443?transport=tcp"],
        turnSecret: "s3cret",
        turnTtlSeconds: 3600,
      },
      pid,
      now,
    );
    const expiry = Math.floor(now.getTime() / 1000) + 3600;
    const username = `${expiry}:${pid}`;
    const credential = createHmac("sha1", "s3cret").update(username).digest("base64");
    expect(servers).toEqual([{ urls: ["turn:t:443?transport=tcp"], username, credential }]);
  });

  it("skips TURN when the secret is missing", () => {
    expect(
      buildIceServers({ stunUrls: [], turnUrls: ["turn:t:443"], turnTtlSeconds: 60 }, pid, now),
    ).toEqual([]);
  });
});
```

`services/meeting-api/src/room-state.test.ts`:

```ts
import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testRedisUrl } from "../test/helpers";
import { RoomStateReader } from "./room-state";

const sid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11";
let redis: Redis;

beforeAll(() => {
  redis = new Redis(testRedisUrl());
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe("RoomStateReader", () => {
  it("returns null when the room has no checkpoint", async () => {
    expect(await new RoomStateReader(redis).read(sid)).toBeNull();
  });

  it("reads status, end reason, lock and roster size from the spec 4.2 keys", async () => {
    await redis.hset(`{room:${sid}}:meta`, {
      status: "live",
      locked: "true",
      home_sfu: "sfu-local-1",
    });
    await redis.hset(`{room:${sid}}:roster`, { p1: "{}", p2: "{}" });
    expect(await new RoomStateReader(redis).read(sid)).toEqual({
      status: "live",
      endReason: null,
      locked: true,
      rosterSize: 2,
    });
    await redis.hset(`{room:${sid}}:meta`, { status: "ended", end_reason: "host_end", locked: "false" });
    expect(await new RoomStateReader(redis).read(sid)).toMatchObject({
      status: "ended",
      endReason: "host_end",
      locked: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: FAIL, unresolved imports.

- [ ] **Step 3: Implement**

`services/meeting-api/src/rate-limit.ts`:

```ts
export type RateDecision = { allowed: boolean; retryAfterSeconds: number };

export interface RateLimiter {
  hit(key: string, now?: number): RateDecision;
}

/** In-memory sliding window per key. Spec 8: 10/min per IP and per code on /join. */
export class SlidingWindowLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number = Date.now()): RateDecision {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops keys without hits inside the window; call on an interval to bound memory. */
  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > cutoff)) this.hits.delete(key);
    }
  }
}
```

`services/meeting-api/src/ice-servers.ts`:

```ts
import { createHmac } from "node:crypto";
import type { IceServer } from "@zoomclone/protocol";

export type IceConfig = {
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnTtlSeconds: number;
};

/**
 * Spec 6.1: TURN credentials are pre-issued in /join so the client gathers relay candidates in
 * parallel with signaling. Credentials follow coturn's use-auth-secret (TURN REST API) scheme.
 */
export function buildIceServers(cfg: IceConfig, participantId: string, now: Date): IceServer[] {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length > 0) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length > 0 && cfg.turnSecret) {
    const expiry = Math.floor(now.getTime() / 1000) + cfg.turnTtlSeconds;
    const username = `${expiry}:${participantId}`;
    const credential = createHmac("sha1", cfg.turnSecret).update(username).digest("base64");
    servers.push({ urls: cfg.turnUrls, username, credential });
  }
  return servers;
}
```

`services/meeting-api/src/scheduler.ts`:

```ts
export type Placement = { region: string; sfuId: string };
export type PlacementRequest = { meetingId: string; region: string; expectedSize: number };

/** Spec 3.1 Scheduler: picks region + SFU for a new session. */
export interface Scheduler {
  place(request: PlacementRequest): Promise<Placement>;
}

/** Single-region, single-SFU placement from config. Slice D replaces this with the registry. */
export class StaticScheduler implements Scheduler {
  constructor(private readonly cfg: Placement) {}

  async place(): Promise<Placement> {
    return { region: this.cfg.region, sfuId: this.cfg.sfuId };
  }
}
```

`services/meeting-api/src/room-state.ts`:

```ts
import type Redis from "ioredis";

export type RoomState = {
  status: string | null;
  endReason: string | null;
  locked: boolean;
  rosterSize: number;
};

/** Read-only view of the room controller's Redis checkpoint (spec 4.2 key layout). */
export class RoomStateReader {
  constructor(private readonly redis: Redis) {}

  async read(sessionId: string): Promise<RoomState | null> {
    const prefix = `{room:${sessionId}}`;
    const meta = await this.redis.hgetall(`${prefix}:meta`);
    if (Object.keys(meta).length === 0) return null;
    const rosterSize = await this.redis.hlen(`${prefix}:roster`);
    return {
      status: meta["status"] ?? null,
      endReason: meta["end_reason"] ?? null,
      locked: meta["locked"] === "true",
      rosterSize,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/meeting-api
git commit -F - <<'EOF'
feat(meeting-api): add rate limiter, ICE servers, scheduler and room state reader

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 12: `services/meeting-api`: `POST /v1/join`

**Files:**
- Create: `services/meeting-api/src/join/service.ts`, `services/meeting-api/src/join/routes.ts`
- Modify: `services/meeting-api/src/deps.ts`, `services/meeting-api/src/app.ts`, `services/meeting-api/test/helpers.ts`
- Test: `services/meeting-api/src/join/join.test.ts`

**Interfaces:**
- Produces: `JoinService.join(input: JoinRequest, user: AuthUser | null): Promise<JoinResponse>`, `joinRoutes` (registered under `/v1`). `AppDeps` gains `scheduler`, `roomState`, `limiters: { ip: RateLimiter; code: RateLimiter }`, `join: JoinService`.
- Behaviour (design doc, REST section): rate limit per IP and per code -> 429 `RATE_LIMITED` with `retry-after`; unknown or malformed code -> 404 `MEETING_NOT_FOUND`; ended or cancelled -> 410 `ENDED`; organizer -> `host`, else `attendee`; get-or-create live session in one transaction (`ON CONFLICT ... WHERE ended_at IS NULL DO NOTHING` on the partial index); Redis meta `status=ended` -> finish the end in Postgres and start a new session (or 410 when the reason was terminal); `locked` and not host -> 403 `LOCKED`; roster full -> 429 `CAPACITY`; `lobby` = settings.lobby and not host and not org member; ES256 token with the `SignalingClaims`; `signaling_url = <SIGNALING_PUBLIC_URL>/rooms/<session_id>`.

- [ ] **Step 1: Write the failing test**

`services/meeting-api/src/join/join.test.ts`:

```ts
import { createHmac } from "node:crypto";
import {
  JoinResponseSchema,
  MeetingResponseSchema,
  type JoinResponse,
  type MeetingResponse,
} from "@zoomclone/protocol";
import { verifySignalingToken } from "@zoomclone/tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, createTestContext, mintUser, type TestContext } from "../../test/helpers";

let ctx: TestContext;
let host: { token: string; sub: string; orgId: string };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  host = await mintUser(ctx, { name: "Host" });
});

async function createMeeting(settings: Record<string, unknown> = {}): Promise<MeetingResponse> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/v1/meetings",
    headers: bearer(host.token),
    payload: { settings },
  });
  expect(res.statusCode, res.body).toBe(201);
  return MeetingResponseSchema.parse(res.json());
}

function join(
  code: string,
  opts: { token?: string; name?: string; remoteAddress?: string; app?: TestContext["app"] } = {},
) {
  return (opts.app ?? ctx.app).inject({
    method: "POST",
    url: "/v1/join",
    headers: opts.token ? bearer(opts.token) : {},
    remoteAddress: opts.remoteAddress,
    payload: { code, display_name: opts.name ?? "Guest" },
  });
}

async function grant(code: string, opts: Parameters<typeof join>[1] = {}): Promise<JoinResponse> {
  const res = await join(code, opts);
  expect(res.statusCode, res.body).toBe(200);
  return JoinResponseSchema.parse(res.json());
}

describe("POST /v1/join", () => {
  it("returns 404 for unknown and malformed codes", async () => {
    for (const code of ["zzz-zzzz-zzz", "nope", ""]) {
      const res = await join(code);
      expect(res.statusCode, code).toBe(code === "" ? 400 : 404);
      if (code !== "") expect(res.json().error.code).toBe("MEETING_NOT_FOUND");
    }
  });

  it("guest join starts the session and returns an attendee grant behind the lobby", async () => {
    const m = await createMeeting();
    const g = await grant(m.code.toUpperCase(), { name: "Ana" });
    expect(g.role).toBe("attendee");
    expect(g.lobby).toBe(true);
    expect(g.region).toBe(m.region);
    expect(g.signaling_url).toBe(`${ctx.env.SIGNALING_PUBLIC_URL}/rooms/${g.session_id}`);

    const claims = await verifySignalingToken(
      g.signaling_token,
      ctx.deps.keys.publicKey,
      ctx.env.TOKEN_ISSUER,
    );
    expect(claims).toMatchObject({
      session_id: g.session_id,
      participant_id: g.participant_id,
      role: "attendee",
      sfu_hint: ctx.env.SFU_ID,
      display_name: "Ana",
      lobby_enabled: true,
      max_participants: 500,
    });
    expect(claims.exp - claims.iat).toBe(300);

    const [session] = await ctx.db`SELECT * FROM meeting_sessions WHERE id = ${g.session_id}`;
    expect(session?.homeSfuId).toBe(ctx.env.SFU_ID);
    const [meeting] = await ctx.db`SELECT status FROM meetings WHERE id = ${m.id}`;
    expect(meeting?.status).toBe("live");
  });

  it("issues STUN plus time-limited TURN credentials", async () => {
    const m = await createMeeting();
    const g = await grant(m.code);
    expect(g.ice_servers[0]).toEqual({ urls: ["stun:stun.example.com:3478"] });
    const turn = g.ice_servers[1]!;
    expect(turn.urls).toEqual(["turn:turn.example.com:443?transport=tcp"]);
    expect(turn.username).toMatch(new RegExp(`^\\d+:${g.participant_id}$`));
    expect(turn.credential).toBe(
      createHmac("sha1", "turn-secret").update(turn.username!).digest("base64"),
    );
  });

  it("organizer joins as host without lobby and shares the guests' session", async () => {
    const m = await createMeeting();
    const guest = await grant(m.code);
    const h = await grant(m.code, { token: host.token });
    expect(h.role).toBe("host");
    expect(h.lobby).toBe(false);
    expect(h.session_id).toBe(guest.session_id);
    expect(h.participant_id).not.toBe(guest.participant_id);
  });

  it("org members skip the lobby; lobby off skips it for guests", async () => {
    const m = await createMeeting();
    const colleague = await mintUser(ctx, { org_id: host.orgId });
    expect((await grant(m.code, { token: colleague.token })).lobby).toBe(false);
    const stranger = await mintUser(ctx, { org_id: "22222222-2222-4222-8222-222222222222" });
    expect((await grant(m.code, { token: stranger.token })).lobby).toBe(true);
    const open = await createMeeting({ lobby: false });
    expect((await grant(open.code)).lobby).toBe(false);
  });

  it("50 concurrent joins on a fresh meeting create exactly one session", async () => {
    const m = await createMeeting();
    const results = await Promise.all(Array.from({ length: 50 }, () => join(m.code)));
    const sessions = new Set(
      results.map((r) => {
        expect(r.statusCode, r.body).toBe(200);
        return r.json().session_id as string;
      }),
    );
    expect(sessions.size).toBe(1);
    const rows = await ctx.db`SELECT count(*)::int AS n FROM meeting_sessions WHERE meeting_id = ${m.id}`;
    expect(rows[0]?.n).toBe(1);
  });

  it("returns 410 for ended and cancelled meetings", async () => {
    const m = await createMeeting();
    await grant(m.code);
    const end = await ctx.app.inject({
      method: "POST",
      url: `/v1/meetings/${m.id}:end`,
      headers: bearer(host.token),
    });
    expect(end.statusCode).toBe(200);
    const after = await join(m.code);
    expect(after.statusCode).toBe(410);
    expect(after.json().error.code).toBe("ENDED");

    const c = await createMeeting();
    await ctx.app.inject({ method: "DELETE", url: `/v1/meetings/${c.id}`, headers: bearer(host.token) });
    expect((await join(c.code)).statusCode).toBe(410);
  });

  it("honours the controller's lock and capacity from Redis", async () => {
    const m = await createMeeting({ max_participants: 2 });
    const first = await grant(m.code);
    const meta = `{room:${first.session_id}}:meta`;
    await ctx.redis.hset(meta, { status: "live", locked: "true" });
    const locked = await join(m.code);
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.code).toBe("LOCKED");
    expect((await join(m.code, { token: host.token })).statusCode).toBe(200);

    await ctx.redis.hset(meta, { locked: "false" });
    await ctx.redis.hset(`{room:${first.session_id}}:roster`, { a: "{}", b: "{}" });
    const full = await join(m.code);
    expect(full.statusCode).toBe(429);
    expect(full.json().error.code).toBe("CAPACITY");
  });

  it("starts a new session when Redis says the old one ended idle, 410 when it ended by the host", async () => {
    const m = await createMeeting();
    const a = await grant(m.code);
    await ctx.redis.hset(`{room:${a.session_id}}:meta`, { status: "ended", end_reason: "idle" });
    const b = await grant(m.code);
    expect(b.session_id).not.toBe(a.session_id);
    const [old] = await ctx.db`SELECT ended_at FROM meeting_sessions WHERE id = ${a.session_id}`;
    expect(old?.endedAt).toBeInstanceOf(Date);

    await ctx.redis.hset(`{room:${b.session_id}}:meta`, { status: "ended", end_reason: "host_end" });
    const gone = await join(m.code);
    expect(gone.statusCode).toBe(410);
    const [meeting] = await ctx.db`SELECT status FROM meetings WHERE id = ${m.id}`;
    expect(meeting?.status).toBe("ended");
  });

  it("rejects invalid bearers", async () => {
    const m = await createMeeting();
    expect((await join(m.code, { token: "bad.token.value" })).statusCode).toBe(401);
  });

  it("rate limits per IP and per code with retry-after, and counts errors", async () => {
    const limited = await createTestContext({ JOIN_RATE_LIMIT: "3" });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await join("zzz-zzzz-zzz", { app: limited.app })).statusCode).toBe(404);
      }
      const blocked = await join("zzz-zzzz-zzz", { app: limited.app });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

      for (let i = 0; i < 3; i++) {
        const res = await join("yyy-yyyy-yyy", { app: limited.app, remoteAddress: `10.0.0.${i + 1}` });
        expect(res.statusCode).toBe(404);
      }
      const byCode = await join("yyy-yyyy-yyy", { app: limited.app, remoteAddress: "10.0.0.9" });
      expect(byCode.statusCode).toBe(429);

      const metrics = await limited.app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toMatch(/join_errors_total\{code="RATE_LIMITED"\} 2/);
      expect(metrics.body).toMatch(/join_errors_total\{code="MEETING_NOT_FOUND"\} 6/);
    } finally {
      await limited.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: FAIL, `/v1/join` returns 404 (route missing) and `join` module unresolved.

- [ ] **Step 3: Implement**

`services/meeting-api/src/join/service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { endSession, isEndReason, type Db, type MeetingRow, type SessionRow } from "@zoomclone/db";
import {
  ApiError,
  normalizeMeetingCode,
  type JoinRequest,
  type JoinResponse,
  type Role,
} from "@zoomclone/protocol";
import { signSignalingToken, type SigningKeys } from "@zoomclone/tokens";
import type { AuthUser } from "../auth/user-verifier";
import type { Env } from "../env";
import { buildIceServers } from "../ice-servers";
import type { MeetingsRepo } from "../meetings/repo";
import type { RoomStateReader } from "../room-state";
import type { Scheduler } from "../scheduler";

export type JoinDeps = {
  db: Db;
  repo: MeetingsRepo;
  scheduler: Scheduler;
  roomState: RoomStateReader;
  keys: SigningKeys;
  env: Env;
  clock: () => Date;
};

/** Spec 5.1 POST /join, the critical path: lookup, org policy, session, token. */
export class JoinService {
  constructor(private readonly deps: JoinDeps) {}

  async join(input: JoinRequest, user: AuthUser | null): Promise<JoinResponse> {
    const { repo, env } = this.deps;
    const code = normalizeMeetingCode(input.code);
    if (!code) throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    let meeting = await repo.byCode(code);
    if (!meeting) throw new ApiError("MEETING_NOT_FOUND", "meeting not found");
    assertJoinable(meeting);
    const role: Role = user !== null && user.id === meeting.organizerId ? "host" : "attendee";

    let { session, created } = await this.getOrCreateLiveSession(meeting);
    if (!created) {
      const state = await this.deps.roomState.read(session.id);
      if (state?.status === "ended") {
        // The controller ended the room; Postgres may still be catching up. Finish it here.
        await endSession(this.deps.db, {
          sessionId: session.id,
          reason: isEndReason(state.endReason) ? state.endReason : "idle",
        });
        meeting = (await repo.byId(meeting.id)) ?? meeting;
        assertJoinable(meeting);
        ({ session, created } = await this.getOrCreateLiveSession(meeting));
      } else if (state) {
        if (state.locked && role !== "host") throw new ApiError("LOCKED", "meeting is locked");
        if (state.rosterSize >= meeting.settings.max_participants) {
          throw new ApiError("CAPACITY", "meeting is full");
        }
      }
    }

    const participantId = randomUUID();
    const orgMember = user !== null && user.orgId === meeting.orgId;
    const lobby = meeting.settings.lobby && role !== "host" && !orgMember;
    const now = this.deps.clock();
    const token = await signSignalingToken(
      this.deps.keys,
      env.TOKEN_ISSUER,
      {
        session_id: session.id,
        participant_id: participantId,
        role,
        sfu_hint: session.homeSfuId ?? env.SFU_ID,
        display_name: input.display_name,
        lobby_enabled: meeting.settings.lobby,
        max_participants: meeting.settings.max_participants,
      },
      now,
    );
    return {
      session_id: session.id,
      participant_id: participantId,
      role,
      lobby,
      signaling_url: `${env.SIGNALING_PUBLIC_URL}/rooms/${session.id}`,
      signaling_token: token,
      ice_servers: buildIceServers(
        {
          stunUrls: env.STUN_URLS,
          turnUrls: env.TURN_URLS,
          turnSecret: env.TURN_SECRET,
          turnTtlSeconds: env.TURN_TTL_SECONDS,
        },
        participantId,
        now,
      ),
      region: meeting.region,
    };
  }

  /**
   * One transaction. The partial unique index (meeting_id WHERE ended_at IS NULL) makes the
   * insert race-safe: a losing writer gets no row back and re-reads the winner's session.
   */
  private async getOrCreateLiveSession(
    meeting: MeetingRow,
  ): Promise<{ session: SessionRow; created: boolean }> {
    return this.deps.db.begin(async (tx) => {
      const [existing] = await tx<SessionRow[]>`
        SELECT * FROM meeting_sessions WHERE meeting_id = ${meeting.id} AND ended_at IS NULL`;
      if (existing) return { session: existing, created: false };
      const placement = await this.deps.scheduler.place({
        meetingId: meeting.id,
        region: meeting.region,
        expectedSize: meeting.settings.max_participants,
      });
      const [inserted] = await tx<SessionRow[]>`
        INSERT INTO meeting_sessions (id, meeting_id, started_at, home_sfu_id)
        VALUES (${randomUUID()}, ${meeting.id}, now(), ${placement.sfuId})
        ON CONFLICT (meeting_id) WHERE ended_at IS NULL DO NOTHING
        RETURNING *`;
      if (inserted) {
        await tx`UPDATE meetings SET status = 'live' WHERE id = ${meeting.id} AND status = 'scheduled'`;
        return { session: inserted, created: true };
      }
      const [raced] = await tx<SessionRow[]>`
        SELECT * FROM meeting_sessions WHERE meeting_id = ${meeting.id} AND ended_at IS NULL`;
      if (!raced) throw new Error("live session disappeared during join");
      return { session: raced, created: false };
    });
  }
}

function assertJoinable(meeting: MeetingRow): void {
  if (meeting.status === "ended" || meeting.status === "cancelled") {
    throw new ApiError("ENDED", "meeting has ended");
  }
}
```

`services/meeting-api/src/join/routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  JoinRequestSchema,
  JoinResponseSchema,
  normalizeMeetingCode,
} from "@zoomclone/protocol";

/** Spec 5.1 POST /join. Registered with prefix /v1. Bearer is optional (guests). */
export const joinRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { join, limiters, metrics, clock } = app.deps;

  r.post(
    "/join",
    { schema: { body: JoinRequestSchema, response: { 200: JoinResponseSchema } } },
    async (req) => {
      const started = process.hrtime.bigint();
      try {
        const now = clock().getTime();
        const byIp = limiters.ip.hit(req.ip, now);
        if (!byIp.allowed) {
          throw new ApiError("RATE_LIMITED", "too many join attempts", byIp.retryAfterSeconds);
        }
        const codeKey = normalizeMeetingCode(req.body.code) ?? req.body.code.trim().toLowerCase();
        const byCode = limiters.code.hit(codeKey, now);
        if (!byCode.allowed) {
          throw new ApiError(
            "RATE_LIMITED",
            "too many join attempts for this code",
            byCode.retryAfterSeconds,
          );
        }
        const grant = await join.join(req.body, req.user);
        metrics.joinLatency.observe(Number(process.hrtime.bigint() - started) / 1e9);
        return grant;
      } catch (err) {
        if (err instanceof ApiError) metrics.joinErrors.inc({ code: err.code });
        throw err;
      }
    },
  );
};
```

Modify `services/meeting-api/src/deps.ts`:

```ts
import { JoinService } from "./join/service";
import { SlidingWindowLimiter, type RateLimiter } from "./rate-limit";
import { RoomStateReader } from "./room-state";
import { StaticScheduler, type Scheduler } from "./scheduler";
// AppDeps gains:
  scheduler: Scheduler;
  roomState: RoomStateReader;
  limiters: { ip: RateLimiter; code: RateLimiter };
  join: JoinService;
// createDeps body gains (before the return):
  const scheduler = new StaticScheduler({ region: env.DEFAULT_REGION, sfuId: env.SFU_ID });
  const roomState = new RoomStateReader(infra.redis);
  const clock = infra.clock ?? (() => new Date());
  const limiters = {
    ip: new SlidingWindowLimiter(env.JOIN_RATE_LIMIT, env.JOIN_RATE_WINDOW_MS),
    code: new SlidingWindowLimiter(env.JOIN_RATE_LIMIT, env.JOIN_RATE_WINDOW_MS),
  };
  const join = new JoinService({
    db: infra.db,
    repo: meetingsRepo,
    scheduler,
    roomState,
    keys: infra.keys,
    env,
    clock,
  });
// and the returned object includes: scheduler, roomState, limiters, join (and uses the same clock).
```

Modify `services/meeting-api/src/app.ts`: after the meeting routes add

```ts
  await app.register(joinRoutes, { prefix: "/v1" });
```

with `import { joinRoutes } from "./join/routes";`.

`testEnv` already defaults `JOIN_RATE_LIMIT` to `1000` (the join suite makes more than ten calls from 127.0.0.1); the rate-limit test builds its own context with a low limit.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/meeting-api test`
Expected: PASS. If the concurrency test returns 500s, check the `ON CONFLICT (meeting_id) WHERE ended_at IS NULL DO NOTHING` clause matches the index definition exactly.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/meeting-api
git commit -F - <<'EOF'
feat(meeting-api): add POST /join with session get-or-create and grants

Sessions are created inside one transaction on the partial unique
index so join storms yield a single live session per meeting.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 13: `services/meeting-api`: process entrypoint, dev logging, README, smoke test

**Files:**
- Create: `services/meeting-api/src/main.ts`
- Modify: `services/meeting-api/src/app.ts` (pretty logs in development), `README.md`

**Interfaces:**
- Produces: `pnpm --filter @zoomclone/meeting-api dev` (watch) and `start`; root `pnpm dev` runs it. Listens on `MEETING_API_PORT` (8080), host `0.0.0.0`. Graceful shutdown on SIGINT/SIGTERM.

- [ ] **Step 1: Entrypoint**

`services/meeting-api/src/main.ts`:

```ts
import Redis from "ioredis";
import { createDb } from "@zoomclone/db";
import { InMemoryEventBus } from "@zoomclone/events";
import { loadSigningKeys } from "@zoomclone/tokens";
import { buildApp } from "./app";
import { createDeps } from "./deps";
import { loadEnv } from "./env";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL);
const keys = await loadSigningKeys({ pem: env.SIGNING_KEY_PEM, kid: env.SIGNING_KID });
const bus = new InMemoryEventBus((error, event) => {
  console.error(`event handler failed for ${event.type}`, error);
});
const app = await buildApp(createDeps(env, { db, redis, bus, keys }));

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await redis.quit();
  await db.end();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.MEETING_API_PORT, host: "0.0.0.0" });
app.log.info({ devIssuer: env.AUTH_DEV_ISSUER, kid: keys.kid }, "meeting-api listening");
```

- [ ] **Step 2: Pretty logs in development**

In `services/meeting-api/src/app.ts` replace the `logger:` option with:

```ts
    logger:
      deps.env.NODE_ENV === "test"
        ? false
        : deps.env.NODE_ENV === "development"
          ? { level: deps.env.LOG_LEVEL, transport: { target: "pino-pretty" } }
          : { level: deps.env.LOG_LEVEL },
```

- [ ] **Step 3: README API section**

Append to `README.md`:

````markdown
## Meeting API (port 8080)

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/v1/meetings` | bearer |
| GET | `/v1/meetings/{id}` | bearer (same org) |
| PATCH | `/v1/meetings/{id}` | organizer |
| DELETE | `/v1/meetings/{id}` | organizer |
| POST | `/v1/meetings/{id}:end` | organizer |
| POST | `/v1/join` | optional bearer (guests allowed) |
| GET | `/v1/me` | bearer |
| GET | `/.well-known/jwks.json` | none |
| POST | `/dev/oidc/token` | none, only with `AUTH_DEV_ISSUER=true` |

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
````

- [ ] **Step 4: Smoke test**

Run (in one terminal, from the repo root, with `.env` present and infra up):

```sh
pnpm db:migrate
pnpm --filter @zoomclone/meeting-api start
```

In a second terminal run the three README commands. Expected: the final `curl` prints a JSON join grant with `"role":"attendee"`, `"lobby":true`, a `signaling_url` ending in `/rooms/<uuid>`, and a non-empty `signaling_token`. `curl -s localhost:8080/healthz` prints `{"ok":true}`. Stop the server with Ctrl+C; it logs `shutting down` and exits 0.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/meeting-api README.md
git commit -F - <<'EOF'
feat(meeting-api): add process entrypoint and README smoke test

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

## Self-review against the design doc

Spec coverage for the phases this plan owns:

- Phase 0 scaffold: Task 0 (workspace, compose, env, README, design doc committed earlier).
- Phase 1 packages: `protocol` Tasks 1, 2, 3 (WS schemas included now so Plans 3 and 4 code against a fixed contract); `db` Tasks 4, 5 (schema per spec 4.1 + partial index, `endSession` semantics per design doc Data model); `events` Task 6 (envelope, at-least-once, spec 4.4 topic mapping); `tokens` Task 7 (design doc split this out of meeting-api so signaling can verify without importing a service).
- Phase 2 meeting-api: env and skeleton Task 8; OIDC + dev issuer + jwks + `/v1/me` Task 9; meetings CRUD and `:end` with synchronous `endSession` + Redis ctl publish Task 10; limiter / ICE / scheduler / room state Task 11; `/join` flow including the 50-way race, lock, capacity, Redis-ended handling Task 12; entrypoint Task 13.
- Not in this plan (by design): `DOMAIN_RESTRICTED` (slice I), recordings endpoints (slice E), `NO_CAPACITY` (static scheduler never returns it), the signaling side of the Redis ctl channel (Plan 3).

Deviations recorded for the design doc: Drizzle replaced by SQL migrations + postgres.js (Task 0 Step 8); `SignalingClaims` carries `lobby_enabled` and `max_participants`; `DEFAULT_ORG_ID` default is a version-4 shaped UUID because `z.uuid()` rejects `...0001`; the ctl channel is the literal `room:<session_id>:ctl`.

Handoff to Plan 2 (SFU): nothing here depends on the SFU. Plan 3 (signaling) consumes `@zoomclone/protocol` (WS schemas, claims), `@zoomclone/tokens` (`verifySignalingToken` with `createRemoteJWKSet(<meeting-api>/.well-known/jwks.json)`), `@zoomclone/db` (`endSession`, `createDb`), `@zoomclone/events`, the Redis key layout from Task 11, and the `room:<sid>:ctl` message `{ "cmd": "end", "reason": "api_end" }`.
