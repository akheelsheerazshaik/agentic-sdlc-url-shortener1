# Changes

_v1, accepted, hash `4575fd4b1e3f`, produced by agent:integrator_

Baseline `e3b0c44298fc` → workspace `ca702660b93e`. Full diff: `changes.diff`.

| File | Status | + | - | Tasks |
| --- | --- | --- | --- | --- |
| `.gitignore` | added | 5 | 0 | T-1 |
| `README.md` | added | 73 | 0 | T-9 |
| `migrations/001_init.sql` | added | 18 | 0 | T-2 |
| `openapi.yaml` | added | 216 | 0 | T-9 |
| `package-lock.json` | added | 2162 | 0 | T-1 |
| `package.json` | added | 26 | 0 | T-1 |
| `src/analytics/clickRecorder.ts` | added | 113 | 0 | T-5 |
| `src/analytics/statsService.ts` | added | 70 | 0 | T-5 |
| `src/app.ts` | added | 80 | 0 | T-6 |
| `src/config.ts` | added | 52 | 0 | T-1 |
| `src/db/database.ts` | added | 35 | 0 | T-2 |
| `src/db/migrator.ts` | added | 59 | 0 | T-2 |
| `src/domain/errors.ts` | added | 34 | 0 | T-3 |
| `src/domain/shortCode.ts` | added | 39 | 0 | T-3 |
| `src/domain/urlPolicy.ts` | added | 39 | 0 | T-3 |
| `src/http/problem.ts` | added | 59 | 0 | T-6 |
| `src/http/rateLimiter.ts` | added | 73 | 0 | T-6 |
| `src/http/routes.ts` | added | 96 | 0 | T-6 |
| `src/links/linkRepository.ts` | added | 48 | 0 | T-4 |
| `src/links/linkService.ts` | added | 79 | 0 | T-4 |
| `src/server.ts` | added | 42 | 0 | T-6 |
| `test/helpers.ts` | added | 66 | 0 | T-7, T-8 |
| `test/integration/links.api.test.ts` | added | 159 | 0 | T-8 |
| `test/integration/reliability.test.ts` | added | 87 | 0 | T-8 |
| `test/integration/stats.api.test.ts` | added | 87 | 0 | T-8 |
| `test/unit/clickRecorder.test.ts` | added | 74 | 0 | T-7 |
| `test/unit/migrator.test.ts` | added | 55 | 0 | T-7 |
| `test/unit/rateLimiter.test.ts` | added | 60 | 0 | T-7 |
| `test/unit/shortCode.test.ts` | added | 48 | 0 | T-7 |
| `test/unit/urlPolicy.test.ts` | added | 39 | 0 | T-7 |
| `tsconfig.json` | added | 18 | 0 | T-1 |
| `vitest.config.ts` | added | 8 | 0 | T-1 |

## Traceability: requirement → criterion → tasks → tests

| Requirement | Acceptance criterion | Tasks | Proving tests |
| --- | --- | --- | --- |
| FR-1 | AC-1.1 POST /api/v1/links with a valid URL returns 201 with the code, the short URL, the normalized target URL and the creation time. | T-2, T-3, T-4, T-6, T-7, T-8, T-9 | creates a link with a generated code (passed) |
| FR-1 | AC-1.2 A supplied alias becomes the code. An alias that is already in use returns 409. | T-2, T-3, T-4, T-6, T-7, T-8, T-9 | creates a link with a custom alias (passed); returns 409 when the alias is already taken (passed) |
| FR-1 | AC-1.3 Invalid input returns 400 as a problem document: a URL that is not http/https, carries credentials, exceeds 2048 characters or points at the service itself; an invalid or reserved alias; unknown fields. | T-2, T-3, T-4, T-6, T-7, T-8, T-9 | returns a 400 problem document for non-http scheme (passed); returns a 400 problem document for reserved alias (passed); returns a 400 problem document for unknown field (passed); rejects URLs longer than the limit (passed) |
| FR-1 | AC-1.4 A generated code that collides with an existing one is retried with a new code. If no unique code is found after a bounded number of tries the response is 503. | T-2, T-3, T-4, T-6, T-7, T-8, T-9 | retries with a new code when a generated code collides (passed); returns 503 instead of looping forever (passed) |
| FR-2 | AC-2.1 GET /{code} returns 302 with the target in Location and Cache-Control: no-store. | T-4, T-6, T-8, T-9 | redirects to the target with 302 and no caching (passed) |
| FR-2 | AC-2.2 An unknown or malformed code returns 404 as a problem document. | T-4, T-6, T-8, T-9 | GET /:code returns 404 for an unknown code (passed); returns 404 for the malformed code (passed) |
| FR-3 | AC-3.1 GET /api/v1/links/{code} returns the link, or 404 for an unknown code. | T-4, T-6, T-8, T-9 | GET /api/v1/links/:code returns the link (passed); GET /api/v1/links/:code returns 404 for an unknown code (passed) |
| FR-4 | AC-4.1 Total clicks counts every successful redirect and nothing else. | T-2, T-5, T-6, T-8, T-9 | counts every redirect (passed); does not count failed lookups (passed) |
| FR-4 | AC-4.2 Clicks are reported per UTC day, oldest first, for the last 30 days. | T-2, T-5, T-6, T-8, T-9 | groups clicks by UTC day, oldest first (passed); limits the daily breakdown to the reporting window (passed) |
| FR-4 | AC-4.3 The top referrers are reported by host, with clicks that have no referrer counted as "direct". Only the referrer's host is stored. | T-2, T-5, T-6, T-8, T-9 | ranks referrers by host (passed); stores only the referrer host, never the full URL (passed) |
| FR-5 | AC-5.1 A client that exceeds its burst receives 429 with Retry-After, and is served again once its allowance refills. | T-6, T-7, T-8 | returns 429 with Retry-After once the burst is used up, then recovers (passed) |
| FR-5 | AC-5.2 Redirects are not rate limited. | T-6, T-7, T-8 | does not rate limit redirects (passed) |
| FR-6 | AC-6.1 Redirects keep succeeding when the click queue is full; the excess clicks are dropped and counted. | T-5, T-7, T-8 | serves redirects even when the click queue is full (passed); drops clicks beyond the queue bound and counts them (passed) |
| FR-6 | AC-6.2 Buffered clicks and the per-link totals are written in one transaction; a failed write changes nothing and keeps the batch. | T-5, T-7, T-8 | writes the events and the running total together on flush (passed); keeps the batch and leaves the database untouched when a flush fails (passed) |
| FR-7 | AC-7.1 GET /healthz returns 200 while the process runs. GET /readyz returns 200 when the database is reachable and 503 when it is not. | T-6, T-8, T-9 | reports liveness and readiness (passed); reports not ready when the database is unavailable (passed) |
| FR-8 | AC-8.1 Malformed JSON returns 400 and an oversized body returns 413. | T-3, T-6, T-8 | returns a 400 problem document for malformed JSON (passed); rejects bodies over the size limit (passed) |
| FR-8 | AC-8.2 An unexpected internal failure returns a generic 500 problem document that exposes no internal detail. | T-3, T-6, T-8 | returns a generic 500 and leaks no internals when the database fails (passed) |
