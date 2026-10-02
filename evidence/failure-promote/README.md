# Run failure-promote

**Status: SUCCEEDED**

|  |  |
| --- | --- |
| Scenario | brownfield |
| Mode | offline (recorded model replies; gates, policies, build and approvals run for real) |
| Target | `demo-output/failures/promote-fails` |
| Stage executions | 19 (0 retried, 0 fallback, 1 rework loop(s), 4 stage(s) invalidated and re-run) |
| Model calls | 10 |
| Active time | 4.2 s (plus 0.6 s waiting for people) |
| Audit log | 136 events, hash chain verified |

## Stages

| Stage | Status | Generation | Attempts | Notes |
| --- | --- | --- | --- | --- |
| Requirement understanding | SUCCEEDED | 1 | 1 |  |
| Codebase impact analysis | SUCCEEDED | 1 | 1 |  |
| Task decomposition | SUCCEEDED | 1 | 1 |  |
| Architecture and design | SUCCEEDED | 1 | 1 |  |
| Implementation | SUCCEEDED | 2 | 2 |  |
| Test design | SUCCEEDED | 2 | 2 |  |
| Documentation | SUCCEEDED | 1 | 1 |  |
| Integrate changes into the workspace | SUCCEEDED | 2 | 3 |  |
| Build and test | SUCCEEDED | 2 | 2 | sent work back 1x |
| Security, compliance and change-control review | SUCCEEDED | 2 | 2 |  |
| Release readiness | SUCCEEDED | 1 | 1 |  |
| Promote to the target | SUCCEEDED | 1 | 2 |  |

## Human decisions

| When | Stage | Decision | By | Channel | Covers | Comment |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-02T00:56:53.213Z | architecture | approved | demo-reviewer | cli | `e7ab72a335ee` | Design accepted. |
| 2026-10-02T00:56:57.547Z | release-readiness | approved | demo-reviewer | cli | `db9d9dedac0f` | Release approved. |

## Files in this packet

- `specification.md`: what was understood, what was ambiguous, what was assumed
- `plan-and-design.md`: impact on the codebase, tasks, design decisions, risks
- `changes.md` and `changes.diff`: what changed, traced from requirement to test
- `verification.md`: test results, policy findings, release checklist, risk assessment
- `lineage.md`: decisions, artifact lineage and the event timeline
