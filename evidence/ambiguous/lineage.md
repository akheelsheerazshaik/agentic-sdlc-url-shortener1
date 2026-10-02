# Decisions, lineage and timeline

## Decisions made by agents

| Stage | Gen | Decision | Rationale | Alternatives considered |
| --- | --- | --- | --- | --- |
| requirements | 1 | "better insight": Add a breakdown by device type (desktop, mobile, tablet, bot, unknown). It is the smallest addition that says something about the audience and needs no personal data. | Default assumption. It sets the scope of the analytics work and what must be stored per click. | Breakdown by device type; Breakdown by browser and operating system; Hourly breakdown; Conversion tracking on the destination site |
| requirements | 1 | "get something in soon": The smallest slice that delivers both asks, in the next release, with the rest recorded as follow-ups. | Default assumption. It decides whether to build the smallest useful version or wait for a complete one. | Smallest useful slice in the next release; Complete solution, later |
| requirements | 2 | "who is clicking": Aggregate only. We must not store anything that identifies a visitor: no IP addresses, no raw user agents, no visitor IDs. | Answered by a person. Identifying visitors means storing personal data such as IP addresses or persistent identifiers. That is a different data model, a privacy review, and it is costly to undo once the data has been collected. Aggregate figures need none of that. | Aggregate only: no data that identifies a visitor; Per-visitor: unique and returning visitors, which needs a stored identifier; Per-visitor with location, which needs the client address |
| requirements | 2 | "better insight": Add a breakdown by device type (desktop, mobile, tablet, bot, unknown). It is the smallest addition that says something about the audience and needs no personal data. | Default assumption. It sets the scope of the analytics work and what must be stored per click. | Breakdown by device type; Breakdown by browser and operating system; Hourly breakdown; Conversion tracking on the destination site |
| requirements | 2 | "safer": Unsafe destinations. The concern is links that send people to malicious sites or to internal addresses. API abuse is a separate project. | Answered by a person. These are three unrelated pieces of work: destination rules, authentication and quotas, or code entropy and access control. Building the wrong one leaves the reported problem in place. | Unsafe destinations: block malicious and internal targets; API abuse: authentication and stricter limits; Link privacy: harder-to-guess codes, access control on stats |
| requirements | 2 | "get something in soon": The smallest slice that delivers both asks, in the next release, with the rest recorded as follow-ups. | Default assumption. It decides whether to build the smallest useful version or wait for a complete one. | Smallest useful slice in the next release; Complete solution, later |
| requirements | 2 | "our short links": Existing links too. If a destination is denied later, the old link must stop redirecting. | Answered by a person. Applying rules to existing links means checking at redirect time and can stop links that work today. Not applying them leaves every existing unsafe link live. | New links only; Existing links too, enforced when they are followed |
| planning | 1 | Deliver in 9 tasks | Two slices that share only the redirect route. Destination safety: a pure host-rules module, used by URL validation on create and again when a link is resolved. Device analytics: schema first, then classify at the route, record, aggregate. Tests are written from the acceptance criteria in parallel with the code. | - |
| architecture | 1 | ADR-1 Judge a destination by its text, without resolving DNS: Parse the URL and test its host: address literals against the non-public ranges, names against localhost, single-label and internal suffixes, and the operator's denylist. No DNS lookup is made. | The standard URL parser already turns disguised forms such as 2130706433 or 0x7f.1 into a dotted address, so a text check catches them. A DNS lookup would put a network call driven by user input on both the create and the redirect path, and the answer can change between the check and the visit. | Resolve the name and check the addresses: catches public names pointing at private addresses, at the cost of latency, a network dependency and a time-of-check gap; Call a reputation service: an external dependency, and it sends every submitted URL to a third party |
| architecture | 1 | ADR-2 Re-check the destination on every redirect: LinkService.resolve applies the same rules to the stored URL that create applies to a new one. | The requester confirmed that existing links must be covered. Checking at redirect time means a denylist change takes effect immediately for every link, with no migration or batch job, and it costs one URL parse on a row already loaded. | A one-off job that marks existing links as blocked: has to be re-run on every denylist change, and adds state that can go stale; Check only on create: leaves every existing unsafe link live |
| architecture | 1 | ADR-3 A blocked link answers 410 with link_blocked and reveals nothing: Return 410 as a problem document with code link_blocked, no Location header, and a message that does not contain the destination. | It matches how an expired link is reported, so clients handle one more code rather than a new mechanism. Withholding the destination avoids advertising the unsafe URL. | An interstitial warning page with a continue button: still delivers people to the destination; 404: hides from the owner that the link was blocked rather than lost |
| architecture | 1 | ADR-4 Store a coarse device class, never the User-Agent: Classify the header in memory at the redirect route into one of five classes and store only that class with the click. | The requester confirmed that nothing identifying a visitor may be stored. A raw User-Agent, especially combined with a timestamp and a referrer, can single out a person; one of five class names cannot. | Store the header and classify when reporting: flexible, but holds personal data; Store a hash of address and User-Agent to count unique visitors: a persistent visitor identifier, ruled out by Q-1 |
| architecture | 1 | ADR-5 Classify with a small set of patterns in-process: A handful of regular expressions over the first 512 characters of the header, with bots tested first. | Five coarse classes do not need a device database. No new dependency enters the build, and bounding the inspected length bounds the cost of an oversized header. | A User-Agent parsing library: more accurate for browser and OS detail nobody asked for, and a new dependency to approve and keep patched |
| requirements | 3 | "who is clicking": Aggregate only. We must not store anything that identifies a visitor: no IP addresses, no raw user agents, no visitor IDs. | Answered by a person. Identifying visitors means storing personal data such as IP addresses or persistent identifiers. That is a different data model, a privacy review, and it is costly to undo once the data has been collected. Aggregate figures need none of that. | Aggregate only: no data that identifies a visitor; Per-visitor: unique and returning visitors, which needs a stored identifier; Per-visitor with location, which needs the client address |
| requirements | 3 | "better insight": Add a breakdown by device type (desktop, mobile, tablet, bot, unknown). It is the smallest addition that says something about the audience and needs no personal data. | Default assumption. It sets the scope of the analytics work and what must be stored per click. | Breakdown by device type; Breakdown by browser and operating system; Hourly breakdown; Conversion tracking on the destination site |
| requirements | 3 | "safer": Unsafe destinations. The concern is links that send people to malicious sites or to internal addresses. API abuse is a separate project. | Answered by a person. These are three unrelated pieces of work: destination rules, authentication and quotas, or code entropy and access control. Building the wrong one leaves the reported problem in place. | Unsafe destinations: block malicious and internal targets; API abuse: authentication and stricter limits; Link privacy: harder-to-guess codes, access control on stats |
| requirements | 3 | "get something in soon": The smallest slice that delivers both asks, in the next release, with the rest recorded as follow-ups. | Default assumption. It decides whether to build the smallest useful version or wait for a complete one. | Smallest useful slice in the next release; Complete solution, later |
| requirements | 3 | "our short links": Existing links too. If a destination is denied later, the old link must stop redirecting. | Answered by a person. Applying rules to existing links means checking at redirect time and can stop links that work today. Not applying them leaves every existing unsafe link live. | New links only; Existing links too, enforced when they are followed |
| planning | 2 | Deliver in 9 tasks | Two slices that share only the redirect route. Destination safety: a pure host-rules module, used by URL validation on create and again when a link is resolved. Device analytics: schema first, then classify at the route, record, aggregate, including the split between automated and other traffic. Tests are written from the acceptance criteria in parallel with the code. | - |
| architecture | 2 | ADR-1 Judge a destination by its text, without resolving DNS: Parse the URL and test its host: address literals against the non-public ranges, names against localhost, single-label and internal suffixes, and the operator's denylist. No DNS lookup is made. | The standard URL parser already turns disguised forms such as 2130706433 or 0x7f.1 into a dotted address, so a text check catches them. A DNS lookup would put a network call driven by user input on both the create and the redirect path, and the answer can change between the check and the visit. | Resolve the name and check the addresses: catches public names pointing at private addresses, at the cost of latency, a network dependency and a time-of-check gap; Call a reputation service: an external dependency, and it sends every submitted URL to a third party |
| architecture | 2 | ADR-2 Re-check the destination on every redirect: LinkService.resolve applies the same rules to the stored URL that create applies to a new one. | The requester confirmed that existing links must be covered. Checking at redirect time means a denylist change takes effect immediately for every link, with no migration or batch job, and it costs one URL parse on a row already loaded. | A one-off job that marks existing links as blocked: has to be re-run on every denylist change, and adds state that can go stale; Check only on create: leaves every existing unsafe link live |
| architecture | 2 | ADR-3 A blocked link answers 410 with link_blocked and reveals nothing: Return 410 as a problem document with code link_blocked, no Location header, and a message that does not contain the destination. | It matches how an expired link is reported, so clients handle one more code rather than a new mechanism. Withholding the destination avoids advertising the unsafe URL. | An interstitial warning page with a continue button: still delivers people to the destination; 404: hides from the owner that the link was blocked rather than lost |
| architecture | 2 | ADR-4 Store a coarse device class, never the User-Agent: Classify the header in memory at the redirect route into one of five classes and store only that class with the click. | The requester confirmed that nothing identifying a visitor may be stored. A raw User-Agent, especially combined with a timestamp and a referrer, can single out a person; one of five class names cannot. | Store the header and classify when reporting: flexible, but holds personal data; Store a hash of address and User-Agent to count unique visitors: a persistent visitor identifier, ruled out by Q-1 |
| architecture | 2 | ADR-5 Classify with a small set of patterns in-process: A handful of regular expressions over the first 512 characters of the header, with bots tested first. | Five coarse classes do not need a device database. No new dependency enters the build, and bounding the inspected length bounds the cost of an oversized header. | A User-Agent parsing library: more accurate for browser and OS detail nobody asked for, and a new dependency to approve and keep patched |
| architecture | 2 | ADR-6 Report bot and non-bot clicks beside the total, and leave the total alone: Add botClicks and nonBotClicks to the statistics. totalClicks keeps counting every recorded click and always equals their sum. The second figure is named nonBotClicks, not humanClicks. | The reviewer asked that automated traffic not inflate campaign numbers. Changing what totalClicks means would silently alter every existing report and dashboard. The name is deliberate: the figure includes clicks of unknown class and bots that pose as browsers, so calling it human would overstate what is known. | Exclude bots from totalClicks: simpler to read, but changes the meaning of an existing field; Do not record bot clicks at all: loses the ability to see how much traffic is automated |

