# Run failure-no-rework

**Status: SAFE_STOPPED**. Stage "build-verify" failed: all attempts failed. Last error: still failing after 0 rework loop(s): [build-green] test failed: test/integration/expiry.api.test.ts > link expiry creating a link rejects an expiry in the past with 400: AssertionError: expected 201 to be 400 // Object.is equality | [build-green] test failed: test/integration/expiry.api.test.ts > link expiry creating a link rejects an expiry equal to now with 400: AssertionError: expected 201 to be 400 // Object.is equality

|  |  |
| --- | --- |
| Scenario | brownfield |
| Mode | offline (recorded model replies; gates, policies, build and approvals run for real) |
| Target | `demo-output/failures/no-rework` |
| Stage executions | 10 (0 retried, 0 fallback, 0 rework loop(s), 0 stage(s) invalidated and re-run) |
| Model calls | 7 |
| Active time | 2.1 s (plus 0.2 s waiting for people) |
| Audit log | 76 events, hash chain verified |

## Stages

| Stage | Status | Generation | Attempts | Notes |
| --- | --- | --- | --- | --- |
| Requirement understanding | SUCCEEDED | 1 | 1 |  |
| Codebase impact analysis | SUCCEEDED | 1 | 1 |  |
| Task decomposition | SUCCEEDED | 1 | 1 |  |
| Architecture and design | SUCCEEDED | 1 | 1 |  |
| Implementation | SUCCEEDED | 1 | 1 |  |
| Test design | SUCCEEDED | 1 | 1 |  |
| Documentation | SUCCEEDED | 1 | 1 |  |
| Integrate changes into the workspace | ROLLED_BACK | 1 | 1 |  |
| Build and test | FAILED | 1 | 1 | error: all attempts failed. Last error: still failing after 0 rework loop(s): [build-green] test failed: test/integration/expiry.api.test.ts > link expiry creating a l |
| Security, compliance and change-control review | SUCCEEDED | 1 | 1 |  |
| Release readiness | PENDING | 0 | 0 |  |
| Promote to the target | PENDING | 0 | 0 |  |

## Human decisions

| When | Stage | Decision | By | Channel | Covers | Comment |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-02T00:56:50.773Z | architecture | approved | demo-reviewer | cli | `e7ab72a335ee` | Design accepted. |

## Files in this packet

- `specification.md`: what was understood, what was ambiguous, what was assumed
- `plan-and-design.md`: impact on the codebase, tasks, design decisions, risks
- `changes.md` and `changes.diff`: what changed, traced from requirement to test
- `verification.md`: test results, policy findings, release checklist, risk assessment
- `lineage.md`: decisions, artifact lineage and the event timeline
