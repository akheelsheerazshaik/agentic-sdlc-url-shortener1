# Decisions, lineage and timeline

## Decisions made by agents

| Stage | Gen | Decision | Rationale | Alternatives considered |
| --- | --- | --- | --- | --- |
| requirements | 1 | "top referrers": Top 10 by host; only the host is ever stored. | Default assumption. A full referrer URL can contain personal data in its path or query, so storing it changes the privacy position of the service. | Top 10 by host; Top N by full URL; All referrers |
| requirements | 1 | "clicks per day": UTC days over the last 30 days; the total covers all time. | Default assumption. It decides how clicks near midnight are attributed and how much data each stats request scans. | UTC days, last 30 days; Caller-supplied time zone; Full history |
| requirements | 1 | "Limit how fast one client can create links": Per client address with a token bucket, burst 20 and 1 request per second, both configurable. | Default assumption. The API has no authentication, so the only available identity is the network address, and the limits decide what a legitimate bulk user can do. | Per client address, burst 20 then 1 per second, configurable; Per API key; One global limit |
| requirements | 1 | "redirects to the original URL": 302 with Cache-Control: no-store, because analytics is a stated requirement. | Default assumption. Browsers cache a 301, so later visits never reach the service: clicks go uncounted and a link can never be changed or withdrawn. | 302 with no-store; 301 |
| requirements | 1 | "The caller": No authentication in this version. It is recorded as a risk and a limitation, and the API is rate limited. | Default assumption. Without authentication anyone who can reach the API can create links and read any link's stats. | No authentication in this version; deploy behind a trusted gateway; API keys; Per-user accounts |
| planning | 1 | Deliver in 9 tasks | Build bottom-up so each layer is testable before the next exists: configuration and storage first, then the domain rules, then the link and analytics services, and the HTTP layer last. Tests are written against the specification in parallel with the code, and the documentation is written from the design. | - |
| architecture | 1 | ADR-1 Embedded SQLite through Node's built-in driver: Store data in SQLite using node:sqlite, with all SQL confined to repository and analytics classes. | The requirement is a single command and no external services. The built-in driver needs no native build step, so installation cannot fail on a compiler or a blocked binary download. Confining SQL to two classes keeps a later move to a networked database local to them. | PostgreSQL: the right choice for several instances, but it is an external service; better-sqlite3: mature, but a native module that must be compiled or downloaded at install time; In-memory map: no durability |
| architecture | 1 | ADR-2 Random codes, uniqueness enforced by the primary key: Generate 7 random base62 characters from a cryptographic source, insert, and retry with a new code if the insert reports a clash, up to 5 times. | Random codes cannot be enumerated or guessed in sequence. Letting the primary key decide uniqueness removes the read-then-write race of checking first. | Sequential counter encoded in base62: short, but every link is discoverable by counting; Hash of the URL: two callers shortening the same URL would share a code and its statistics |
| architecture | 1 | ADR-3 302 with no-store for redirects: Redirect with 302 and Cache-Control: no-store. | Click analytics is a requirement. A cached 301 means repeat visits never reach the service, and a link could never be changed or withdrawn later. | 301: one request fewer for repeat visitors, at the cost of analytics and control |
| architecture | 1 | ADR-4 Click recording is asynchronous and best-effort: A redirect pushes a click onto a bounded in-memory queue. A timer writes the queue in one transaction together with the per-link totals. When the queue is full, clicks are dropped and counted. | The requirement states that recording a click must never slow down or fail a redirect. A bounded queue keeps memory fixed under load, and one transaction per batch keeps the event rows and the totals consistent. | Write synchronously in the redirect: exact counts, but a slow or locked database would slow or fail redirects; External message queue: durable, but an external service |
| architecture | 1 | ADR-5 Per-client token bucket on the management API only: Rate limit /api/* per client address with an in-process token bucket whose key count is bounded. Redirects are not limited. | Link creation is the write an attacker can abuse; redirects are the product and are a single indexed read. The key bound stops a flood of distinct addresses from exhausting memory. | Shared limiter in Redis: needed for several instances, but an external service; Limit redirects too: would throttle legitimate traffic to a popular link |
| architecture | 1 | ADR-6 Store the referrer's host only, and no client address: Reduce the Referer header to its host before it is queued. Do not store or log the client address. | A full referrer URL can carry personal data in its path or query. Host-level data answers the stated question (top referrers) without holding personal data. | Store the full referrer URL: more detail than was asked for, with a privacy cost |
| architecture | 1 | ADR-7 Errors as RFC 9457 problem documents: Every error response is application/problem+json with a stable machine-readable code. Unexpected errors are logged in full and returned as a generic 500. | Clients get one error shape to handle, and internal detail never leaves the process. | Ad-hoc JSON error bodies per route |
| architecture | 1 | ADR-8 Run the TypeScript sources directly: Use Node's built-in type stripping; type-check with tsc --noEmit as a separate step. | No build output to keep in sync and a single start command. The cost is a minimum Node version of 22.18 and a restriction to erasable TypeScript syntax, which the compiler enforces. | Compile to dist/ with tsc: works on older Node versions, adds a build step; tsx or ts-node: an extra runtime dependency |

## Artifact versions

| Artifact | Version | Status | Hash | Produced by | Stage (generation) |
| --- | --- | --- | --- | --- | --- |
| requirement | v1 | accepted | `689254c71c82` | requester | run-creation (0) |
| baseline-index | v1 | accepted | `c86deffb2931` | orchestrator | run-creation (0) |
| requirement-spec | v1 | accepted | `d0cb49a456d8` | agent:requirements | requirements (1) |
| plan | v1 | accepted | `8b2271eddda3` | agent:planning:fallback | planning (1) |
| design | v1 | proposed | `fa7e1e9ce7c0` | agent:architecture | architecture (1) |

## Lineage of `design`

Each line was derived from the lines indented beneath it. A line ending in … is expanded where it first appears.

```
design v1 [fa7e1e9ce7c0] by agent:architecture (architecture, generation 1)
  plan v1 [8b2271eddda3] by agent:planning:fallback (planning, generation 1)
    requirement-spec v1 [d0cb49a456d8] by agent:requirements (requirements, generation 1)
      baseline-index v1 [c86deffb2931] by orchestrator (run-creation, generation 0)
      requirement v1 [689254c71c82] by requester (run-creation, generation 0)
  requirement-spec v1 [d0cb49a456d8] by agent:requirements (requirements, generation 1) …
```

## Timeline

Selected events from `audit.jsonl`.

| # | Time | Event | Stage | Actor | Detail |
| --- | --- | --- | --- | --- | --- |
| 1 | 00:56:50.015 | RUN_CREATED |  | engine:orchestrator | scenario: greenfield · mode: offline |
| 4 | 00:56:50.016 | RUN_STARTED |  | engine:orchestrator |  |
| 16 | 00:56:50.024 | STAGE_SUCCEEDED | requirements | engine:orchestrator |  |
| 17 | 00:56:50.024 | STAGE_SKIPPED | impact-analysis | engine:orchestrator | reason: not enabled for this run |
| 19 | 00:56:50.025 | STAGE_ATTEMPT_FAILED | planning | agent:planning | error: injected fault: agent unavailable |
| 21 | 00:56:50.533 | STAGE_ATTEMPT_FAILED | planning | agent:planning | error: injected fault: agent unavailable |
| 22 | 00:56:50.533 | FALLBACK_ACTIVATED | planning | engine:orchestrator | to: agent:planning:fallback |
| 29 | 00:56:50.541 | STAGE_SUCCEEDED | planning | engine:orchestrator |  |
| 42 | 00:56:50.548 | APPROVAL_REQUESTED | architecture | engine:orchestrator | reasons: The design changes the database schema.; The design changes the public API (additive).; The design adds or changes dependencies: fastify, zod, typescript, vitest, @types/node. · kind: approval |
| 43 | 00:56:50.549 | RUN_PAUSED |  | engine:orchestrator | waitingOn: architecture |
