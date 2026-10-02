# Run failure-fallback

**Status: PAUSED**

|  |  |
| --- | --- |
| Scenario | greenfield |
| Mode | offline (recorded model replies; gates, policies, build and approvals run for real) |
| Target | `demo-output/failures/fallback` |
| Stage executions | 5 (1 retried, 1 fallback, 0 rework loop(s), 0 stage(s) invalidated and re-run) |
| Model calls | 3 |
| Active time | 0.5 s (plus 0.0 s waiting for people) |
| Audit log | 43 events, hash chain verified |

## Waiting for a person

### Architecture and design (`architecture`) needs approval

- The design changes the database schema.
- The design changes the public API (additive).
- The design adds or changes dependencies: fastify, zod, typescript, vitest, @types/node.

```bash
node src/cli.ts approve failure-fallback architecture --by <your-name>
node src/cli.ts request-changes failure-fallback architecture --by <your-name> --comment "..."
node src/cli.ts reject failure-fallback architecture --by <your-name> --comment "..."
node src/cli.ts resume failure-fallback
```

## Stages

| Stage | Status | Generation | Attempts | Notes |
| --- | --- | --- | --- | --- |
| Requirement understanding | SUCCEEDED | 1 | 1 |  |
| Codebase impact analysis | SKIPPED | 0 | 0 |  |
| Task decomposition | SUCCEEDED | 1 | 3 | used fallback agent |
| Architecture and design | AWAITING_APPROVAL | 1 | 1 |  |
| Implementation | PENDING | 0 | 0 |  |
| Test design | PENDING | 0 | 0 |  |
| Documentation | PENDING | 0 | 0 |  |
| Integrate changes into the workspace | PENDING | 0 | 0 |  |
| Build and test | PENDING | 0 | 0 |  |
| Security, compliance and change-control review | PENDING | 0 | 0 |  |
| Release readiness | PENDING | 0 | 0 |  |
| Promote to the target | PENDING | 0 | 0 |  |

## Human decisions

None yet.

## Files in this packet

- `specification.md`: what was understood, what was ambiguous, what was assumed
- `plan-and-design.md`: impact on the codebase, tasks, design decisions, risks
- `changes.md` and `changes.diff`: what changed, traced from requirement to test
- `verification.md`: test results, policy findings, release checklist, risk assessment
- `lineage.md`: decisions, artifact lineage and the event timeline
