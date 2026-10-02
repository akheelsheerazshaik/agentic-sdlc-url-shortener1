# Plan and design

## Impact on the existing codebase

_v1, accepted, hash `ba8a471b17a8`, produced by agent:impact-analysis_

The two asks land in different parts of the codebase and meet in two files. Destination safety belongs with the existing URL rules in the domain layer and must also be applied where a link is resolved for a redirect. Device analytics follows the existing click path: derive a value from a request header at the route, carry it through the click recorder, store it with the click event, and aggregate it in the statistics service. Both touch the redirect route and the application wiring.

| Module | Change | Reason |
| --- | --- | --- |
| `src/domain/urlPolicy.ts` | modify | Add the internal-destination and denylist rules to URL validation, and expose them for reuse at redirect time. |
| `src/links/linkService.ts` | modify | Pass the denylist into validation on create; re-check the stored destination in resolve so existing links are covered. |
| `src/domain/errors.ts` | extend | New link_blocked error mapped to 410. |
| `src/config.ts` | extend | New DENIED_HOSTS setting, validated at startup. |
| `src/app.ts` | modify | Wire the denylist from configuration into the link service. |
| `src/http/routes.ts` | modify | Classify the device from the User-Agent header on redirect and pass the class to the recorder. |
| `src/analytics/clickRecorder.ts` | modify | Carry and store the device class with each click event. |
| `src/analytics/statsService.ts` | modify | Aggregate clicks by device class. |
| `test/unit/urlPolicy.test.ts` | modify | The policy options gain a required field, and the new rules need coverage. |
| `test/unit/clickRecorder.test.ts` | modify | Click events gain a required field. |
| `test/integration/stats.api.test.ts` | modify | An existing assertion compares the whole stats body and must expect the added fields; device breakdown needs coverage. |
| `openapi.yaml` | modify | New stats fields, new 410 reason, new destination restrictions. |
| `README.md` | modify | Document the destination rules, the setting, the device breakdown and the privacy position. |

| New module | Purpose |
| --- | --- |
| `src/domain/hostRules.ts` | Decide whether a host is internal or denied; parse the denylist setting. |
| `src/analytics/deviceClass.ts` | Reduce a User-Agent header to a coarse device class. |
| `migrations/003_click_device_class.sql` | Add device_class to click_events. |
| `test/unit/hostRules.test.ts` | Tests for the internal-host and denylist rules, including unusual address notations. |
| `test/unit/deviceClass.test.ts` | Tests for device classification. |
| `test/integration/safety.api.test.ts` | API tests for destination safety on create and on redirect. |

API:
- `POST /api/v1/links`: Stricter validation: internal and denied destinations are now rejected with 400. A destination that was accepted before can be refused now.
- `GET /{code}`: Additive: 410 with code link_blocked when the stored destination is no longer allowed.
- `GET /api/v1/links/{code}/stats`: Additive: device breakdown fields in the response.

Data:
- click_events gains device_class, not null, default 'unknown', restricted to five values. Existing rows take the default.

Data flows:
- Create link: validate URL → internal-host check → denylist check → store.
- Redirect: look up link → check expiry → re-check destination against the current rules → classify device from User-Agent → queue click with the class → 302. The header itself goes no further than the classifier.
- Statistics: the per-device counts are read from click_events alongside the existing aggregates.

Regression surface, from the import graph (11 modules depend on what changes):
- `src/domain/shortCode.ts`
- `src/http/problem.ts`
- `src/server.ts`
- `test/helpers.ts`
- `test/integration/expiry.api.test.ts`
- `test/integration/links.api.test.ts`
- `test/integration/reliability.test.ts`
- `test/integration/shutdown.test.ts`
- `test/unit/linkExpiry.test.ts`
- `test/unit/migrator.test.ts`
- `test/unit/shortCode.test.ts`

## Task plan

_v2, accepted, hash `423db8987782`, produced by agent:planning_

Two slices that share only the redirect route. Destination safety: a pure host-rules module, used by URL validation on create and again when a link is resolved. Device analytics: schema first, then classify at the route, record, aggregate, including the split between automated and other traffic. Tests are written from the acceptance criteria in parallel with the code.

