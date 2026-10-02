# Evidence

Output of one full run of `npm run demo`, captured by `npm run evidence` (`scripts/capture-evidence.ts`). Nothing here was edited by hand except this file.

To replace it with the output of your own run:

```bash
npm run evidence
```

## What is here

| Path | Contents |
| --- | --- |
| `demo-console.log` | The complete console transcript: every command and everything it printed |
| `greenfield/`, `brownfield/`, `ambiguous/` | The three scenarios |
| `failure-fallback/`, `failure-no-rework/`, `failure-promote/` | The three failure demonstrations |
| `metrics.json` | Reliability metrics across the six runs |

Each run directory holds the review packet the orchestrator wrote for that run, plus its audit log:

| File | Contents |
| --- | --- |
| `README.md` | Status, stage table, human decisions, usage, audit verification |
| `specification.md` | The requirement as received; what was understood, ambiguous, assumed, and out of scope |
| `plan-and-design.md` | Impact on the codebase, task plan, design, change envelope, decisions, risks |
| `changes.md` | Files changed, and the traceability matrix from requirement to passing test |
| `changes.diff` | The full diff |
| `verification.md` | Test results, earlier failed builds, policy findings, release checklist, risk assessment, rollback plan |
| `lineage.md` | Agents' decisions, every artifact version, lineage of the outcome, timeline of events |
| `audit.jsonl` | The raw hash-chained event log |

## Where to look first

- **The rework loop:** `brownfield/verification.md`, "Earlier build that was sent back", then `brownfield/lineage.md` for the artifact versions (`code-changes` v1 and v2; `test-report` v1 rejected, v2 accepted).
- **Clarification and re-planning:** `ambiguous/specification.md` for the questions and answers, then the timeline in `ambiguous/lineage.md`: `HUMAN_INPUT_RECORDED`, `STAGE_INVALIDATED`, and `ARTIFACT_UNCHANGED` where a re-run produced the same output.
- **Traceability:** the matrix at the end of any `changes.md`.
- **Rollback:** `failure-promote/lineage.md` timeline: `ROLLBACK_STARTED`, `COMPENSATION_EXECUTED`, `RUN_SAFE_STOPPED`, `RETRY_AUTHORIZED`, then `STAGE_REUSED` for the stages that did not need to run again.
- **A run that stops by design:** `failure-no-rework/README.md`.

## Reading it correctly

- The runs are in **offline mode**: model replies are recordings. Gates, policy rules, the build, the pauses, the rework, the re-planning and the audit log are real. See [SCENARIOS.md](../docs/SCENARIOS.md#what-is-recorded-and-what-is-real).
- Decisions by `demo-requester` and `demo-reviewer` were made by the demo script, a fraction of a second after each pause. They stand in for people.
- Durations are from one machine and one run. Counts are deterministic; durations are not.
- `failure-fallback` ends `PAUSED` at its design checkpoint. It only demonstrates the fallback.
