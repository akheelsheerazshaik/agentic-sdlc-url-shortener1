# Specification

## Requirement as received

> # Link expiry, and clicks lost on restart
> 
> Two changes to the existing URL shortener.
> 
> ## 1. Enhancement: link expiry
> 
> Campaign links should stop working when the campaign ends. When creating a link, the caller can give
> either an absolute expiry time or a time-to-live in seconds. After that moment the short link must
> no longer redirect, and the visitor should be told the link has expired rather than that it never
> existed. Links created without an expiry keep working as they do today. The owner must still be
> able to read the stats of an expired link.
> 
> ## 2. Defect BUG-17: clicks go missing around deployments
> 
> Support compared the click totals of two campaigns with the ad platform's numbers. We under-count by
> a handful of clicks every time the service is redeployed: clicks that arrive just before a restart
> never show up in the stats.
> 
> ## Constraint
> 
> Existing links, existing API clients and existing data must keep working.

_v1, accepted, hash `7923bb6d3661`, produced by agent:requirements_

## Link expiry, and clicks lost on restart

Add an optional expiry to links so that a redirect stops at a chosen moment while the link's record and statistics stay readable, and fix the loss of buffered click events when the service shuts down. Both must be additive: no existing link, client or stored row may change behaviour.

## Functional requirements

**FR-1** (must) A link can be created with an optional expiry, given either as an absolute time or as a time-to-live.

- AC-1.1: expiresAt accepts an ISO-8601 time with a time zone; it is stored and returned in UTC.
- AC-1.2: ttlSeconds sets the expiry that many seconds after creation.
- AC-1.3: An invalid expiry returns 400: a time that is not in the future, both fields at once, a value that is not a timestamp or has no time zone, or a time-to-live that is zero, negative, fractional or above the maximum.
- AC-1.4: A link created without an expiry reports expiresAt as null and never expires.

**FR-2** (must) An expired link no longer redirects, and says so.

- AC-2.1: The link redirects normally up to, but not including, its expiry instant.
- AC-2.2: From the expiry instant the redirect returns 410 Gone as a problem document with code link_expired and no Location header.
- AC-2.3: A request to an expired link is not counted as a click.

**FR-3** (must) An expired link remains a readable record.

- AC-3.1: The link's metadata and its statistics are still returned after it has expired.
- AC-3.2: The alias of an expired link cannot be registered again.

**FR-4** (must) BUG-17: clicks accepted before a graceful shutdown are not lost.

- AC-4.1: Clicks still buffered when the application closes are written to the database before it closes.
- AC-4.2: Shutdown completes even if that final write fails.

**FR-5** (must) Existing links and clients are unaffected.

- AC-5.1: A link stored before this change still redirects and reports expiresAt as null.
- AC-5.2: Responses keep every existing field with its existing meaning; the only change is the added expiresAt field.

## Non-functional requirements

- **NFR-1** (compatibility) The schema change is additive and leaves existing rows untouched.
- **NFR-2** (performance) The redirect path gains no additional database query.

## Ambiguities

### Q-1: "told the link has expired rather than that it never existed" (proceeding on the default assumption)

Which response distinguishes an expired link from an unknown one?

Why it matters: It is a public contract that clients and monitoring will depend on.

- 410 Gone with error code link_expired
- 404 with a different message
- An HTML page explaining the expiry

Default assumption: 410 Gone as a problem document with code link_expired, consistent with the API's existing error format.

### Q-2: "After that moment" (proceeding on the default assumption)

Is the link still valid at exactly the expiry instant?

Why it matters: The boundary has to be defined for the tests to be exact and for clients to predict behaviour.

- Expired from the instant onwards
- Still valid at the instant, expired after it

Default assumption: The link is expired from its expiry instant onwards.

### Q-3: "a time-to-live in seconds" (proceeding on the default assumption)

Is there an upper bound on the lifetime?

Why it matters: An unbounded integer invites overflow and nonsensical dates.

- Maximum of five years
- No maximum

Default assumption: A positive whole number of seconds, at most five years.

### Q-4: "must no longer redirect" (proceeding on the default assumption)

May the alias of an expired link be reused for a new link?

Why it matters: If it can, someone else can register the alias of a link people already trust and send its visitors anywhere.

- The alias stays reserved
- The alias becomes available again

Default assumption: The alias stays reserved, to prevent takeover of an expired link.

### Q-5: "just before a restart" (proceeding on the default assumption)

Does the fix have to cover an abrupt kill of the process, or only a graceful shutdown?

Why it matters: A deployment sends SIGTERM and is a graceful shutdown. Surviving an abrupt kill needs every click written durably before the redirect returns, which contradicts the existing requirement that recording a click never slows a redirect.

- Graceful shutdown only
- Also survive a crash, by writing each click synchronously

Default assumption: Graceful shutdown only, which is what a deployment is. Loss on an abrupt kill remains and is documented.

## Assumptions

- **A-1** Expired links are kept, not deleted, so that their statistics remain available.
- **A-2** Expiry is checked when a link is resolved, using the row already loaded for the redirect.

## Out of scope

- Changing or removing the expiry of an existing link
- Deleting expired links or their click events
- Durable click recording that survives an abrupt process kill
