# Plan and design

## Impact on the existing codebase

Not applicable: there was no existing code, or the analysis has not run yet.

## Task plan

_v1, accepted, hash `8b2271eddda3`, produced by agent:planning_

Build bottom-up so each layer is testable before the next exists: configuration and storage first, then the domain rules, then the link and analytics services, and the HTTP layer last. Tests are written against the specification in parallel with the code, and the documentation is written from the design.

| Task | Lane | Title | Depends on | Requirements | Risk | Files |
| --- | --- | --- | --- | --- | --- | --- |
| T-1 | code | Project skeleton and validated configuration | - | NFR-1, NFR-4 | low | `package.json` `package-lock.json` `tsconfig.json` `vitest.config.ts` `.gitignore` `src/config.ts` |
| T-2 | code | Database access and migrations | T-1 | NFR-2, FR-1, FR-4 | medium | `src/db/database.ts` `src/db/migrator.ts` `migrations/001_init.sql` |
| T-3 | code | Domain rules: codes, aliases, destination URLs, errors | T-1 | FR-1, FR-8 | low | `src/domain/errors.ts` `src/domain/shortCode.ts` `src/domain/urlPolicy.ts` |
| T-4 | code | Link repository and service | T-2, T-3 | FR-1, FR-2, FR-3, NFR-4 | medium | `src/links/linkRepository.ts` `src/links/linkService.ts` |
| T-5 | code | Click recording and statistics | T-2 | FR-4, FR-6, NFR-3 | medium | `src/analytics/clickRecorder.ts` `src/analytics/statsService.ts` |
| T-6 | code | HTTP layer: routes, rate limiter, error rendering, server | T-4, T-5 | FR-1, FR-2, FR-3, FR-4, FR-5, FR-7, FR-8, NFR-3 | medium | `src/http/rateLimiter.ts` `src/http/problem.ts` `src/http/routes.ts` `src/app.ts` `src/server.ts` |
| T-7 | test | Unit tests for the domain rules and components | - | FR-1, FR-5, FR-6, NFR-2 | low | `test/helpers.ts` `test/unit/shortCode.test.ts` `test/unit/urlPolicy.test.ts` `test/unit/rateLimiter.test.ts` `test/unit/migrator.test.ts` `test/unit/clickRecorder.test.ts` |
| T-8 | test | API tests for every acceptance criterion | - | FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8 | low | `test/helpers.ts` `test/integration/links.api.test.ts` `test/integration/stats.api.test.ts` `test/integration/reliability.test.ts` |
| T-9 | docs | README and OpenAPI contract | - | FR-1, FR-2, FR-3, FR-4, FR-7, NFR-1 | low | `README.md` `openapi.yaml` |

## Design

_v1, accepted, hash `fa7e1e9ce7c0`, produced by agent:architecture_

A single Node.js process in three layers. The HTTP layer (Fastify) parses and validates requests and renders responses and errors. The service layer holds the rules: creating and resolving links, recording clicks, computing statistics. The data layer owns SQLite and is the only place that contains SQL. Dependencies point inwards only, and everything a layer needs is passed to it, so the whole application can be assembled in a test with an in-memory database, a fake clock and a scripted code generator.

The redirect is the hot path: one primary-key lookup, one in-memory push, one response. Click analytics are decoupled from it by a bounded in-memory queue that a timer writes in batches.

| Component | Responsibility | Files |
| --- | --- | --- |
| Configuration | Read environment variables once, validate them, and fail startup on a bad value. | `src/config.ts` |
| Database and migrator | Open SQLite, run work in transactions, and apply numbered migrations exactly once with a stored checksum. | `src/db/database.ts` `src/db/migrator.ts` `migrations/001_init.sql` |
| Domain rules | Code generation, alias rules, destination URL rules, and the application error type. | `src/domain/shortCode.ts` `src/domain/urlPolicy.ts` `src/domain/errors.ts` |
| Links | Store and look up links; create with collision-safe code allocation. | `src/links/linkRepository.ts` `src/links/linkService.ts` |
| Analytics | Buffer click events and write them in batches; answer statistics queries. | `src/analytics/clickRecorder.ts` `src/analytics/statsService.ts` |
| HTTP | Routes, request validation, rate limiting, problem-document errors, process lifecycle. | `src/http/routes.ts` `src/http/rateLimiter.ts` `src/http/problem.ts` `src/app.ts` `src/server.ts` |

### API changes

- `POST /api/v1/links`: New. Creates a link; 201, 400, 409, 429, 503.
- `GET /api/v1/links/{code}`: New. Returns a link; 200, 404, 429.
- `GET /api/v1/links/{code}/stats`: New. Returns click analytics; 200, 404, 429.
- `GET /{code}`: New. Redirects with 302 and no-store; 404.
- `GET /healthz`: New. Liveness.
- `GET /readyz`: New. Readiness; 200 or 503.

### Data model changes

- New table links(code primary key, target_url, created_at, click_count).
- New table click_events(id, code references links, clicked_at, referrer_host) with an index on (code, clicked_at).
- New table schema_migrations(version, checksum, applied_at), owned by the migrator.

### Change envelope (what the approver signed off)

| Aspect | Declared |
| --- | --- |
| Schema change | yes |
| API change | additive |
| Dependencies added or changed | fastify, zod, typescript, vitest, @types/node |
| Touches personal data | no |

