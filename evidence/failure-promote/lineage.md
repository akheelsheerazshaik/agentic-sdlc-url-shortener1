# Decisions, lineage and timeline

## Decisions made by agents

| Stage | Gen | Decision | Rationale | Alternatives considered |
| --- | --- | --- | --- | --- |
| requirements | 1 | "told the link has expired rather than that it never existed": 410 Gone as a problem document with code link_expired, consistent with the API's existing error format. | Default assumption. It is a public contract that clients and monitoring will depend on. | 410 Gone with error code link_expired; 404 with a different message; An HTML page explaining the expiry |
| requirements | 1 | "After that moment": The link is expired from its expiry instant onwards. | Default assumption. The boundary has to be defined for the tests to be exact and for clients to predict behaviour. | Expired from the instant onwards; Still valid at the instant, expired after it |
| requirements | 1 | "a time-to-live in seconds": A positive whole number of seconds, at most five years. | Default assumption. An unbounded integer invites overflow and nonsensical dates. | Maximum of five years; No maximum |
| requirements | 1 | "must no longer redirect": The alias stays reserved, to prevent takeover of an expired link. | Default assumption. If it can, someone else can register the alias of a link people already trust and send its visitors anywhere. | The alias stays reserved; The alias becomes available again |
| requirements | 1 | "just before a restart": Graceful shutdown only, which is what a deployment is. Loss on an abrupt kill remains and is documented. | Default assumption. A deployment sends SIGTERM and is a graceful shutdown. Surviving an abrupt kill needs every click written durably before the redirect returns, which contradicts the existing requirement that recording a click never slows a redirect. | Graceful shutdown only; Also survive a crash, by writing each click synchronously |
| planning | 1 | Deliver in 8 tasks | Two independent slices. Expiry goes in dependency order: schema, repository, service, HTTP. The shutdown fix is confined to the click recorder and the application's close hook. The tests are written from the acceptance criteria in parallel, including regression tests that fail on the current code for BUG-17. | - |
| architecture | 1 | ADR-1 Enforce expiry when resolving, and keep the row: Store the expiry on the link and compare it with the current time in LinkService.resolve. Expired rows are not deleted. | The owner must still read the stats of an expired link, and the visitor must be told it expired rather than that it never existed. Both need the row to remain. The check reuses the row the redirect already loads. | A background job that deletes expired links: loses the statistics and turns expiry into a 404; Filter expired rows in the SQL WHERE clause: cannot tell expired from unknown, so it cannot answer 410 |
| architecture | 1 | ADR-2 410 Gone with a link_expired code: An expired link's redirect answers 410 as a problem document with code link_expired, and sends no Location header. | 410 is the HTTP status for a resource that existed and is intentionally gone, and it keeps the response in the API's existing error format. | 404: indistinguishable from a mistyped link; An HTML explanation page: a new presentation concern for an API service |
| architecture | 1 | ADR-3 Two input forms, one stored form: Accept expiresAt or ttlSeconds but not both, require a time zone on expiresAt, require the result to be in the future, cap ttlSeconds at five years, and store a UTC instant. | Campaigns end at a known time; temporary links are easier to express as a duration. Normalizing to one UTC value means the rest of the system handles a single representation. Requiring a zone avoids guessing which local time the caller meant. | Only expiresAt: forces clients to compute a timestamp for simple cases; Accept local times without a zone: ambiguous |
| architecture | 1 | ADR-4 An expired alias stays reserved: Creating a link with the alias of an expired link returns 409 as before. | Reuse would let anyone take over a link that is already printed, shared or bookmarked. | Release the alias on expiry: convenient for owners, unsafe for visitors |
| architecture | 1 | ADR-5 Fix BUG-17 by flushing in the close hook: ClickRecorder.close stops the timer and flushes. The onClose hook calls it inside a try/catch that logs how many events were lost if the flush fails. | It removes the loss for every graceful shutdown, which is what a deployment is, without touching the redirect path. A failing final flush must not turn a shutdown into a hang. | Write each click synchronously in the redirect: also survives a crash, but breaks the requirement that recording never slows a redirect; Shorten the flush interval: narrows the window, does not close it |