## Artifact versions

| Artifact | Version | Status | Hash | Produced by | Stage (generation) |
| --- | --- | --- | --- | --- | --- |
| requirement | v1 | accepted | `133f1d42ac50` | requester | run-creation (0) |
| baseline-index | v1 | accepted | `121b45020fe1` | orchestrator | run-creation (0) |
| requirement-spec | v1 | superseded | `ca5a962fac37` | agent:requirements | requirements (1) |
| requirement-spec | v2 | accepted | `db08e3761641` | agent:requirements | requirements (2) |
| requirement-spec | v3 | accepted | `2bb83e761347` | agent:requirements | requirements (3) |
| clarifications | v1 | accepted | `658536f32331` | demo-requester | requirements (1) |
| impact-report | v1 | accepted | `ba8a471b17a8` | agent:impact-analysis | impact-analysis (1) |
| plan | v1 | accepted | `aff8addb171c` | agent:planning | planning (1) |
| plan | v2 | accepted | `423db8987782` | agent:planning | planning (2) |
| design | v1 | rejected | `fa81019087f9` | agent:architecture | architecture (1) |
| design | v2 | accepted | `f0be47b9c6bb` | agent:architecture | architecture (2) |
| change-requests | v1 | accepted | `885244036ba7` | demo-reviewer | architecture (1) |
| code-changes | v1 | accepted | `1333d4bfc4e5` | agent:implementation | implementation (1) |
| doc-changes | v1 | accepted | `2b8b5d1e6184` | agent:documentation | documentation (1) |
| test-changes | v1 | accepted | `a26b6bf6741c` | agent:test-design | test-design (1) |
| workspace-state | v1 | accepted | `bcea55cd859c` | agent:integrator | integrate (1) |
| policy-report | v1 | accepted | `1c34c5f5039e` | agent:policy-reviewer | policy-review (1) |
| test-report | v1 | accepted | `698f1b832dbf` | agent:build-verifier | build-verify (1) |
| release-record | v1 | accepted | `d744f36235ac` | agent:release-manager | release-readiness (1) |
| promotion-record | v1 | accepted | `0ad72f9bd6b9` | agent:promoter | promote (1) |