### Decisions

**ADR-1 Embedded SQLite through Node's built-in driver.** Store data in SQLite using node:sqlite, with all SQL confined to repository and analytics classes.

Why: The requirement is a single command and no external services. The built-in driver needs no native build step, so installation cannot fail on a compiler or a blocked binary download. Confining SQL to two classes keeps a later move to a networked database local to them.

Rejected:
- PostgreSQL: the right choice for several instances, but it is an external service
- better-sqlite3: mature, but a native module that must be compiled or downloaded at install time
- In-memory map: no durability

**ADR-2 Random codes, uniqueness enforced by the primary key.** Generate 7 random base62 characters from a cryptographic source, insert, and retry with a new code if the insert reports a clash, up to 5 times.

Why: Random codes cannot be enumerated or guessed in sequence. Letting the primary key decide uniqueness removes the read-then-write race of checking first.

Rejected:
- Sequential counter encoded in base62: short, but every link is discoverable by counting
- Hash of the URL: two callers shortening the same URL would share a code and its statistics

**ADR-3 302 with no-store for redirects.** Redirect with 302 and Cache-Control: no-store.

Why: Click analytics is a requirement. A cached 301 means repeat visits never reach the service, and a link could never be changed or withdrawn later.

Rejected:
- 301: one request fewer for repeat visitors, at the cost of analytics and control

**ADR-4 Click recording is asynchronous and best-effort.** A redirect pushes a click onto a bounded in-memory queue. A timer writes the queue in one transaction together with the per-link totals. When the queue is full, clicks are dropped and counted.

Why: The requirement states that recording a click must never slow down or fail a redirect. A bounded queue keeps memory fixed under load, and one transaction per batch keeps the event rows and the totals consistent.

Rejected:
- Write synchronously in the redirect: exact counts, but a slow or locked database would slow or fail redirects
- External message queue: durable, but an external service

**ADR-5 Per-client token bucket on the management API only.** Rate limit /api/* per client address with an in-process token bucket whose key count is bounded. Redirects are not limited.

Why: Link creation is the write an attacker can abuse; redirects are the product and are a single indexed read. The key bound stops a flood of distinct addresses from exhausting memory.

Rejected:
- Shared limiter in Redis: needed for several instances, but an external service
- Limit redirects too: would throttle legitimate traffic to a popular link

**ADR-6 Store the referrer's host only, and no client address.** Reduce the Referer header to its host before it is queued. Do not store or log the client address.

Why: A full referrer URL can carry personal data in its path or query. Host-level data answers the stated question (top referrers) without holding personal data.

Rejected:
- Store the full referrer URL: more detail than was asked for, with a privacy cost

**ADR-7 Errors as RFC 9457 problem documents.** Every error response is application/problem+json with a stable machine-readable code. Unexpected errors are logged in full and returned as a generic 500.

Why: Clients get one error shape to handle, and internal detail never leaves the process.

Rejected:
- Ad-hoc JSON error bodies per route

**ADR-8 Run the TypeScript sources directly.** Use Node's built-in type stripping; type-check with tsc --noEmit as a separate step.

Why: No build output to keep in sync and a single start command. The cost is a minimum Node version of 22.18 and a restriction to erasable TypeScript syntax, which the compiler enforces.

Rejected:
- Compile to dist/ with tsc: works on older Node versions, adds a build step
- tsx or ts-node: an extra runtime dependency

### Risks

| Id | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | The API has no authentication, so anyone who can reach it can create links and read statistics. | high | medium | Rate limiting on the management API, and deployment behind a trusted gateway. Authentication is listed as out of scope and as a known limitation. |
| R-2 | Clicks still in the queue when the process stops are lost. | medium | low | Accepted for this version under the best-effort assumption A-2 and documented as a limitation. Flushing on shutdown is the follow-up. |
| R-3 | A shortener is an open redirector and can be used to disguise malicious destinations. | medium | medium | Only http and https, no embedded credentials, no self-reference. Destination reputation checks are out of scope and recorded as a follow-up. |
| R-4 | SQLite and in-process limiter state do not support more than one instance. | low | medium | Recorded as assumption A-1. SQL is confined to the data layer so the store can be replaced. |
| R-5 | node:sqlite is still marked experimental and its API may change. | low | low | Pinned minimum Node version, a lock file, and the driver hidden behind the data layer. |
| R-6 | click_events grows without bound. | medium | low | Daily statistics read only a 30-day window through an index. A retention job is a follow-up. |

### How each requirement is met

- **FR-1**: LinkService.create validates the URL and alias with the domain rules and allocates a code by insert-and-retry on the primary key.
- **FR-2**: GET /{code} looks the link up by primary key and replies 302 with no-store.
- **FR-3**: GET /api/v1/links/{code} returns the stored link.
- **FR-4**: ClickRecorder writes events and totals; StatsService reads the total, a 30-day per-day breakdown and the top 10 referrer hosts.
- **FR-5**: An onRequest hook applies a per-client token bucket to /api/* and raises 429 with Retry-After.
- **FR-6**: The redirect only pushes to a bounded queue; batches are written by a timer in one transaction.
- **FR-7**: /healthz always answers; /readyz runs a trivial query and answers 503 if it fails.
- **FR-8**: One error handler renders AppError and framework 4xx errors as problem documents and everything else as a generic 500.
