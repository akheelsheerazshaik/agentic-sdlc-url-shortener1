# Scenarios

Three scenarios run in order against one target, each building on the last, followed by three failure demonstrations. `npm run demo` runs them all; the captured output is in [`evidence/`](../evidence/README.md).

| | Greenfield | Brownfield | Ambiguous |
| --- | --- | --- | --- |
| Requirement | Build a URL shortener | Add link expiry; fix clicks lost on restart | "Better insight into who is clicking" and "safer links" |
| Starting point | Nothing | The service from greenfield | The service from brownfield |
| Human checkpoints | Design, release | Design, release | Clarification, design (changes requested, then approved), release |
| Non-linear behaviour | None: the straight path | A failed build sends work back | Answers and a change request re-run upstream stages |
| Stage executions | 11 | 17 | 17 |
| Files changed | 32 added | 4 added, 10 modified | 6 added, 13 modified |
| Service tests at release | 88 | 113 | 189 |
| Audit events | 88 | 117 | 144 |

## What is recorded and what is real

The demo runs in offline mode. Read every scenario below with this in mind:

- **Recorded:** the content each model-backed agent returns: the specification, impact report, plan, design, the three change sets and the risk assessment. These files are in `scenarios/<name>/recorded/`. They were written in advance, with AI assistance.
- **Real:** everything that happens to that content. Schema validation, every gate, every policy rule, the dependency install, the type-check, the service's test suite, the pauses for a person, the rework loop, the re-planning, the promotion and the audit log are executed, not replayed.
- **Scripted:** the human decisions. The demo script makes them on the `cli` channel as `demo-requester` and `demo-reviewer`. In offline mode the content of a person's answer does not change what the next recording says; only live mode can respond to it.

Two things in the recordings are deliberate:

1. The first brownfield implementation omits one validation rule, so that the build fails for a real reason and the rework loop has something to do.
2. The greenfield design records "clicks buffered at shutdown are lost" as an accepted risk, which the brownfield requirement then reports as a defect.

One thing was not deliberate. While these scenarios were being built, the `ambiguity-lint` gate rejected the first recorded specification for the ambiguous scenario: the requirement says "can we get something in soon", and the specification had recorded an ambiguity for "soon" but not for "something". The recording was corrected. The gate did what it is for.

---

## 1. Greenfield: build the URL shortener

Requirement: [`scenarios/01-greenfield/requirement.md`](../scenarios/01-greenfield/requirement.md). Core API (create, redirect, look up), analytics (total clicks, clicks per day, top referrers), reliability (rate limiting, click recording that never slows a redirect, health endpoints, clean errors), on TypeScript with no external services.

### Understanding

The requirement is well defined, and the specification still records five ambiguities. None blocks, because each has a safe default and none changes the data model in a way that is costly to undo. Each default is stored as a decision with its alternatives.

| | Term | Default assumption |
| --- | --- | --- |
| Q-1 | "top referrers" | Top 10 by host. Only the host is stored, because a full referrer URL can carry personal data |
| Q-2 | "clicks per day" | UTC days, last 30 days |
| Q-3 | "limit how fast one client can create links" | Per client address, burst 20, 1 per second, configurable |
| Q-4 | "redirects to the original URL" | 302 with no-store, because a cached 301 would bypass click counting |
| Q-5 | "the caller" | No authentication in this version; recorded as a risk and a limitation |

Eight functional requirements with 17 acceptance criteria, and four non-functional requirements.

### Decomposition

| Task | Lane | Title | Depends on |
| --- | --- | --- | --- |
| T-1 | code | Project skeleton and validated configuration | - |
| T-2 | code | Database access and migrations | T-1 |
| T-3 | code | Domain rules: codes, aliases, destination URLs, errors | T-1 |
| T-4 | code | Link repository and service | T-2, T-3 |
| T-5 | code | Click recording and statistics | T-2 |
| T-6 | code | HTTP layer: routes, rate limiter, error rendering, server | T-4, T-5 |
| T-7 | test | Unit tests for the domain rules and components | - |
| T-8 | test | API tests for every acceptance criterion | - |
| T-9 | docs | README and OpenAPI contract | - |

The plan gates confirmed that the tasks have no dependency cycle and that every functional requirement has both a code task and a test task.

### Orchestration

