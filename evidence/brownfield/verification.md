# Verification

## Build and tests

_v2, accepted, hash `c782e8d38fad`, produced by agent:build-verifier_

- Type-check: passed
- Tests: 113/113 passed, 0 failed, in 2.0 s


### Earlier build that was sent back (rework loop 1)

- [build-green] test failed: test/integration/expiry.api.test.ts > link expiry creating a link rejects an expiry in the past with 400: AssertionError: expected 201 to be 400 // Object.is equality
- [build-green] test failed: test/integration/expiry.api.test.ts > link expiry creating a link rejects an expiry equal to now with 400: AssertionError: expected 201 to be 400 // Object.is equality


## Policy review

_v2, accepted, hash `fba3f7805061`, produced by agent:policy-reviewer_

| Rule | Category | What it enforces | Result |
| --- | --- | --- | --- |
| SEC-001 | SECURITY | Changes stay inside the workspace and inside the directories agents are allowed to write. | pass |
| SEC-002 | SECURITY | No credentials or key material in any file. | pass |
| SEC-003 | SECURITY | No dynamic code execution, process spawning, injectable SQL or disabled TLS verification. | pass |
| CMP-001 | COMPLIANCE | No personal data (client address, User-Agent, contact details, visitor identifiers) stored or logged. | pass |
| CMP-002 | COMPLIANCE | Every file change cites a task in the plan, and every task in the plan has at least one change. | pass |
| CHG-001 | CHANGE_CONTROL | Existing migrations are immutable; a schema change is a new migration with the next number. | needs approval |
| CHG-002 | CHANGE_CONTROL | Adding, removing or re-versioning a dependency needs approval. | pass |
| CHG-003 | CHANGE_CONTROL | Deleting files or removing API operations needs approval. | pass |
| CHG-004 | CHANGE_CONTROL | A change touching more than 60 files or 6000 lines needs approval. | pass |
| CHG-005 | CHANGE_CONTROL | The change does nothing high-impact that the approved design did not declare. | pass |
| QA-001 | QUALITY | Test files are not deleted and tests are not skipped, focused or left as todo. | pass |

Findings:
- **CHG-001 REQUIRE_APPROVAL** `migrations/002_link_expiry.sql`: adds a database migration

## Release readiness

_v1, accepted, hash `86035f5810a5`, produced by agent:release-manager_

Change `CHG-brownfield`: Link expiry, and clicks lost on restart. Tree `102bdb45658d`.

| Check | Item | Result | Evidence |
| --- | --- | --- | --- |
| REL-1 | Build and policy review were run on exactly this change | pass | workspace 102bdb45658d, tested 102bdb45658d, reviewed 102bdb45658d |
| REL-2 | Type-check passes | pass | tsc --noEmit exited 0 |
| REL-3 | All tests pass | pass | 113/113 passed, 0 failed |
| REL-4 | Every acceptance criterion is proven by a test that passed | pass | 13/13 criteria proven |
| REL-5 | No blocking policy findings | pass | 11 rules evaluated: 0 blocking, 1 needing approval, 0 warnings |
| REL-6 | The design this change implements was approved by a person where required | pass | approved by demo-reviewer (cli) at 2026-10-02T00:56:41.906Z |

High-impact items the release approver signs off explicitly:
- CHG-001 migrations/002_link_expiry.sql: adds a database migration

### Risk assessment

An additive change to a running service: one nullable column, two optional request fields, one new response status, and a shutdown fix. Existing links and clients are unaffected by construction, and that is tested with a row stored in the old shape. The first implementation attempt missed a validation rule; the independently written tests caught it and the corrected version is what is being released.

| Residual risk | Mitigation |
| --- | --- |
| Clicks are still lost if the process is killed without a graceful shutdown. | Documented limitation. Give the service a termination grace period longer than one flush. |
| A strict client may reject the added expiresAt field. | The field is additive and the contract version changed from 1.0.0 to 1.1.0; announce it to API consumers. |
| The migration cannot be undone by the application. | It only adds a nullable column, which the previous version ignores, so rolling the code back does not require rolling the schema back. |

Rollback plan:
1. Redeploy the previous version of the service. It does not read expires_at and runs correctly against the migrated database.
2. Leave migration 002 in place: removing a column is not needed for the old code and would discard expiries already set.
3. Links created with an expiry while the new version was live will redirect indefinitely under the old version; list them with SELECT code FROM links WHERE expires_at IS NOT NULL and decide per link.

After release, check:
- GET /readyz returns 200 and the startup log shows 002_link_expiry.sql applied.
- A link that existed before the release still redirects.
- Create a link with ttlSeconds, wait for it to pass, and confirm 410 with code link_expired.
- Restart the service under traffic and confirm the click total matches the number of redirects served.
