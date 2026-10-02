# Plan and design

## Impact on the existing codebase

_v1, accepted, hash `653c7e9a2676`, produced by agent:impact-analysis_

Expiry adds one nullable column and touches the link path end to end: repository, service, routes and the error catalogue. The lost-click defect is in the analytics path: the click recorder's buffer is only written by its timer, and the application's close hook stops the timer without writing what is left. The two changes do not overlap in any module.

| Module | Change | Reason |
| --- | --- | --- |
| `src/links/linkRepository.ts` | modify | Persist and read the new expires_at column. |
| `src/links/linkService.ts` | modify | Validate the expiry input, and refuse to resolve an expired link for a redirect. |
| `src/domain/errors.ts` | extend | New link_expired error mapped to 410. |
| `src/http/routes.ts` | modify | Accept expiresAt and ttlSeconds, return expiresAt, and resolve through the expiry check on redirect. |
| `src/analytics/clickRecorder.ts` | modify | BUG-17: stopping the recorder must flush the buffer. |
| `src/app.ts` | modify | BUG-17: the close hook must call the flushing close and must not fail shutdown if it throws. |
| `test/integration/links.api.test.ts` | modify | An existing assertion compares the whole response body and must expect the added field. |
| `test/unit/clickRecorder.test.ts` | extend | Cover the flush on close. |
| `openapi.yaml` | modify | New request fields, new response field, new 410 response. |
| `README.md` | modify | Document expiry and the corrected shutdown behaviour. |

| New module | Purpose |
| --- | --- |
| `migrations/002_link_expiry.sql` | Add the nullable expires_at column to links. |
| `test/integration/expiry.api.test.ts` | API tests for creating, redirecting and reading links with an expiry. |
| `test/unit/linkExpiry.test.ts` | Boundary tests for the expiry check. |
| `test/integration/shutdown.test.ts` | Regression tests for BUG-17. |

API:
- `POST /api/v1/links`: Additive: optional expiresAt and ttlSeconds in the request, expiresAt in the response.
- `GET /api/v1/links/{code}`: Additive: expiresAt in the response.
- `GET /{code}`: Additive: 410 for an expired link.

Data:
- links gains a nullable expires_at column. Existing rows read as NULL, meaning no expiry.

Data flows:
- Redirect: look up link → check expiry → queue click → 302. An expired link stops at the check: 410, no click queued.
- Shutdown: app.close → onClose hook → recorder flushes its buffer → caller closes the database. Previously the hook only stopped the timer.

Regression surface, from the import graph (11 modules depend on what changes):
- `src/analytics/statsService.ts`
- `src/domain/shortCode.ts`
- `src/domain/urlPolicy.ts`
- `src/http/problem.ts`
- `src/server.ts`
- `test/helpers.ts`
- `test/integration/reliability.test.ts`
- `test/integration/stats.api.test.ts`
- `test/unit/migrator.test.ts`
- `test/unit/shortCode.test.ts`
- `test/unit/urlPolicy.test.ts`

## Task plan

_v1, accepted, hash `50739c6147d7`, produced by agent:planning_

Two independent slices. Expiry goes in dependency order: schema, repository, service, HTTP. The shutdown fix is confined to the click recorder and the application's close hook. The tests are written from the acceptance criteria in parallel, including regression tests that fail on the current code for BUG-17.

| Task | Lane | Title | Depends on | Requirements | Risk | Files |
| --- | --- | --- | --- | --- | --- | --- |
| T-1 | code | Migration: nullable expires_at on links | - | FR-1, FR-5, NFR-1 | medium | `migrations/002_link_expiry.sql` |
| T-2 | code | Store and read the expiry | T-1 | FR-1, FR-3, FR-5 | low | `src/links/linkRepository.ts` |
| T-3 | code | Expiry rules in the link service | T-2 | FR-1, FR-2, FR-3, NFR-2 | medium | `src/links/linkService.ts` `src/domain/errors.ts` |
| T-4 | code | Expiry in the HTTP API | T-3 | FR-1, FR-2, FR-5 | low | `src/http/routes.ts` |
| T-5 | code | BUG-17: flush buffered clicks on shutdown | - | FR-4 | medium | `src/analytics/clickRecorder.ts` `src/app.ts` |
| T-6 | test | Tests for link expiry and compatibility | - | FR-1, FR-2, FR-3, FR-5 | low | `test/integration/expiry.api.test.ts` `test/unit/linkExpiry.test.ts` `test/integration/links.api.test.ts` |
| T-7 | test | Regression tests for BUG-17 | - | FR-4 | low | `test/integration/shutdown.test.ts` `test/unit/clickRecorder.test.ts` |
| T-8 | docs | Update the README and the OpenAPI contract | - | FR-1, FR-2, FR-4 | low | `README.md` `openapi.yaml` |

## Design

_v1, accepted, hash `8e8ba307ceea`, produced by agent:architecture_

Expiry is a nullable instant on the link row, enforced when a link is resolved for a redirect. The redirect already loads the row by primary key, so the check costs a comparison and no extra query. The service gains a second read operation: get returns any stored link (used for metadata and statistics), resolve returns only a link that may be redirected to and raises link_expired otherwise. That split is what lets an expired link stay readable while its redirect answers 410.