| Task | Lane | Title | Depends on | Requirements | Risk | Files |
| --- | --- | --- | --- | --- | --- | --- |
| T-1 | code | Migration: device_class on click_events | - | FR-4, NFR-1 | medium | `migrations/003_click_device_class.sql` |
| T-2 | code | Host rules and destination validation | - | FR-1, FR-2, NFR-3 | medium | `src/domain/hostRules.ts` `src/domain/urlPolicy.ts` |
| T-3 | code | DENIED_HOSTS configuration | T-2 | FR-2 | low | `src/config.ts` |
| T-4 | code | Enforce the destination rules on redirect | T-2, T-3 | FR-3, NFR-3 | medium | `src/links/linkService.ts` `src/domain/errors.ts` `src/app.ts` |
| T-5 | code | Classify the device and record it with each click | T-1 | FR-4, FR-5, NFR-1 | medium | `src/analytics/deviceClass.ts` `src/analytics/clickRecorder.ts` `src/http/routes.ts` |
| T-6 | code | Device breakdown in statistics, with bot and non-bot totals | T-5 | FR-4, FR-5, NFR-2 | low | `src/analytics/statsService.ts` |
| T-7 | test | Tests for destination safety | - | FR-1, FR-2, FR-3 | low | `test/unit/hostRules.test.ts` `test/unit/urlPolicy.test.ts` `test/integration/safety.api.test.ts` |
| T-8 | test | Tests for device analytics | - | FR-4, FR-5, NFR-1 | low | `test/unit/deviceClass.test.ts` `test/integration/stats.api.test.ts` `test/unit/clickRecorder.test.ts` |
| T-9 | docs | Update the README and the OpenAPI contract | - | FR-1, FR-2, FR-3, FR-4, FR-5 | low | `README.md` `openapi.yaml` |

## Design

_v2, accepted, hash `f0be47b9c6bb`, produced by agent:architecture_

Destination safety is a pure function of a URL and the operator's denylist, placed beside the existing URL rules. It runs in two places: when a link is created, and when a stored link is resolved for a redirect, which is how existing links are covered without touching their rows.

Device analytics extends the existing click path by one value. The redirect route reduces the User-Agent header to a device class and hands the class, not the header, to the click recorder. The class is stored with the click event and aggregated by the statistics service. Automated traffic is reported beside the total rather than removed from it.

| Component | Responsibility | Files |
| --- | --- | --- |
| Host rules | Internal-host detection, denylist matching, denylist parsing. No I/O. | `src/domain/hostRules.ts` |
| URL policy | Apply the host rules on create, and expose the re-check used on redirect. | `src/domain/urlPolicy.ts` |
| Configuration and wiring | Read and validate DENIED_HOSTS; pass it to the link service. | `src/config.ts` `src/app.ts` |
| Link service | Validate against the denylist on create; block a disallowed stored destination on resolve. | `src/links/linkService.ts` `src/domain/errors.ts` |
| Device classification | Map a User-Agent header to one of five classes. | `src/analytics/deviceClass.ts` |
| Click path | Classify at the route, store the class with the event, aggregate by class. | `src/http/routes.ts` `src/analytics/clickRecorder.ts` `src/analytics/statsService.ts` `migrations/003_click_device_class.sql` |

### API changes

- `POST /api/v1/links`: Destinations on internal or denied hosts now return 400.
- `GET /{code}`: New 410 reason: code link_blocked.
- `GET /api/v1/links/{code}/stats`: Response adds clicksByDevice, botClicks and nonBotClicks.

### Data model changes

- click_events.device_class TEXT NOT NULL DEFAULT 'unknown', constrained to desktop, mobile, tablet, bot, unknown.

### Change envelope (what the approver signed off)

| Aspect | Declared |
| --- | --- |
| Schema change | yes |
| API change | additive |
| Dependencies added or changed | none |
| Touches personal data | yes |

### Decisions

**ADR-1 Judge a destination by its text, without resolving DNS.** Parse the URL and test its host: address literals against the non-public ranges, names against localhost, single-label and internal suffixes, and the operator's denylist. No DNS lookup is made.

Why: The standard URL parser already turns disguised forms such as 2130706433 or 0x7f.1 into a dotted address, so a text check catches them. A DNS lookup would put a network call driven by user input on both the create and the redirect path, and the answer can change between the check and the visit.

Rejected:
- Resolve the name and check the addresses: catches public names pointing at private addresses, at the cost of latency, a network dependency and a time-of-check gap
- Call a reputation service: an external dependency, and it sends every submitted URL to a third party

