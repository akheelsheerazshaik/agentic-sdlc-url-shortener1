# Verification

## Build and tests

_v1, accepted, hash `7dd1b8e2abae`, produced by agent:build-verifier_

- Type-check: passed
- Tests: 88/88 passed, 0 failed, in 1.8 s


## Policy review

_v1, accepted, hash `8337999260e6`, produced by agent:policy-reviewer_

| Rule | Category | What it enforces | Result |
| --- | --- | --- | --- |
| SEC-001 | SECURITY | Changes stay inside the workspace and inside the directories agents are allowed to write. | pass |
| SEC-002 | SECURITY | No credentials or key material in any file. | pass |
| SEC-003 | SECURITY | No dynamic code execution, process spawning, injectable SQL or disabled TLS verification. | pass |
| CMP-001 | COMPLIANCE | No personal data (client address, User-Agent, contact details, visitor identifiers) stored or logged. | pass |
| CMP-002 | COMPLIANCE | Every file change cites a task in the plan, and every task in the plan has at least one change. | pass |
| CHG-001 | CHANGE_CONTROL | Existing migrations are immutable; a schema change is a new migration with the next number. | needs approval |
| CHG-002 | CHANGE_CONTROL | Adding, removing or re-versioning a dependency needs approval. | needs approval |
| CHG-003 | CHANGE_CONTROL | Deleting files or removing API operations needs approval. | pass |
| CHG-004 | CHANGE_CONTROL | A change touching more than 60 files or 6000 lines needs approval. | pass |
| CHG-005 | CHANGE_CONTROL | The change does nothing high-impact that the approved design did not declare. | pass |
| QA-001 | QUALITY | Test files are not deleted and tests are not skipped, focused or left as todo. | pass |

Findings:
- **CHG-001 REQUIRE_APPROVAL** `migrations/001_init.sql`: adds a database migration
- **CHG-002 REQUIRE_APPROVAL** `package.json`: changes dependency "@types/node"
- **CHG-002 REQUIRE_APPROVAL** `package.json`: changes dependency "fastify"
- **CHG-002 REQUIRE_APPROVAL** `package.json`: changes dependency "typescript"
- **CHG-002 REQUIRE_APPROVAL** `package.json`: changes dependency "vitest"
- **CHG-002 REQUIRE_APPROVAL** `package.json`: changes dependency "zod"

## Release readiness

_v1, accepted, hash `52cfd5f0cece`, produced by agent:release-manager_

Change `CHG-greenfield`: URL shortener service. Tree `ca702660b93e`.

| Check | Item | Result | Evidence |
| --- | --- | --- | --- |
| REL-1 | Build and policy review were run on exactly this change | pass | workspace ca702660b93e, tested ca702660b93e, reviewed ca702660b93e |
| REL-2 | Type-check passes | pass | tsc --noEmit exited 0 |
| REL-3 | All tests pass | pass | 88/88 passed, 0 failed |
| REL-4 | Every acceptance criterion is proven by a test that passed | pass | 17/17 criteria proven |
| REL-5 | No blocking policy findings | pass | 11 rules evaluated: 0 blocking, 6 needing approval, 0 warnings |
| REL-6 | The design this change implements was approved by a person where required | pass | approved by demo-reviewer (cli) at 2026-10-02T00:56:39.590Z |

High-impact items the release approver signs off explicitly:
- CHG-001 migrations/001_init.sql: adds a database migration
- CHG-002 package.json: changes dependency "@types/node"
- CHG-002 package.json: changes dependency "fastify"
- CHG-002 package.json: changes dependency "typescript"
- CHG-002 package.json: changes dependency "vitest"
- CHG-002 package.json: changes dependency "zod"

### Risk assessment

First release of a new service. There is no existing data or traffic to protect, so the release risk is low; the risks that remain are properties of the design that were accepted knowingly, chiefly the unauthenticated API.

| Residual risk | Mitigation |
| --- | --- |
| The management API is unauthenticated. | Expose it only behind a trusted gateway. Per-client rate limiting bounds abuse. |
| Clicks buffered at the moment the process stops are lost. | Accepted as best-effort analytics for this version and documented; flushing on shutdown is the next change. |
| Short links can point at malicious sites. | Scheme and credential rules are enforced now; destination reputation checks are a recorded follow-up. |
| Single instance only. | Run one instance. The readiness probe reports database trouble. |

Rollback plan:
1. Stop the service.
2. Remove the deployed directory; nothing existed before this release, so there is no earlier version to restore.
3. Delete the SQLite file at DATABASE_PATH if the data should not be kept.

After release, check:
- GET /readyz returns 200.
- Create a link, follow it, and confirm the click appears in its stats within the flush interval.
- Send more than the burst of creation requests from one client and confirm 429 with Retry-After.
