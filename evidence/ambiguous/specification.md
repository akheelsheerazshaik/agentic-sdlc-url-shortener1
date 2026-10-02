# Specification

## Requirement as received

> # Safer links, better insight
> 
> From the product channel:
> 
> > Marketing wants better insight into who is clicking our links. Security also says our short
> > links need to be safer. Can we get something in soon?

_v3, accepted, hash `2bb83e761347`, produced by agent:requirements_

## Safer links, better insight

Stop short links from sending people to internal or operator-denied destinations, for new and existing links alike, and add an aggregate device breakdown to link statistics. No data that identifies a visitor is stored, as confirmed by the requester. Following review, automated traffic is reported separately from the rest.

## Functional requirements

**FR-1** (must) A link cannot be created to an internal destination.

- AC-1.1: A destination on a loopback, private, link-local or carrier-NAT address is rejected with 400, in IPv4 and IPv6 and in any numeric notation.
- AC-1.2: A destination named localhost, a single-label host name, or a name under an internal suffix is rejected with 400.
- AC-1.3: Public destinations are still accepted.

**FR-2** (must) The operator can deny destination hosts.

- AC-2.1: A destination on a denied host, or any subdomain of one, is rejected with 400.
- AC-2.2: A malformed denylist stops the service at startup.

**FR-3** (must) The destination rules are enforced when a link is followed, so they also cover links that already exist.

- AC-3.1: An existing link whose host is added to the denylist stops redirecting: 410 with code link_blocked and no Location header.
- AC-3.2: A blocked request records no click, and the response does not reveal the destination.
- AC-3.3: A stored link that points at an internal address is blocked the same way.

**FR-4** (must) Link statistics include a breakdown of clicks by device class.

- AC-4.1: Each click is classified as desktop, mobile, tablet, bot or unknown from the request's User-Agent header.
- AC-4.2: Statistics report the number of clicks for every device class, in a fixed order.
- AC-4.3: Only the device class is stored. The User-Agent header is never stored.
- AC-4.4: Clicks recorded before this change are reported as unknown.

**FR-5** (must) Automated traffic is reported separately, so it does not inflate campaign numbers.

- AC-5.1: Statistics report botClicks and nonBotClicks, and totalClicks remains their sum.
- AC-5.2: A client that identifies itself as automated (a crawler, a link previewer, an HTTP library) is classified as bot.

## Non-functional requirements

- **NFR-1** (privacy) No data that identifies a visitor is stored or logged: no client address, no User-Agent header, no visitor identifier.
- **NFR-2** (compatibility) Existing response fields keep their meaning; additions only.
- **NFR-3** (performance) The checks added to the redirect path need no network call and no additional database query.

## Ambiguities

### Q-1: "who is clicking" (answered by a person)

Does marketing need to know about individual visitors (identity, repeat visits, location), or about the audience in aggregate (what kinds of devices, where the traffic comes from)?

Why it matters: Identifying visitors means storing personal data such as IP addresses or persistent identifiers. That is a different data model, a privacy review, and it is costly to undo once the data has been collected. Aggregate figures need none of that.

- Aggregate only: no data that identifies a visitor
- Per-visitor: unique and returning visitors, which needs a stored identifier
- Per-visitor with location, which needs the client address

Answer: Aggregate only. We must not store anything that identifies a visitor: no IP addresses, no raw user agents, no visitor IDs.

### Q-2: "better insight" (proceeding on the default assumption)

Which additional figures would count as better? Today a link reports total clicks, clicks per day and top referrers.

Why it matters: It sets the scope of the analytics work and what must be stored per click.

- Breakdown by device type
- Breakdown by browser and operating system
- Hourly breakdown
- Conversion tracking on the destination site

Default assumption: Add a breakdown by device type (desktop, mobile, tablet, bot, unknown). It is the smallest addition that says something about the audience and needs no personal data.

### Q-3: "safer" (answered by a person)

Safer against what? Links that lead visitors to malicious or internal destinations, abuse of the API to create links in bulk, or people guessing or scraping other users' links?

Why it matters: These are three unrelated pieces of work: destination rules, authentication and quotas, or code entropy and access control. Building the wrong one leaves the reported problem in place.

- Unsafe destinations: block malicious and internal targets
- API abuse: authentication and stricter limits
- Link privacy: harder-to-guess codes, access control on stats

Answer: Unsafe destinations. The concern is links that send people to malicious sites or to internal addresses. API abuse is a separate project.

### Q-4: "get something in soon" (proceeding on the default assumption)

How much is "something", and is there a date? Is a first slice of each ask acceptable?

Why it matters: It decides whether to build the smallest useful version or wait for a complete one.

- Smallest useful slice in the next release
- Complete solution, later

Default assumption: The smallest slice that delivers both asks, in the next release, with the rest recorded as follow-ups.

### Q-5: "our short links" (answered by a person)

Do new safety rules apply only to links created from now on, or also to links that already exist?

Why it matters: Applying rules to existing links means checking at redirect time and can stop links that work today. Not applying them leaves every existing unsafe link live.

- New links only
- Existing links too, enforced when they are followed

Answer: Existing links too. If a destination is denied later, the old link must stop redirecting.

## Assumptions

- **A-1** A denylist maintained by the operator is an acceptable first measure against malicious destinations.
- **A-2** Device classification from the User-Agent header is a heuristic and is good enough for audience reporting.
- **A-3** totalClicks keeps its current meaning (every recorded click) so existing reports do not silently change; bot and non-bot counts are added beside it.

## Out of scope

- Identifying visitors, counting unique or returning visitors, and location
- Authentication, quotas and other protection of the API itself
- Checking destinations against a reputation service, and resolving host names to check the addresses they point to
- Browser, operating system and hourly breakdowns

## Change requests applied

- demo-reviewer, at architecture: Bots must not inflate campaign numbers: report bot and non-bot clicks separately in the stats.