## Artifact versions

| Artifact | Version | Status | Hash | Produced by | Stage (generation) |
| --- | --- | --- | --- | --- | --- |
| requirement | v1 | accepted | `5cfa836f8989` | requester | run-creation (0) |
| baseline-index | v1 | accepted | `fce56ec2be03` | orchestrator | run-creation (0) |
| requirement-spec | v1 | accepted | `7923bb6d3661` | agent:requirements | requirements (1) |
| impact-report | v1 | accepted | `653c7e9a2676` | agent:impact-analysis | impact-analysis (1) |
| plan | v1 | accepted | `50739c6147d7` | agent:planning | planning (1) |
| design | v1 | accepted | `8e8ba307ceea` | agent:architecture | architecture (1) |
| code-changes | v1 | accepted | `21697a8421fa` | agent:implementation | implementation (1) |
| code-changes | v2 | accepted | `0d2a345353e1` | agent:implementation | implementation (2) |
| doc-changes | v1 | accepted | `bc39411227bc` | agent:documentation | documentation (1) |
| test-changes | v1 | accepted | `fc1e36687122` | agent:test-design | test-design (1) |
| workspace-state | v1 | accepted | `766d5ee2bc65` | agent:integrator | integrate (1) |
| workspace-state | v2 | accepted | `1981e3641d45` | agent:integrator | integrate (2) |
| policy-report | v1 | accepted | `b7529a0c45ee` | agent:policy-reviewer | policy-review (1) |
| policy-report | v2 | accepted | `fba3f7805061` | agent:policy-reviewer | policy-review (2) |
| test-report | v1 | rejected | `0d20a900c237` | agent:build-verifier | build-verify (1) |
| test-report | v2 | accepted | `94a1818ea52a` | agent:build-verifier | build-verify (2) |
| build-feedback | v1 | accepted | `673d25637e58` | orchestrator | build-verify (1) |
| release-record | v1 | accepted | `f925e9aa2109` | agent:release-manager | release-readiness (1) |
| promotion-record | v1 | accepted | `f95bd04a4672` | agent:promoter | promote (1) |

## Lineage of `promotion-record`

Each line was derived from the lines indented beneath it. A line ending in … is expanded where it first appears.

```
promotion-record v1 [f95bd04a4672] by agent:promoter (promote, generation 1)
  release-record v1 [f925e9aa2109] by agent:release-manager (release-readiness, generation 1)
    design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1)
      impact-report v1 [653c7e9a2676] by agent:impact-analysis (impact-analysis, generation 1)
        baseline-index v1 [fce56ec2be03] by orchestrator (run-creation, generation 0)
        requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1)
          baseline-index v1 [fce56ec2be03] by orchestrator (run-creation, generation 0) …
          requirement v1 [5cfa836f8989] by requester (run-creation, generation 0)
      plan v1 [50739c6147d7] by agent:planning (planning, generation 1)
        impact-report v1 [653c7e9a2676] by agent:impact-analysis (impact-analysis, generation 1) …
        requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
      requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
    policy-report v2 [fba3f7805061] by agent:policy-reviewer (policy-review, generation 2)
      design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
      plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
      workspace-state v2 [1981e3641d45] by agent:integrator (integrate, generation 2)
        code-changes v2 [0d2a345353e1] by agent:implementation (implementation, generation 2)
          build-feedback v1 [673d25637e58] by orchestrator (build-verify, generation 1)
            workspace-state v1 [766d5ee2bc65] by agent:integrator (integrate, generation 1)
              code-changes v1 [21697a8421fa] by agent:implementation (implementation, generation 1)
                design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
                impact-report v1 [653c7e9a2676] by agent:impact-analysis (impact-analysis, generation 1) …
                plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
                requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
              design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
              doc-changes v1 [bc39411227bc] by agent:documentation (documentation, generation 1)
                design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
                impact-report v1 [653c7e9a2676] by agent:impact-analysis (impact-analysis, generation 1) …
                plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
                requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
              plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
              test-changes v1 [fc1e36687122] by agent:test-design (test-design, generation 2, unchanged from an earlier generation)
                build-feedback v1 [673d25637e58] by orchestrator (build-verify, generation 1) …
                design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
                impact-report v1 [653c7e9a2676] by agent:impact-analysis (impact-analysis, generation 1) …
                plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
                requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
          design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
          impact-report v1 [653c7e9a2676] by agent:impact-analysis (impact-analysis, generation 1) …
          plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
          requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
        design v1 [8e8ba307ceea] by agent:architecture (architecture, generation 1) …
        doc-changes v1 [bc39411227bc] by agent:documentation (documentation, generation 1) …
        plan v1 [50739c6147d7] by agent:planning (planning, generation 1) …
        test-changes v1 [fc1e36687122] by agent:test-design (test-design, generation 2, unchanged from an earlier generation) …
    requirement-spec v1 [7923bb6d3661] by agent:requirements (requirements, generation 1) …
    test-changes v1 [fc1e36687122] by agent:test-design (test-design, generation 2, unchanged from an earlier generation) …
    test-report v2 [94a1818ea52a] by agent:build-verifier (build-verify, generation 2)
      workspace-state v2 [1981e3641d45] by agent:integrator (integrate, generation 2) …
    workspace-state v2 [1981e3641d45] by agent:integrator (integrate, generation 2) …
  workspace-state v2 [1981e3641d45] by agent:integrator (integrate, generation 2) …
```