## Lineage of `promotion-record`

Each line was derived from the lines indented beneath it. A line ending in … is expanded where it first appears.

```
promotion-record v1 [0ad72f9bd6b9] by agent:promoter (promote, generation 1)
  release-record v1 [d744f36235ac] by agent:release-manager (release-readiness, generation 1)
    design v2 [f0be47b9c6bb] by agent:architecture (architecture, generation 2)
      impact-report v1 [ba8a471b17a8] by agent:impact-analysis (impact-analysis, generation 2, unchanged from an earlier generation)
        baseline-index v1 [121b45020fe1] by orchestrator (run-creation, generation 0)
        requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3)
          baseline-index v1 [121b45020fe1] by orchestrator (run-creation, generation 0) …
          change-requests v1 [885244036ba7] by demo-reviewer (architecture, generation 1)
          clarifications v1 [658536f32331] by demo-requester (requirements, generation 1)
          requirement v1 [133f1d42ac50] by requester (run-creation, generation 0)
      plan v2 [423db8987782] by agent:planning (planning, generation 2)
        impact-report v1 [ba8a471b17a8] by agent:impact-analysis (impact-analysis, generation 2, unchanged from an earlier generation) …
        requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3) …
      requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3) …
    policy-report v1 [1c34c5f5039e] by agent:policy-reviewer (policy-review, generation 1)
      design v2 [f0be47b9c6bb] by agent:architecture (architecture, generation 2) …
      plan v2 [423db8987782] by agent:planning (planning, generation 2) …
      workspace-state v1 [bcea55cd859c] by agent:integrator (integrate, generation 1)
        code-changes v1 [1333d4bfc4e5] by agent:implementation (implementation, generation 1)
          design v2 [f0be47b9c6bb] by agent:architecture (architecture, generation 2) …
          impact-report v1 [ba8a471b17a8] by agent:impact-analysis (impact-analysis, generation 2, unchanged from an earlier generation) …
          plan v2 [423db8987782] by agent:planning (planning, generation 2) …
          requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3) …
        design v2 [f0be47b9c6bb] by agent:architecture (architecture, generation 2) …
        doc-changes v1 [2b8b5d1e6184] by agent:documentation (documentation, generation 1)
          design v2 [f0be47b9c6bb] by agent:architecture (architecture, generation 2) …
          impact-report v1 [ba8a471b17a8] by agent:impact-analysis (impact-analysis, generation 2, unchanged from an earlier generation) …
          plan v2 [423db8987782] by agent:planning (planning, generation 2) …
          requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3) …
        plan v2 [423db8987782] by agent:planning (planning, generation 2) …
        test-changes v1 [a26b6bf6741c] by agent:test-design (test-design, generation 1)
          design v2 [f0be47b9c6bb] by agent:architecture (architecture, generation 2) …
          impact-report v1 [ba8a471b17a8] by agent:impact-analysis (impact-analysis, generation 2, unchanged from an earlier generation) …
          plan v2 [423db8987782] by agent:planning (planning, generation 2) …
          requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3) …
    requirement-spec v3 [2bb83e761347] by agent:requirements (requirements, generation 3) …
    test-changes v1 [a26b6bf6741c] by agent:test-design (test-design, generation 1) …
    test-report v1 [698f1b832dbf] by agent:build-verifier (build-verify, generation 1)
      workspace-state v1 [bcea55cd859c] by agent:integrator (integrate, generation 1) …
    workspace-state v1 [bcea55cd859c] by agent:integrator (integrate, generation 1) …
  workspace-state v1 [bcea55cd859c] by agent:integrator (integrate, generation 1) …
```

