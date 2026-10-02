# Verification

## Build and tests

Not run yet.


## Policy review

_v1, accepted, hash `b7529a0c45ee`, produced by agent:policy-reviewer_

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

Not assessed yet.