## Timeline

Selected events from `audit.jsonl`.

| # | Time | Event | Stage | Actor | Detail |
| --- | --- | --- | --- | --- | --- |
| 1 | 00:56:53.101 | RUN_CREATED |  | engine:orchestrator | scenario: brownfield · mode: offline |
| 4 | 00:56:53.105 | RUN_STARTED |  | engine:orchestrator |  |
| 16 | 00:56:53.110 | STAGE_SUCCEEDED | requirements | engine:orchestrator |  |
| 21 | 00:56:53.113 | STAGE_SUCCEEDED | impact-analysis | engine:orchestrator |  |
| 28 | 00:56:53.115 | STAGE_SUCCEEDED | planning | engine:orchestrator |  |
| 38 | 00:56:53.117 | APPROVAL_REQUESTED | architecture | engine:orchestrator | reasons: The design changes the database schema.; The design changes the public API (additive). · kind: approval |
| 39 | 00:56:53.117 | RUN_PAUSED |  | engine:orchestrator | waitingOn: architecture |
| 40 | 00:56:53.213 | APPROVAL_RECORDED | architecture | human:demo-reviewer | decision: approved |
| 42 | 00:56:53.213 | STAGE_SUCCEEDED | architecture | engine:orchestrator |  |
| 43 | 00:56:53.300 | RUN_RESUMED |  | engine:orchestrator |  |
| 55 | 00:56:53.312 | STAGE_SUCCEEDED | implementation | engine:orchestrator |  |
| 57 | 00:56:53.312 | STAGE_SUCCEEDED | documentation | engine:orchestrator |  |
| 59 | 00:56:53.312 | STAGE_SUCCEEDED | test-design | engine:orchestrator |  |
| 64 | 00:56:53.324 | STAGE_SUCCEEDED | integrate | engine:orchestrator |  |
| 69 | 00:56:53.329 | STAGE_SUCCEEDED | policy-review | engine:orchestrator |  |
| 72 | 00:56:55.350 | REWORK_REQUESTED | build-verify | engine:orchestrator | failures: [build-green] test failed: test/integration/expiry.api.test.ts > link expiry creating a link rejects an expiry in the past with 400: AssertionError: expected 201 to be 400 // Object.is equality; [build-green... |
| 73 | 00:56:55.351 | STAGE_INVALIDATED | implementation | engine:orchestrator | reason: inputs changed · changedInputs: build-feedback |
| 74 | 00:56:55.351 | STAGE_INVALIDATED | test-design | engine:orchestrator | reason: inputs changed · changedInputs: build-feedback |
| 83 | 00:56:55.354 | STAGE_SUCCEEDED | implementation | engine:orchestrator |  |
| 84 | 00:56:55.354 | ARTIFACT_UNCHANGED | test-design | agent:test-design | name: test-changes |
| 85 | 00:56:55.354 | STAGE_SUCCEEDED | test-design | engine:orchestrator |  |
| 86 | 00:56:55.354 | STAGE_INVALIDATED | integrate | engine:orchestrator | reason: inputs changed · changedInputs: code-changes |
| 91 | 00:56:55.363 | STAGE_SUCCEEDED | integrate | engine:orchestrator |  |
| 92 | 00:56:55.364 | STAGE_INVALIDATED | policy-review | engine:orchestrator | reason: inputs changed · changedInputs: workspace-state |
| 97 | 00:56:55.367 | STAGE_SUCCEEDED | policy-review | engine:orchestrator |  |
| 100 | 00:56:57.428 | STAGE_SUCCEEDED | build-verify | engine:orchestrator |  |
| 105 | 00:56:57.431 | APPROVAL_REQUESTED | release-readiness | engine:orchestrator | reasons: Release sign-off for CHG-failure-promote: 4 added, 10 modified, 0 deleted; 113/113 tests pass.; High impact: CHG-001 migrations/002_link_expiry.sql: adds a database migration · kind: approval |
| 106 | 00:56:57.432 | RUN_PAUSED |  | engine:orchestrator | waitingOn: release-readiness |
| 107 | 00:56:57.547 | APPROVAL_RECORDED | release-readiness | human:demo-reviewer | decision: approved |
| 109 | 00:56:57.547 | STAGE_SUCCEEDED | release-readiness | engine:orchestrator |  |
| 110 | 00:56:57.640 | RUN_RESUMED |  | engine:orchestrator |  |
| 114 | 00:56:57.655 | STAGE_ATTEMPT_FAILED | promote | agent:promoter | error: injected fault: failure after the action was performed |
| 115 | 00:56:57.655 | STAGE_FAILED | promote | engine:orchestrator | error: all attempts failed. Last error: injected fault: failure after the action was performed |
| 116 | 00:56:57.655 | ROLLBACK_STARTED |  | engine:orchestrator | stages: promote; integrate |
| 117 | 00:56:57.660 | COMPENSATION_EXECUTED | promote | engine:orchestrator |  |
| 118 | 00:56:57.662 | COMPENSATION_EXECUTED | integrate | engine:orchestrator |  |
| 119 | 00:56:57.662 | RUN_SAFE_STOPPED |  | engine:orchestrator | reason: Stage "promote" failed: all attempts failed. Last error: injected fault: failure after the action was performed |
| 120 | 00:56:57.841 | RETRY_AUTHORIZED |  | human:demo-reviewer |  |
| 121 | 00:56:57.842 | RUN_RESUMED |  | engine:orchestrator |  |
| 125 | 00:56:57.857 | ARTIFACT_UNCHANGED | integrate | agent:integrator | name: workspace-state |
| 126 | 00:56:57.858 | STAGE_SUCCEEDED | integrate | engine:orchestrator |  |
| 127 | 00:56:57.858 | STAGE_REUSED | build-verify | engine:orchestrator | reason: upstream re-ran but this stage's inputs are unchanged |
| 128 | 00:56:57.858 | STAGE_REUSED | policy-review | engine:orchestrator | reason: upstream re-ran but this stage's inputs are unchanged |
| 129 | 00:56:57.858 | STAGE_REUSED | release-readiness | engine:orchestrator | reason: upstream re-ran but this stage's inputs are unchanged |
| 135 | 00:56:57.864 | STAGE_SUCCEEDED | promote | engine:orchestrator |  |
| 136 | 00:56:57.864 | RUN_SUCCEEDED |  | engine:orchestrator |  |