## Timeline

Selected events from `audit.jsonl`.

| # | Time | Event | Stage | Actor | Detail |
| --- | --- | --- | --- | --- | --- |
| 1 | 00:56:46.816 | RUN_CREATED |  | engine:orchestrator | scenario: ambiguous · mode: offline |
| 4 | 00:56:46.819 | RUN_STARTED |  | engine:orchestrator |  |
| 13 | 00:56:46.825 | APPROVAL_REQUESTED | requirements | engine:orchestrator | reasons: Q-1 ("who is clicking"): Does marketing need to know about individual visitors (identity, repeat visits, location), or about the audience in aggregate (what kinds of devices, where the traffic comes from)?; Q... |
| 14 | 00:56:46.825 | RUN_PAUSED |  | engine:orchestrator | waitingOn: requirements |
| 15 | 00:56:46.989 | APPROVAL_RECORDED | requirements | human:demo-requester | decision: clarified |
| 16 | 00:56:46.989 | HUMAN_INPUT_RECORDED | requirements | human:demo-requester | kind: clarification · artifact: clarifications |
| 17 | 00:56:47.084 | RUN_RESUMED |  | engine:orchestrator |  |
| 29 | 00:56:47.091 | STAGE_SUCCEEDED | requirements | engine:orchestrator |  |
| 34 | 00:56:47.095 | STAGE_SUCCEEDED | impact-analysis | engine:orchestrator |  |
| 41 | 00:56:47.097 | STAGE_SUCCEEDED | planning | engine:orchestrator |  |
| 51 | 00:56:47.099 | APPROVAL_REQUESTED | architecture | engine:orchestrator | reasons: The design changes the database schema.; The design changes the public API (additive).; The design touches personal data. · kind: approval |
| 52 | 00:56:47.100 | RUN_PAUSED |  | engine:orchestrator | waitingOn: architecture |
| 53 | 00:56:47.193 | APPROVAL_RECORDED | architecture | human:demo-reviewer | decision: changes_requested |
| 54 | 00:56:47.194 | HUMAN_INPUT_RECORDED | architecture | human:demo-reviewer | kind: change-request · artifact: change-requests |
| 55 | 00:56:47.288 | RUN_RESUMED |  | engine:orchestrator |  |
| 56 | 00:56:47.289 | STAGE_INVALIDATED | requirements | engine:orchestrator | reason: inputs changed · changedInputs: change-requests |
| 68 | 00:56:47.295 | STAGE_SUCCEEDED | requirements | engine:orchestrator |  |
| 69 | 00:56:47.295 | STAGE_INVALIDATED | impact-analysis | engine:orchestrator | reason: inputs changed · changedInputs: requirement-spec |
| 73 | 00:56:47.298 | ARTIFACT_UNCHANGED | impact-analysis | agent:impact-analysis | name: impact-report |
| 74 | 00:56:47.298 | STAGE_SUCCEEDED | impact-analysis | engine:orchestrator |  |
| 75 | 00:56:47.298 | STAGE_INVALIDATED | planning | engine:orchestrator | reason: inputs changed · changedInputs: requirement-spec |
| 82 | 00:56:47.301 | STAGE_SUCCEEDED | planning | engine:orchestrator |  |
| 93 | 00:56:47.304 | APPROVAL_REQUESTED | architecture | engine:orchestrator | reasons: The design changes the database schema.; The design changes the public API (additive).; The design touches personal data. · kind: approval |
| 94 | 00:56:47.304 | RUN_PAUSED |  | engine:orchestrator | waitingOn: architecture |
| 95 | 00:56:47.400 | APPROVAL_RECORDED | architecture | human:demo-reviewer | decision: approved |
| 97 | 00:56:47.400 | STAGE_SUCCEEDED | architecture | engine:orchestrator |  |
| 98 | 00:56:47.498 | RUN_RESUMED |  | engine:orchestrator |  |
| 110 | 00:56:47.512 | STAGE_SUCCEEDED | implementation | engine:orchestrator |  |
| 112 | 00:56:47.512 | STAGE_SUCCEEDED | documentation | engine:orchestrator |  |
| 114 | 00:56:47.512 | STAGE_SUCCEEDED | test-design | engine:orchestrator |  |
| 119 | 00:56:47.528 | STAGE_SUCCEEDED | integrate | engine:orchestrator |  |
| 124 | 00:56:47.536 | STAGE_SUCCEEDED | policy-review | engine:orchestrator |  |
| 127 | 00:56:49.695 | STAGE_SUCCEEDED | build-verify | engine:orchestrator |  |
| 132 | 00:56:49.699 | APPROVAL_REQUESTED | release-readiness | engine:orchestrator | reasons: Release sign-off for CHG-ambiguous: 6 added, 13 modified, 0 deleted; 189/189 tests pass.; High impact: CHG-001 migrations/003_click_device_class.sql: adds a database migration · kind: approval |
| 133 | 00:56:49.699 | RUN_PAUSED |  | engine:orchestrator | waitingOn: release-readiness |
| 134 | 00:56:49.808 | APPROVAL_RECORDED | release-readiness | human:demo-reviewer | decision: approved |
| 136 | 00:56:49.808 | STAGE_SUCCEEDED | release-readiness | engine:orchestrator |  |
| 137 | 00:56:49.897 | RUN_RESUMED |  | engine:orchestrator |  |
| 143 | 00:56:49.909 | STAGE_SUCCEEDED | promote | engine:orchestrator |  |
| 144 | 00:56:49.909 | RUN_SUCCEEDED |  | engine:orchestrator |  |