1. `requirements`, then `planning`. `impact-analysis` is **skipped**: there is no existing code.
2. `architecture` produces the design with eight decisions and six risks. Its envelope declares a new schema, a new API and five dependencies, so the run **pauses for design approval** and the process exits.
3. After approval, a new process resumes. `implementation`, `test-design` and `documentation` run **in parallel**.
4. `integrate` waits for all three, then applies 32 files to the sandbox.
5. `build-verify` and `policy-review` run **in parallel** on the result.
6. `release-readiness` computes the checklist and **pauses for release sign-off**.
7. After approval, `promote` writes the service to the target.

### Validation

- **Build:** type-check passes, 88 of 88 tests pass.
- **Policy:** 11 rules, none blocking. Six need approval: one new migration and five new dependencies. All six were declared in the approved design's envelope, so CHG-005 passes, and they are listed for the release approver.
- **Traceability:** all 17 acceptance criteria are proven by named tests that ran and passed (REL-4).
- **Release checklist:** six of six.

### Outcome

The first version of the service. Evidence: [`evidence/greenfield/`](../evidence/greenfield/README.md).

---

## 2. Brownfield: link expiry, and clicks lost on restart

Requirement: [`scenarios/02-brownfield/requirement.md`](../scenarios/02-brownfield/requirement.md). An enhancement (links can expire; an expired link says so; its stats stay readable) and a defect (BUG-17: clicks arriving just before a restart never appear in the stats), with the constraint that existing links, clients and data keep working.

### Understanding

Five functional requirements with 13 acceptance criteria. Five ambiguities, none blocking. Two are worth noting:

- **Q-4, may an expired alias be reused?** Default: no. Otherwise anyone could register the alias of a link people already trust.
- **Q-5, must the fix survive an abrupt kill?** Default: no, graceful shutdown only. A deployment is a graceful shutdown. Surviving a kill would mean writing every click before the redirect returns, which contradicts the existing requirement that recording never slows a redirect. The remaining loss is documented.

### Codebase reasoning

`impact-analysis` runs this time. From the code index it reports:

- **Six source modules to change**, each with a reason: the link repository, link service, error catalogue and routes for expiry; the click recorder and application wiring for BUG-17.
- **The root cause of BUG-17:** the click recorder's buffer is written only by its timer, and the application's close hook stops the timer without writing what is left.
- **Two existing tests that must change**, including one that compares a whole response body and would break on an added field.
- **Changed data flows** for redirect and for shutdown.
- **A regression surface of 11 modules** (5 source, 6 test), computed from the import graph, not by the model: everything that imports what is being changed, including the existing tests that guard it.

The `impact-grounded` gate checked every path against the code index: each "impacted" module exists and each "new" module does not.

### Decomposition

| Task | Lane | Title | Depends on |
| --- | --- | --- | --- |
| T-1 | code | Migration: nullable `expires_at` on links | - |
| T-2 | code | Store and read the expiry | T-1 |
| T-3 | code | Expiry rules in the link service | T-2 |
| T-4 | code | Expiry in the HTTP API | T-3 |
| T-5 | code | BUG-17: flush buffered clicks on shutdown | - |
| T-6 | test | Tests for link expiry and compatibility | - |
| T-7 | test | Regression tests for BUG-17 | - |
| T-8 | docs | Update the README and the OpenAPI contract | - |

### Orchestration

The path is not linear this time.

1. `requirements` → `impact-analysis` → `planning` → `architecture`. The design declares a schema change and an additive API change: **design approval**.
2. The three lanes run in parallel and `integrate` applies 14 files.
3. `build-verify` runs the suite. **Two tests fail:**

   ```
   test/integration/expiry.api.test.ts > rejects an expiry in the past with 400: expected 201 to be 400
   test/integration/expiry.api.test.ts > rejects an expiry equal to now with 400: expected 201 to be 400
   ```

   The implementation accepted an expiry in the past. The test lane, working from acceptance criterion AC-1.3 without sight of the implementation, had a test for it.
4. The `build-green` gate fails. The stage declares rework, so the engine publishes the failures as a `build-feedback` artifact (loop 1 of 2).
5. `implementation` and `test-design` consume that artifact, so their fingerprints change and both are **invalidated and re-run**.
   - `implementation` returns a corrected link service: `code-changes` v2.
   - `test-design` returns the same tests. The hash is unchanged, so no new version is published.
6. `integrate` re-runs because the code changed. `policy-review` re-runs because the workspace changed. `documentation` is untouched.
7. `build-verify` runs again: 113 of 113 pass.
8. **Release sign-off**, then `promote`.

The lineage of the final test report shows the loop:

