# Engineering summary

## What was asked, and how it was read

The assignment asks for a prototype that turns a requirement into a reviewable engineering outcome through agentic execution, with a URL shortener as the scenario. It names workflow orchestration as the critical differentiator and lists what that layer must do.

Two readings were possible. One is "use an AI assistant to build a URL shortener". The other is "build the system that carries a requirement through the lifecycle under governance, and use the URL shortener to exercise it". The deliverables and evaluation criteria point to the second: three scenarios that each show decomposition, orchestration and validation, and "effectiveness of agentic orchestration" listed first. This work follows the second reading. The service is the output; the orchestrator is the subject.

## Plan and rationale

The work was sequenced so that each piece could be verified before the next depended on it.

1. **The service first, outside the orchestrator, in three versions.** The scenarios need realistic content: a first version, a change to it, and a second change. Each version was written and tested on its own (88, 113, then 189 tests). The tests for the two behaviours the brownfield scenario depends on were checked to fail when the code they guard is removed. This gave the scenarios real material and fixed what "correct output" means before any orchestration existed.
2. **The engine, in isolation.** Graph, state machine, artifact store, recovery and approvals, tested against made-up stages with fake agents. Every recovery path was tested here before the SDLC workflow existed.
3. **Governance.** Audit log, policy rules, metrics. The policy tests found two rules that were too narrow (a quoted JSON key defeated the secret scan; a single-line `ALTER TABLE` defeated the personal-data rule) and both were fixed.
4. **Agents and the workflow.** Twelve stages, their gates, and the model gateway with its two implementations.
5. **Scenario recordings**, derived from the three service versions.
6. **End-to-end runs.** These found real defects, listed under [validation](#what-validation-found).
7. **Documentation**, written from what the system does, with the counts taken from test and run output.

The reasoning behind the central design choices is in [ARCHITECTURE.md, section 9](ARCHITECTURE.md#9-key-decisions). In short:

- **One mechanism, three behaviours.** Versioned artifacts with content hashes give resumable state, re-planning and lineage at once.
- **Controls live outside the model.** Gates, policies and approvals are code. An agent's only power is to return a proposal.
- **Approval means something specific.** It is bound to a content hash, checked again at release, and checked again at promotion.
- **Check deterministically wherever a check is possible.** Nothing that gates a release is a model's opinion.

## Artifacts

| Artifact | Location |
| --- | --- |
| Orchestration engine | `orchestrator/src/engine/` |
| Governance: audit, policy rules, metrics | `orchestrator/src/governance/` |
| SDLC workflow and gates | `orchestrator/src/workflow/` |
| Agents and artifact schemas | `orchestrator/src/agents/` |
| Model gateway, live and recorded | `orchestrator/src/model/` |
| Sandbox, command allowlist, code index | `orchestrator/src/tools/` |
| CLI and review packet | `orchestrator/src/cli.ts`, `orchestrator/src/report/` |
| Orchestrator tests | `orchestrator/test/`: 272 unit, 9 end-to-end |
| Scenario requirements and recordings | `scenarios/` |
| Delivered service | `url-shortener/`: source, 3 migrations, OpenAPI contract, 189 tests |
| Evidence from a full demo run | `evidence/` |
| Demo and evidence scripts | `scripts/` |

Per run, the orchestrator itself produces a review packet in `runs/<run>/review/`: specification, plan and design, diff, traceability matrix, verification results, release record with risk assessment and rollback plan, decisions, lineage and timeline. That packet is the "reviewable engineering outcome" for a single requirement. Six of them are in `evidence/`.

Size: the orchestrator is about 5,650 lines of TypeScript in 31 files with about 3,130 lines of tests. The service is about 1,150 lines with about 1,160 lines of tests.

## Risks, trade-offs and validation

### Risks in the orchestrator

| Risk | Likelihood | Impact | Mitigation in place | Residual |
| --- | --- | --- | --- | --- |
| An agent produces a harmful change | Medium | High | Lane restrictions; containment rules before writing; path check at the point of writing; full policy review on the real workspace; build; human release sign-off; sandbox until promotion | Pattern-based rules can be evaded by code written to evade them |
| An agent makes a failing build pass by weakening tests | Medium | High | The implementation lane cannot write under `test/`; QA-001 blocks deleted or disabled tests; REL-4 requires every criterion to have a passing test | A test lane that writes weak tests in the first place |
| Injected instructions in a requirement | Medium | Medium | Input is tagged as data; screened by SEC-004; controls are outside the model | The screen is a heuristic; the structural defence is what holds |
| An approval is reused for content it did not cover | Low | High | Approvals bound to content hashes; voided on change; re-checked at release and promotion | None known |
| A change goes beyond what was approved | Medium | High | CHG-005 compares the change with the approved envelope | The envelope is only as specific as its four fields |
| A run loops without converging | Medium | Low | Bounded retries, bounded rework, stage-execution and model-call budgets, kill switch | Budgets are per run, not global |
| A failed promotion leaves the target half-written | Low | High | Backup before writing; restore on failure and on crash recovery; read-back verification | The backup is on the same disk |
| The target changes during a run | Medium | Medium | `no-target-drift` refuses to promote | No merge; the run must be restarted |
| Generated tests execute on the host | Medium | High | Allowlist, no shell, scrubbed environment, timeouts, `--ignore-scripts` | **Not isolated.** The largest security gap |
| A real model behaves differently from the recordings | High | Medium | Schema validation, retry with feedback, gates, fallback | **Untested.** The largest functional unknown |

### Trade-offs

The full table is in [TESTING.md](TESTING.md#trade-offs). The three that shaped the work most:

- **A custom engine over a workflow service.** It makes the orchestration mechanics visible and testable in a few hundred lines. It gives up durability and scale that a production system would need.
- **Recorded replies as the default mode.** They make the demo reproducible and the tests exact. They also mean the demo shows the orchestration and not the agents' reasoning.
- **A fixed graph.** Agents decide the content of every stage but cannot change the controls. That costs the flexibility of a planner that designs its own workflow, and buys controls that cannot be removed by the thing they control.

### What validation found

Running the system against itself found real defects, which is the reason to run it:

- **A parsing bug.** The first full greenfield run failed at the documentation stage. The README inside the change set contains code fences, and the reply parser mistook one for a fence around the whole reply. All attempts and the fallback failed, the run stopped safely, the parser was fixed, a regression test was added, and the run was continued with an authorized retry. The safe-stop and retry path was exercised for real before it was ever demonstrated on purpose.
- **A gap in a recording.** The `ambiguity-lint` gate rejected the first specification recorded for the ambiguous scenario, which had not addressed the word "something" in the requirement.
- **Two policy rules that were too narrow**, found by their own tests.
- **A stale flag.** A stage that had used its fallback kept reporting so after a later attempt succeeded on the primary agent.
- **A crash-recovery hole.** Review of the recovery code showed that a promotion interrupted by a crash would have been re-run on top of a half-written target, backing up the damage. Interrupted side effects are now undone before the stage runs again, with two tests.
- **An ordering mistake in the CLI.** The stop request was cleared before the retrying person was validated.

### How the result was validated

- 272 orchestrator unit tests and 189 service tests pass, and both packages type-check under strict settings.
- 9 end-to-end tests pass, running the real scenarios with real builds.
- The end-to-end suite asserts that the three scenarios produce, byte for byte, the service that is checked in.
- The demo was run from the command line, and its output is in `evidence/`.
- The repository was unpacked into an empty directory and set up, tested and demonstrated from the README alone.

## Assumptions

1. **The orchestration layer is what is being assessed**, and the URL shortener is its test subject.
2. **A prototype may record model output** for reproducibility, provided the live path exists, is tested as far as it can be without a key, and the distinction is stated.
3. **One requirement, one run, one operator.** No concurrency between runs on the same target beyond detecting it.
4. **"High-impact"** means: schema changes, API changes, dependency changes, personal data, deletions, large changes, and any write outside the sandbox.
5. **A local directory stands in for a repository and a deployment.** Promotion is a copy; in practice it would be a pull request or a pipeline trigger.
6. **Reviewers have Node.js 22.18 or newer and network access** for `npm ci`.
7. **For the service:** one instance, best-effort analytics, no authentication. Each is recorded as an assumption or a risk in the scenario specifications and designs.

## Limitations

The full list, in order of significance, is in [TESTING.md](TESTING.md#limitations). The three a reader should know before relying on anything here:

1. **Live mode has never been run against a real model.** Its wiring is tested against a stand-in. The quality of real model output through these prompts and gates is unknown.
2. **In offline mode the agents replay recorded content.** The orchestration around them is real; their reasoning is not being demonstrated.
3. **The build runs agent-written tests on the host without isolation.**

## What would come next

In order:

1. Run each stage against a real model, measure the pass rate at each gate, and iterate the prompts. This is the step that turns a tested orchestration design into a working agentic system.
2. Run the build in a container with no network.
3. Replace the directory target with a pull request, and compensation with a revert.
4. Authenticated approvers with roles.
5. A database-backed state store with a lock per run, and the audit head anchored externally.
