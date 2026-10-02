# Run ambiguous

**Status: SUCCEEDED**

|  |  |
| --- | --- |
| Scenario | ambiguous |
| Mode | offline (recorded model replies; gates, policies, build and approvals run for real) |
| Target | `demo-output/url-shortener` |
| Stage executions | 17 (0 retried, 0 fallback, 0 rework loop(s), 3 stage(s) invalidated and re-run) |
| Model calls | 13 |
| Active time | 2.2 s (plus 0.8 s waiting for people) |
| Audit log | 144 events, hash chain verified |

## Stages

| Stage | Status | Generation | Attempts | Notes |
| --- | --- | --- | --- | --- |
| Requirement understanding | SUCCEEDED | 3 | 3 |  |
| Codebase impact analysis | SUCCEEDED | 2 | 2 |  |
| Task decomposition | SUCCEEDED | 2 | 2 |  |
| Architecture and design | SUCCEEDED | 2 | 2 |  |
| Implementation | SUCCEEDED | 1 | 1 |  |
| Test design | SUCCEEDED | 1 | 1 |  |
| Documentation | SUCCEEDED | 1 | 1 |  |
| Integrate changes into the workspace | SUCCEEDED | 1 | 1 |  |
| Build and test | SUCCEEDED | 1 | 1 |  |
| Security, compliance and change-control review | SUCCEEDED | 1 | 1 |  |
| Release readiness | SUCCEEDED | 1 | 1 |  |
| Promote to the target | SUCCEEDED | 1 | 1 |  |

## Human decisions

| When | Stage | Decision | By | Channel | Covers | Comment |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-02T00:56:46.988Z | requirements | clarified | demo-requester | cli | `ca17796dcf75` |  |
| 2026-10-02T00:56:47.193Z | architecture | changes_requested | demo-reviewer | cli | `ed45a3030078` | Bots must not inflate campaign numbers: report bot and non-bot clicks separately in the stats. |
| 2026-10-02T00:56:47.400Z | architecture | approved | demo-reviewer | cli | `671c82989cf8` | Approved with the bot split. Privacy position confirmed: device class only. |
| 2026-10-02T00:56:49.807Z | release-readiness | approved | demo-reviewer | cli | `b6b746a59733` | Release approved. |

## Files in this packet

- `specification.md`: what was understood, what was ambiguous, what was assumed
- `plan-and-design.md`: impact on the codebase, tasks, design decisions, risks
- `changes.md` and `changes.diff`: what changed, traced from requirement to test
- `verification.md`: test results, policy findings, release checklist, risk assessment
- `lineage.md`: decisions, artifact lineage and the event timeline