```
test-report v2 by agent:build-verifier (build-verify, generation 2)
  workspace-state v2 by agent:integrator (integrate, generation 2)
    code-changes v2 by agent:implementation (implementation, generation 2)
      build-feedback v1 by orchestrator (build-verify, generation 1)
        workspace-state v1 by agent:integrator (integrate, generation 1)
          code-changes v1 by agent:implementation (implementation, generation 1)
            design v1 ...
```

### Validation

- **Build:** the first build is kept as a rejected artifact with its two failures; the second passes 113 of 113.
- **Policy:** none blocking. One item needs approval: migration `002_link_expiry.sql`, declared in the approved envelope. Migration `001` is untouched, which CHG-001 would have blocked otherwise.
- **Traceability:** 13 of 13 acceptance criteria proven, including AC-5.1 by a test that inserts a row in the pre-migration shape and checks it still redirects.
- **Regression:** the 88 existing tests still pass. One was changed, by the test lane, to expect the added response field.
- **Release record:** the rollback plan notes that the previous version runs correctly against the migrated database, so rolling the code back does not require rolling the schema back.

### Outcome

Expiry and the shutdown fix. Evidence: [`evidence/brownfield/`](../evidence/brownfield/README.md); the earlier failed build is in `verification.md`.

---

## 3. Ambiguous: safer links, better insight

Requirement, in full:

> Marketing wants better insight into who is clicking our links. Security also says our short links need to be safer. Can we get something in soon?

### Understanding

This requirement cannot be built as written. The specification records five ambiguities and marks three as **blocking**:

| | Term | Why it blocks |
| --- | --- | --- |
| Q-1 | "who is clicking" | Individual visitors or the audience in aggregate? Identifying visitors means storing personal data: a different data model, a privacy review, and hard to undo once collected |
| Q-3 | "safer" | Against unsafe destinations, against abuse of the API, or against people guessing links? Three unrelated pieces of work |
| Q-5 | "our short links" | New links only, or existing ones too? Covering existing links means checking at redirect time and can stop links that work today |

Two do not block and proceed on a default: Q-2 ("better insight": add a device breakdown) and Q-4 ("get something in soon": the smallest slice that delivers both asks).

The `ambiguity-lint` gate confirmed that every vague word in the requirement (`better`, `insight`, `safer`, `something`, `soon`) is quoted in a recorded ambiguity.

### Orchestration

1. `requirements` produces the provisional specification. Three blocking questions are open, so the run **pauses for clarification** before any design work. Nothing downstream has started.
2. A person answers (`sdlc clarify`):
   - Q-1: aggregate only; nothing that identifies a visitor may be stored.
   - Q-3: unsafe destinations; API abuse is a separate project.
   - Q-5: existing links too.

   The answers are published as a `clarifications` artifact. That changes the fingerprint of `requirements`, which re-runs (generation 2) and produces a specification with four functional requirements and no open questions. The `spec-consistency` gate checks that every answer was applied.
3. `impact-analysis` → `planning` → `architecture`. The design declares a schema change, an additive API change and that it **touches personal data**, because it reads the `User-Agent` header. The run **pauses for design approval**.
4. The reviewer does not approve. They **request a change**: "Bots must not inflate campaign numbers: report bot and non-bot clicks separately in the stats."
5. The request is published as a `change-requests` artifact, which `requirements` consumes. Re-planning follows:
   - `requirements` re-runs (generation 3): a fifth requirement, FR-5.
   - `impact-analysis` re-runs and returns the same report. **Unchanged, so not republished.**
   - `planning` re-runs (generation 2): tasks now cover FR-5.
   - `architecture` re-runs (generation 2): a sixth decision, ADR-6. The rejected design is kept as a rejected artifact.
6. The new design is a different hash, so it needs its own approval. The reviewer **approves**.
7. The three lanes, `integrate`, then `build-verify` and `policy-review` in parallel, **release sign-off**, `promote`.

Four human decisions in total, each recorded with who, when, on which content hash, and why.

### Decomposition (final plan)

| Task | Lane | Title | Depends on |
| --- | --- | --- | --- |
| T-1 | code | Migration: `device_class` on click events | - |
| T-2 | code | Host rules and destination validation | - |
| T-3 | code | `DENIED_HOSTS` configuration | T-2 |
| T-4 | code | Enforce the destination rules on redirect | T-2, T-3 |
| T-5 | code | Classify the device and record it with each click | T-1 |
| T-6 | code | Device breakdown in statistics, with bot and non-bot totals | T-5 |
| T-7 | test | Tests for destination safety | - |
| T-8 | test | Tests for device analytics | - |
| T-9 | docs | Update the README and the OpenAPI contract | - |

