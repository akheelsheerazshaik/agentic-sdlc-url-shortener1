# Testing, limitations and trade-offs

## Approach

The system has two kinds of behaviour, and they are tested differently.

- **Deterministic behaviour** is tested directly and exhaustively: the engine, the gates, the policy rules, the tools, the metrics. This is where the guarantees live, so this is where most of the tests are.
- **Model behaviour** is not asserted on, because it is not reproducible. What is tested is the contract around it: that a reply of the wrong shape is rejected with a usable reason, that a rejection is fed back, that failure leads to fallback. The model is replaced by a recording or a stub.

The orchestrator's unit tests therefore never run a build and never call a model. They finish in a few seconds. The end-to-end tests run the real scenarios, including `npm ci` and the service's test suite, and take 20 to 75 seconds depending on the machine.

```bash
npm test             # type-check both packages, 272 + 189 unit tests
npm run test:e2e     # 9 end-to-end tests with real builds
npm run demo         # the scenarios through the CLI, for reading
```

## Orchestrator: 272 unit tests

| File | Tests | What it establishes |
| --- | --- | --- |
| `engine.test.ts` | 33 | Scheduling, parallelism and joins, gates, retries with backoff, fallback, rework loops and their bound, re-planning with early cutoff, approvals (before, after, voided on change, rejected, changes requested, clarification, interactive), separation of duties, kill switch, budgets, timeout, crash recovery, rollback order, incomplete rollback |
| `policy.test.ts` | 90 | Every rule, with cases that must be blocked and cases that must pass, including path traversal variants, disguised secrets, and SQL injection patterns |
| `gates.test.ts` | 29 | Every gate of the SDLC workflow, each with a failing and a passing input |
| `model.test.ts` | 26 | JSON extraction (including replies whose content contains code fences), schema validation, call metering, recording lookup, and the HTTP contract of the live gateway against a local server |
| `tools.test.ts` | 25 | Sandbox writes and their containment, diff, reset; command allowlist, scrubbed environment, timeout and abort; static code index; fault injection |
| `agents.test.ts` | 23 | Prompt construction, integration, policy review on the real workspace, the release checklist, promotion and its restore |
| `scenarios.test.ts` | 18 | Every recording parses against its schema and passes its gates, statically |
| `graph.test.ts` | 9 | Graph validation: cycles, unknown dependencies, duplicate producers, unreachable rework feedback |
| `audit.test.ts` | 7 | The hash chain detects edited, removed, reordered and forged events |
| `metrics.test.ts` | 7 | Each metric on hand-built event sequences, including the subtraction of human wait time |
| `live.test.ts` | 5 | Live mode through the HTTP gateway against a stand-in API: happy path, malformed reply, gate rejection fed back, API unreachable |

The engine tests run against small made-up graphs with fake agents. That is what makes it practical to test every recovery path, including ones that are hard to produce in a real run: a process that dies mid-stage, a compensation that itself fails, two branches in flight when a stop arrives.

## Orchestrator: 9 end-to-end tests

`test/e2e/scenarios.e2e.ts` drives real runs through the same API the CLI uses.

- The three scenarios in order against one target, asserting the checkpoints, the rework loop, the re-planning, and the artifact versions each produces.
- **The drift check:** the tree those three runs produce must hash the same as the checked-in `url-shortener/`. If a recording and the checked-in service diverge, this fails.
- Fallback after repeated failure.
- Rework budget exhausted: rollback, safe stop, target untouched.
- Promotion failing after it has written to the target: target restored, then an authorized retry completes without repeating the build or the approval.
- Release rejected: target untouched.
- Target changed while awaiting approval: promotion refuses.

## Service: 189 tests

The service's suite is what the `build-verify` stage runs, so it is part of the system's validation as well as its output.

- **Unit (106):** code generation, alias rules, URL rules, host rules across every reserved range and address notation, device classification with real User-Agent strings, the rate limiter with a controlled clock, the migrator, the click recorder.
- **API (83):** the whole application through `app.inject` against an in-memory database, with an injected clock and code generator.

Every acceptance criterion in the three specifications maps to named tests in this suite, and the release gate checks that mapping against the actual results.

Two tests were checked by removing the code they guard and confirming they fail: the past-expiry validation and the flush on shutdown.

## Validation built into every run

Separate from the test suites, each run validates its own output:

| Check | What it catches |
| --- | --- |
| Schema validation of every model reply | Malformed or incomplete output |
| `ambiguity-lint` | A specification that glosses over vague wording |
| `impact-grounded` | An impact report that names files that do not exist |
| Plan and design coverage gates | A requirement with no task, no test, or no design |
| Lane gates | An agent writing outside its lane, or an implementation editing tests |
| Type-check and the service's test suite | A change that does not work |
| Eleven policy rules on the real workspace | Secrets, unsafe code, personal data, untraceable changes, undeclared high-impact changes, disabled tests |
| REL-1 | Evidence that is about a different tree than the one being released |
| REL-4 | An acceptance criterion with no passing test |
| Promotion gates | A target that moved, or a workspace that changed after approval |

## Limitations

Stated plainly, most significant first.

**1. Live mode has never been run against a real model.**
The live gateway, the prompts and the retry-with-feedback loop are tested against a local stand-in server that returns recorded replies. That proves the wiring. It does not show whether a real model produces a specification that passes the gates, or code that compiles and passes tests, or how many rework loops that takes. The prompts have never been iterated against real output. This is the largest unknown in the system.

**2. In offline mode, the agents do not reason.**
Their replies are replayed. A person's clarification or change request changes which recording is used next (by generation), not what it says. If a person answers a question the recording does not anticipate, the `spec-consistency` gate fails the stage rather than pretending the answer was applied. Offline mode demonstrates the orchestration, not the agents.

**3. The build runs untrusted code on the host.**
The test suite is written by agents and executed with `npx vitest`. The command runner provides an allowlist, no shell, a scrubbed environment, timeouts and `--ignore-scripts`. It does not provide isolation. A malicious test could read the filesystem or use the network.

**4. Policy rules are pattern matches.**
They are regular expressions over text. They can be evaded by code written to evade them, and they can produce false positives. The secret scan knows a handful of formats. There is no dependency vulnerability or licence check.

**5. One process, one run, local files.**
State is a JSON file. Nothing prevents two processes from resuming the same run at once. There is no queue, no worker pool and no database.

**6. Approver identity is asserted, not authenticated.**
`--by alice` is taken at its word. The separation-of-duties check stops an agent identity from approving; it cannot stop a person from typing someone else's name.

**7. The audit log is tamper-evident only.**
Rewriting the whole file and recomputing the chain is undetectable without an external anchor.

**8. The target is a directory.**
Promotion copies files and rollback copies them back. There is no pull request, no deployment, no database migration of a live system. The `no-target-drift` gate detects a concurrent change and refuses; it does not merge.

**9. Rework has one shape.**
A failed build goes back to implementation and test design. There is no path back to architecture or requirements from a build failure; that takes a person requesting changes.

**10. Scale is untested.**
Prompts include whole files within a fixed character budget. A large codebase would need retrieval. Change sets carry whole files, not patches.

**11. Platform coverage.**
Developed and tested on Linux: x64 with Node.js 22.22 and arm64 with Node.js 22.23. It has not been run natively on macOS or Windows, and the command runner has a Windows branch that has never been executed.

**12. The service itself** has no authentication, runs as a single instance on SQLite, keeps click events indefinitely, loses buffered clicks on an abrupt kill, and judges destinations by URL text without resolving DNS. These are recorded as risks in the scenario designs and in `url-shortener/README.md`.

## Trade-offs

| Chose | Over | Gained | Gave up |
| --- | --- | --- | --- |
| A custom engine | Temporal, or an agent framework | The mechanics are visible, small and directly tested | Durability, timers, distribution |
| Recorded replies as the default | Live calls | Reproducible, free, exact assertions, no credentials needed | Evidence of real model behaviour |
| A fixed graph | A planner that emits the graph | Controls a model cannot remove | Flexibility to add stages per requirement |
| Whole-pipeline invalidation by hash | Hand-written rework routing | One mechanism for answers, change requests and failed builds | Some redundant re-execution; mitigated by early cutoff |
| Approvals bound to content hashes | An approved flag per stage | Sign-off cannot outlive the content it covered | A re-approval whenever content really changes |
| Tests written without the implementation | Tests written from the code | Tests that can catch a missed requirement | Tests and code can disagree for uninteresting reasons |
| Sandbox copy, then promote | Editing the target in place | Nothing reaches the target unverified or unapproved | Disk and time for the copy |
| Regular-expression policy rules | Syntax-tree analysis | Simple, fast, no dependencies | Precision |
| Change sets of whole files | Patches | Trivial to apply and to hash | Size; unsuitable for large files |
| `node:sqlite` in the service | `better-sqlite3`, PostgreSQL | No native build, no external service | An experimental-feature warning; single node |
| Node type stripping | A compile step | One command to run, no build output | Requires Node 22.18 or newer |
| Active time for latency and MTTR | Wall-clock time | Measures the automation, not how fast people answer | Not comparable with wall-clock figures elsewhere |