BUG-17 has a single cause. The click recorder's buffer is written only by its interval timer, and the application's close hook stops the timer and nothing else, so whatever was queued since the last tick is discarded on every deployment. The fix makes closing the recorder mean stop the timer and write the buffer, and runs it in the close hook, which Fastify invokes after in-flight requests finish and before the caller closes the database.

| Component | Responsibility | Files |
| --- | --- | --- |
| Schema | Add links.expires_at, nullable, with no backfill. | `migrations/002_link_expiry.sql` |
| Link repository | Persist and return the expiry. | `src/links/linkRepository.ts` |
| Link service | Validate and normalize the expiry on create; separate get (any link) from resolve (redirectable link). | `src/links/linkService.ts` `src/domain/errors.ts` |
| Routes | Accept the new fields, return expiresAt, redirect through resolve. | `src/http/routes.ts` |
| Click recorder and app lifecycle | Flush the buffer on close; never let a failed final flush block shutdown. | `src/analytics/clickRecorder.ts` `src/app.ts` |

### API changes

- `POST /api/v1/links`: Optional expiresAt (date-time with zone) and ttlSeconds (1 to 157680000), mutually exclusive. Response adds expiresAt (string or null).
- `GET /api/v1/links/{code}`: Response adds expiresAt. Still returned after expiry.
- `GET /{code}`: New 410 response with code link_expired once the link has expired.

### Data model changes

- links.expires_at TEXT NULL: ISO-8601 instant in UTC, NULL for no expiry.

### Change envelope (what the approver signed off)

| Aspect | Declared |
| --- | --- |
| Schema change | yes |
| API change | additive |
| Dependencies added or changed | none |
| Touches personal data | no |

### Decisions

**ADR-1 Enforce expiry when resolving, and keep the row.** Store the expiry on the link and compare it with the current time in LinkService.resolve. Expired rows are not deleted.

Why: The owner must still read the stats of an expired link, and the visitor must be told it expired rather than that it never existed. Both need the row to remain. The check reuses the row the redirect already loads.

Rejected:
- A background job that deletes expired links: loses the statistics and turns expiry into a 404
- Filter expired rows in the SQL WHERE clause: cannot tell expired from unknown, so it cannot answer 410

**ADR-2 410 Gone with a link_expired code.** An expired link's redirect answers 410 as a problem document with code link_expired, and sends no Location header.

Why: 410 is the HTTP status for a resource that existed and is intentionally gone, and it keeps the response in the API's existing error format.

Rejected:
- 404: indistinguishable from a mistyped link
- An HTML explanation page: a new presentation concern for an API service

**ADR-3 Two input forms, one stored form.** Accept expiresAt or ttlSeconds but not both, require a time zone on expiresAt, require the result to be in the future, cap ttlSeconds at five years, and store a UTC instant.

Why: Campaigns end at a known time; temporary links are easier to express as a duration. Normalizing to one UTC value means the rest of the system handles a single representation. Requiring a zone avoids guessing which local time the caller meant.

Rejected:
- Only expiresAt: forces clients to compute a timestamp for simple cases
- Accept local times without a zone: ambiguous

**ADR-4 An expired alias stays reserved.** Creating a link with the alias of an expired link returns 409 as before.

Why: Reuse would let anyone take over a link that is already printed, shared or bookmarked.

Rejected:
- Release the alias on expiry: convenient for owners, unsafe for visitors

**ADR-5 Fix BUG-17 by flushing in the close hook.** ClickRecorder.close stops the timer and flushes. The onClose hook calls it inside a try/catch that logs how many events were lost if the flush fails.

Why: It removes the loss for every graceful shutdown, which is what a deployment is, without touching the redirect path. A failing final flush must not turn a shutdown into a hang.

Rejected:
- Write each click synchronously in the redirect: also survives a crash, but breaks the requirement that recording never slows a redirect
- Shorten the flush interval: narrows the window, does not close it

### Risks

| Id | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | The migration runs against a table with existing rows. | low | medium | Adding a nullable column without a default does not rewrite rows in SQLite. A test inserts a row in the old shape and verifies it still redirects. |
| R-2 | A client that compares whole response bodies breaks on the added expiresAt field. | low | low | The change is additive and the contract version is bumped. The service's own whole-body test is updated as part of this change. |
| R-3 | Clicks are still lost when the process is killed without a graceful shutdown. | medium | low | Out of scope by decision Q-5; documented as a remaining limitation. |
| R-4 | A slow final flush delays shutdown past the platform's grace period. | low | low | The buffer is bounded by CLICK_QUEUE_MAX and is written in one transaction. |
| R-5 | Expired links accumulate. | medium | low | Accepted so that statistics remain available; cleanup is a recorded follow-up. |

### How each requirement is met

- **FR-1**: The create schema accepts both fields; resolveExpiry in the link service validates them and returns one UTC instant or null, which the repository stores.
- **FR-2**: The redirect calls LinkService.resolve, which raises link_expired (410) before any click is queued.
- **FR-3**: Metadata and statistics use LinkService.get and the stats query, neither of which checks expiry; the alias remains the primary key of a row that still exists.
- **FR-4**: ClickRecorder.close flushes, and the onClose hook calls it before the database is closed.
- **FR-5**: The column is nullable with no backfill, and NULL is treated as never expiring; responses only gain a field.