### Validation

- **Build:** 189 of 189 tests pass.
- **Policy:** none blocking. This is the scenario where the compliance rule matters. CMP-001 would block a migration that adds a `user_agent` or `ip_address` column, or code that logs either. The change stores a five-value device class instead, and a test asserts the exact columns of the click table.
- **Traceability:** 14 of 14 acceptance criteria proven.
- **Design decisions worth reading** in `evidence/ambiguous/plan-and-design.md`:
  - ADR-1: judge a destination by its text, without resolving DNS, and what that does not catch.
  - ADR-4: store a coarse device class, never the `User-Agent`.
  - ADR-6: report `botClicks` and `nonBotClicks` beside `totalClicks`, and leave the total's meaning alone. The second figure is named `nonBotClicks`, not `humanClicks`, because it includes clicks of unknown class and bots that pose as browsers.

### Outcome

The service as checked in under `url-shortener/`. The end-to-end test asserts that the tree these three runs produce is byte-for-byte that directory. Evidence: [`evidence/ambiguous/`](../evidence/ambiguous/README.md).

---

## Failure demonstrations

These use fault injection (`--fault`) and a zero rework budget to force paths that a healthy run does not take. Each is also asserted in `orchestrator/test/e2e/scenarios.e2e.ts`.

### A. Fallback: an agent that keeps failing

`--fault planning=error:always`. The planning agent throws on every call.

```
✘ planning: attempt 1 failed, retrying: injected fault: agent unavailable
✘ planning: attempt 2 failed: injected fault: agent unavailable
↪ planning: switching to fallback agent agent:planning:fallback
✔ planning: succeeded
```

The run continues to the design checkpoint. The plan artifact records that the fallback agent produced it.

### B. Rework budget exhausted: roll back and stop

Brownfield with `--max-reworks 0`. The first build fails as in scenario 2, but there is no budget to send it back.

```
✘ build-verify: exit gate "build-green" failed: test failed: ... rejects an expiry in the past with 400 ...
⏪ rolling back: integrate
Run failure-no-rework: SAFE_STOPPED. Stage "build-verify" failed: ... still failing after 0 rework loop(s) ...
```

The sandbox is reset to the baseline. The target was never touched.

### C. Promotion fails half-way: restore, then an authorized retry

Brownfield with `--fault promote=error-after:1`: the promotion stage copies the files into the target and then fails.

1. Both approvals are given. `promote` backs up the target, copies the workspace over it, and the fault fires.
2. The engine runs compensations in reverse order: `promote` restores the target from its backup, `integrate` resets the sandbox. The run is `SAFE_STOPPED`. The target is byte-for-byte what it was.
3. A plain `resume` is refused. A stopped run needs a person.
4. `resume --retry --by demo-reviewer` records who authorized the retry. `integrate` re-applies the change and produces the same tree hash. `build-verify`, `policy-review` and `release-readiness` are therefore **reused**, the existing release approval still matches, and only `promote` runs.

The build ran twice in this run (the two rework generations) and not a third time. The release was approved once.

### Also covered by tests, not by the demo

- **Rejection at release**: the run rolls back and the target stays untouched.
- **Target drift**: the target is edited while the release waits for sign-off; promotion refuses, and the edit is preserved.
- **Kill switch**, **budget exhaustion**, **timeout**, **crash recovery**, and **an approval voided by a content change**: `orchestrator/test/engine.test.ts`.
- **A policy block sending work back**: `policy-review` has a rework loop of one. Running the ambiguous scenario against the wrong baseline triggers it (CHG-001: the migration number is not the next in sequence), and after one loop the run rolls back and stops.

## Reliability metrics from the demo

From `evidence/metrics.json`, across the six runs above. Durations vary from run to run; the counts do not.

| Metric | Value | Note |
| --- | --- | --- |
| Runs | 6, of which 5 finished | `failure-fallback` is left waiting at its design checkpoint |
| Success rate | 80% | 4 of 5; `failure-no-rework` stops by design |
| Retry rate | 1.3% of stage executions | The injected planning fault |
| Rework loops per run | 0.33 | Brownfield, and the promotion-failure run |
| Rollback frequency | 40% of finished runs | The two rollback demonstrations |
| MTTR | about 1 s over 4 recoveries, 1 unresolved | Active time; the unresolved one is the run that stops by design |
| End-to-end latency | p50 about 2 s, p95 about 4.5 s | Active time, succeeded runs; dominated by the build |

These numbers describe a demo that injects failures on purpose. They show that the metrics are computed, not how reliable the system is.
