# Changes

_v1, accepted, hash `bcea55cd859c`, produced by agent:integrator_

Baseline `102bdb45658d` → workspace `b6a6802ecafa`. Full diff: `changes.diff`.

| File | Status | + | - | Tasks |
| --- | --- | --- | --- | --- |
| `README.md` | modified | 9 | 4 | T-9 |
| `migrations/003_click_device_class.sql` | added | 7 | 0 | T-1 |
| `openapi.yaml` | modified | 31 | 4 | T-9 |
| `src/analytics/clickRecorder.ts` | modified | 4 | 2 | T-5 |
| `src/analytics/deviceClass.ts` | added | 33 | 0 | T-5 |
| `src/analytics/statsService.ts` | modified | 21 | 0 | T-6 |
| `src/app.ts` | modified | 1 | 0 | T-4 |
| `src/config.ts` | modified | 11 | 0 | T-3 |
| `src/domain/errors.ts` | modified | 3 | 0 | T-4 |
| `src/domain/hostRules.ts` | added | 66 | 0 | T-2 |
| `src/domain/urlPolicy.ts` | modified | 20 | 0 | T-2 |
| `src/http/routes.ts` | modified | 3 | 0 | T-5 |
| `src/links/linkService.ts` | modified | 17 | 3 | T-4 |
| `test/integration/safety.api.test.ts` | added | 86 | 0 | T-7 |
| `test/integration/stats.api.test.ts` | modified | 73 | 3 | T-8 |
| `test/unit/clickRecorder.test.ts` | modified | 19 | 2 | T-8 |
| `test/unit/deviceClass.test.ts` | added | 39 | 0 | T-8 |
| `test/unit/hostRules.test.ts` | added | 83 | 0 | T-7 |
| `test/unit/urlPolicy.test.ts` | modified | 8 | 1 | T-7 |

## Traceability: requirement → criterion → tasks → tests

| Requirement | Acceptance criterion | Tasks | Proving tests |
| --- | --- | --- | --- |
| FR-1 | AC-1.1 A destination on a loopback, private, link-local or carrier-NAT address is rejected with 400, in IPv4 and IPv6 and in any numeric notation. | T-2, T-7, T-9 | treats private 10/8 as internal (passed); treats decimal integer form as internal (passed); treats IPv4-mapped IPv6 as internal (passed); rejects the cloud metadata address with 400 (passed) |
| FR-1 | AC-1.2 A destination named localhost, a single-label host name, or a name under an internal suffix is rejected with 400. | T-2, T-7, T-9 | treats localhost as internal (passed); rejects an internal host name with 400 (passed); rejects a single-label host name with 400 (passed) |
| FR-1 | AC-1.3 Public destinations are still accepted. | T-2, T-7, T-9 | accepts public destinations that are not denied (passed); treats a public name as public (passed) |
| FR-2 | AC-2.1 A destination on a denied host, or any subdomain of one, is rejected with 400. | T-2, T-3, T-7, T-9 | rejects a denied host with 400 (passed); rejects a subdomain of a denied host with 400 (passed); does not match hosts that only share a suffix of characters (passed) |
| FR-2 | AC-2.2 A malformed denylist stops the service at startup. | T-2, T-3, T-7, T-9 | refuses to start with a malformed denylist (passed) |
| FR-3 | AC-3.1 An existing link whose host is added to the denylist stops redirecting: 410 with code link_blocked and no Location header. | T-4, T-7, T-9 | blocks an existing link once its host is added to the denylist (passed) |
| FR-3 | AC-3.2 A blocked request records no click, and the response does not reveal the destination. | T-4, T-7, T-9 | does not record a click or reveal the destination for a blocked link (passed) |
| FR-3 | AC-3.3 A stored link that points at an internal address is blocked the same way. | T-4, T-7, T-9 | blocks a stored link that points at an internal address (passed) |
| FR-4 | AC-4.1 Each click is classified as desktop, mobile, tablet, bot or unknown from the request's User-Agent header. | T-1, T-5, T-6, T-8, T-9 | classifies iPhone (passed); classifies Android tablet (passed); classifies a missing header as unknown (passed) |
| FR-4 | AC-4.2 Statistics report the number of clicks for every device class, in a fixed order. | T-1, T-5, T-6, T-8, T-9 | counts clicks per device class (passed) |
| FR-4 | AC-4.3 Only the device class is stored. The User-Agent header is never stored. | T-1, T-5, T-6, T-8, T-9 | stores the device class but never the User-Agent header (passed) |
| FR-4 | AC-4.4 Clicks recorded before this change are reported as unknown. | T-1, T-5, T-6, T-8, T-9 | reports clicks recorded before the device column existed as unknown (passed) |
| FR-5 | AC-5.1 Statistics report botClicks and nonBotClicks, and totalClicks remains their sum. | T-5, T-6, T-8, T-9 | reports bot clicks separately and keeps totalClicks as the sum of both (passed) |
| FR-5 | AC-5.2 A client that identifies itself as automated (a crawler, a link previewer, an HTTP library) is classified as bot. | T-5, T-6, T-8, T-9 | classifies Googlebot (passed); classifies link preview fetcher (passed); classifies HTTP library (passed) |
