# Changes

_v2, accepted, hash `1981e3641d45`, produced by agent:integrator_

Baseline `ca702660b93e` → workspace `102bdb45658d`. Full diff: `changes.diff`.

| File | Status | + | - | Tasks |
| --- | --- | --- | --- | --- |
| `README.md` | modified | 11 | 5 | T-8 |
| `migrations/002_link_expiry.sql` | added | 4 | 0 | T-1 |
| `openapi.yaml` | modified | 24 | 2 | T-8 |
| `src/analytics/clickRecorder.ts` | modified | 4 | 2 | T-5 |
| `src/app.ts` | modified | 7 | 1 | T-5 |
| `src/domain/errors.ts` | modified | 3 | 0 | T-3 |
| `src/http/routes.ts` | modified | 6 | 9 | T-4 |
| `src/links/linkRepository.ts` | modified | 10 | 4 | T-2 |
| `src/links/linkService.ts` | modified | 62 | 16 | T-3 |
| `test/integration/expiry.api.test.ts` | added | 121 | 0 | T-6 |
| `test/integration/links.api.test.ts` | modified | 1 | 0 | T-6 |
| `test/integration/shutdown.test.ts` | added | 37 | 0 | T-7 |
| `test/unit/clickRecorder.test.ts` | modified | 9 | 0 | T-7 |
| `test/unit/linkExpiry.test.ts` | added | 19 | 0 | T-6 |

## Traceability: requirement → criterion → tasks → tests

| Requirement | Acceptance criterion | Tasks | Proving tests |
| --- | --- | --- | --- |
| FR-1 | AC-1.1 expiresAt accepts an ISO-8601 time with a time zone; it is stored and returned in UTC. | T-1, T-2, T-3, T-4, T-6, T-8 | accepts an absolute expiry and stores it in UTC (passed) |
| FR-1 | AC-1.2 ttlSeconds sets the expiry that many seconds after creation. | T-1, T-2, T-3, T-4, T-6, T-8 | accepts a time-to-live relative to now (passed) |
| FR-1 | AC-1.3 An invalid expiry returns 400: a time that is not in the future, both fields at once, a value that is not a timestamp or has no time zone, or a time-to-live that is zero, negative, fractional or above the maximum. | T-1, T-2, T-3, T-4, T-6, T-8 | rejects an expiry in the past with 400 (passed); rejects an expiry equal to now with 400 (passed); rejects both expiresAt and ttlSeconds with 400 (passed); rejects an expiry without a time zone with 400 (passed); rejects a ttl beyond the maximum with 400 (passed) |
| FR-1 | AC-1.4 A link created without an expiry reports expiresAt as null and never expires. | T-1, T-2, T-3, T-4, T-6, T-8 | never expires by default (passed) |
| FR-2 | AC-2.1 The link redirects normally up to, but not including, its expiry instant. | T-3, T-4, T-6, T-8 | redirects until the expiry instant (passed); is false one millisecond before the expiry instant (passed) |
| FR-2 | AC-2.2 From the expiry instant the redirect returns 410 Gone as a problem document with code link_expired and no Location header. | T-3, T-4, T-6, T-8 | returns 410 Gone from the expiry instant onwards, with no Location header (passed); is true at the expiry instant and afterwards (passed) |
| FR-2 | AC-2.3 A request to an expired link is not counted as a click. | T-3, T-4, T-6, T-8 | does not count requests to an expired link as clicks (passed) |
| FR-3 | AC-3.1 The link's metadata and its statistics are still returned after it has expired. | T-2, T-3, T-6 | still returns the link metadata and its stats (passed) |
| FR-3 | AC-3.2 The alias of an expired link cannot be registered again. | T-2, T-3, T-6 | keeps the alias reserved, so an expired link cannot be taken over (passed) |
| FR-4 | AC-4.1 Clicks still buffered when the application closes are written to the database before it closes. | T-5, T-7, T-8 | writes buffered clicks before the app closes (passed); flushes what is buffered when closed (passed) |
| FR-4 | AC-4.2 Shutdown completes even if that final write fails. | T-5, T-7, T-8 | still closes when the final flush fails (passed) |
| FR-5 | AC-5.1 A link stored before this change still redirects and reports expiresAt as null. | T-1, T-2, T-4, T-6 | leaves links created before the expiry migration working (passed) |
| FR-5 | AC-5.2 Responses keep every existing field with its existing meaning; the only change is the added expiresAt field. | T-1, T-2, T-4, T-6 | creates a link with a generated code (passed); GET /api/v1/links/:code returns the link (passed) |