**ADR-2 Re-check the destination on every redirect.** LinkService.resolve applies the same rules to the stored URL that create applies to a new one.

Why: The requester confirmed that existing links must be covered. Checking at redirect time means a denylist change takes effect immediately for every link, with no migration or batch job, and it costs one URL parse on a row already loaded.

Rejected:
- A one-off job that marks existing links as blocked: has to be re-run on every denylist change, and adds state that can go stale
- Check only on create: leaves every existing unsafe link live

**ADR-3 A blocked link answers 410 with link_blocked and reveals nothing.** Return 410 as a problem document with code link_blocked, no Location header, and a message that does not contain the destination.

Why: It matches how an expired link is reported, so clients handle one more code rather than a new mechanism. Withholding the destination avoids advertising the unsafe URL.

Rejected:
- An interstitial warning page with a continue button: still delivers people to the destination
- 404: hides from the owner that the link was blocked rather than lost

**ADR-4 Store a coarse device class, never the User-Agent.** Classify the header in memory at the redirect route into one of five classes and store only that class with the click.

Why: The requester confirmed that nothing identifying a visitor may be stored. A raw User-Agent, especially combined with a timestamp and a referrer, can single out a person; one of five class names cannot.

Rejected:
- Store the header and classify when reporting: flexible, but holds personal data
- Store a hash of address and User-Agent to count unique visitors: a persistent visitor identifier, ruled out by Q-1

**ADR-5 Classify with a small set of patterns in-process.** A handful of regular expressions over the first 512 characters of the header, with bots tested first.

Why: Five coarse classes do not need a device database. No new dependency enters the build, and bounding the inspected length bounds the cost of an oversized header.

Rejected:
- A User-Agent parsing library: more accurate for browser and OS detail nobody asked for, and a new dependency to approve and keep patched

**ADR-6 Report bot and non-bot clicks beside the total, and leave the total alone.** Add botClicks and nonBotClicks to the statistics. totalClicks keeps counting every recorded click and always equals their sum. The second figure is named nonBotClicks, not humanClicks.

Why: The reviewer asked that automated traffic not inflate campaign numbers. Changing what totalClicks means would silently alter every existing report and dashboard. The name is deliberate: the figure includes clicks of unknown class and bots that pose as browsers, so calling it human would overstate what is known.

Rejected:
- Exclude bots from totalClicks: simpler to read, but changes the meaning of an existing field
- Do not record bot clicks at all: loses the ability to see how much traffic is automated

### Risks

| Id | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | A public host name that resolves to a private address is not detected. | medium | medium | Accepted and documented under ADR-1. The service never fetches the destination itself, so this is not a server-side request forgery path; the exposure is a visitor inside a network being sent to an internal address. |
| R-2 | The denylist is only as good as its maintenance. | high | medium | Documented as a first measure. A reputation feed is a recorded follow-up. |
| R-3 | An over-broad denylist entry blocks legitimate links, including existing ones, immediately. | low | high | Entries are validated as host names at startup; matching is by host and subdomain only, never by substring. Removing the entry restores the links at once because nothing is stored. |
| R-4 | Device classes are heuristic: a bot that sends a browser's User-Agent is counted as that browser, and recent iPads identify as desktop. | high | low | Documented. The class named bot is defined as clients that identify themselves as automated. |
| R-5 | Adding a constrained not-null column validates existing click_events rows during the migration. | low | medium | The default satisfies the constraint for every row. On a very large table the migration should be run in a maintenance window. |
| R-6 | Creation requests that used to succeed are now rejected. | medium | low | This is the intent of the change. The error message states that the destination is not allowed. |

### How each requirement is met

- **FR-1**: normalizeTargetUrl rejects a destination whose host isInternalHost reports as internal.
- **FR-2**: The same function rejects a host that isDeniedHost matches against the configured list; parseDeniedHosts validates the setting at startup.
- **FR-3**: LinkService.resolve calls isAllowedDestination on the stored URL and raises link_blocked before any click is queued.
- **FR-4**: The redirect route calls classifyDevice, the recorder stores the class, and StatsService groups click_events by it and reports every class.
- **FR-5**: StatsService reports the bot class count as botClicks and totalClicks minus it as nonBotClicks; classifyDevice tests for self-identified automation first.
