# Verification

## Build and tests

_v1, accepted, hash `698f1b832dbf`, produced by agent:build-verifier_

- Type-check: passed
- Tests: 189/189 passed, 0 failed, in 2.2 s


## Policy review

_v1, accepted, hash `1c34c5f5039e`, produced by agent:policy-reviewer_

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
- **CHG-001 REQUIRE_APPROVAL** `migrations/003_click_device_class.sql`: adds a database migration

## Release readiness

_v1, accepted, hash `d744f36235ac`, produced by agent:release-manager_

Change `CHG-ambiguous`: Safer links, better insight. Tree `b6a6802ecafa`.

| Check | Item | Result | Evidence |
| --- | --- | --- | --- |
| REL-1 | Build and policy review were run on exactly this change | pass | workspace b6a6802ecafa, tested b6a6802ecafa, reviewed b6a6802ecafa |
| REL-2 | Type-check passes | pass | tsc --noEmit exited 0 |
| REL-3 | All tests pass | pass | 189/189 passed, 0 failed |
| REL-4 | Every acceptance criterion is proven by a test that passed | pass | 14/14 criteria proven |
| REL-5 | No blocking policy findings | pass | 11 rules evaluated: 0 blocking, 1 needing approval, 0 warnings |
| REL-6 | The design this change implements was approved by a person where required | pass | approved by demo-reviewer (cli) at 2026-10-02T00:56:47.400Z |

High-impact items the release approver signs off explicitly:
- CHG-001 migrations/003_click_device_class.sql: adds a database migration

### Risk assessment

Two additive features and one tightening of validation. The release changes behaviour in one deliberate way: destinations on internal or denied hosts are refused, on create and on redirect. The design reads the User-Agent header to derive a device class, which is why it was flagged as touching personal data; the header is not stored or logged, and a test asserts the stored columns.

| Residual risk | Mitigation |
| --- | --- |
| A public name that resolves to a private address passes the destination check. | Documented limitation of checking the URL text. Resolving DNS or using a reputation feed is the follow-up if this matters in practice. |
| A wrong denylist entry blocks legitimate links immediately, including existing ones. | Entries are validated at startup and match hosts and subdomains only. Removing the entry and restarting restores the links, because no blocked state is stored. |
| Bot detection is heuristic, so nonBotClicks still contains automated traffic that poses as a browser. | The field is named and documented for what it measures. totalClicks is unchanged, so existing reports are not affected. |
| The migration validates every existing click_events row against the new constraint. | The default satisfies the constraint. Run in a maintenance window if the table is very large. |

Rollback plan:
1. Redeploy the previous version. It ignores device_class and runs correctly against the migrated database, because the column has a default.
2. Leave migration 003 in place; the previous version does not need it removed.
3. Links that the new version blocked redirect again under the previous version, so remove or fix those links first if they are known to be unsafe.
4. Clicks recorded while the previous version is live take the default device class and are reported as unknown.

After release, check:
- GET /readyz returns 200 and the startup log shows 003_click_device_class.sql applied.
- Creating a link to http://169.254.169.254/ returns 400.
- Add a test host to DENIED_HOSTS, restart, and confirm an existing link to it returns 410 with code link_blocked.
- Follow a link from a phone and from curl, and confirm the stats show one mobile and one bot click.
- Inspect a row of click_events and confirm it holds a device class and no User-Agent.
