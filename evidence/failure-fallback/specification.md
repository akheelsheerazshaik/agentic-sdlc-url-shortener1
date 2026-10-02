# Specification

## Requirement as received

> # URL shortener service
> 
> Build a URL shortener as an HTTP service.
> 
> ## Core API
> 
> - Create a short link for a long URL. The caller may supply a custom alias; otherwise the service generates a code.
> - Visiting a short link redirects to the original URL.
> - Look up a link by its code.
> 
> ## Analytics
> 
> - For each link, report total clicks, clicks per day, and the top referrers.
> 
> ## Reliability
> 
> - Limit how fast one client can create links, so a burst from one caller does not degrade the service for others.
> - Recording a click must never slow down or fail a redirect.
> - Provide liveness and readiness endpoints for the platform.
> - Bad input must produce a clear error response, never a crash.
> 
> ## Constraints
> 
> - TypeScript on Node.js, started with a single command, with no external services to install.
> - Ship with automated tests and an OpenAPI description of the API.

_v1, accepted, hash `d0cb49a456d8`, produced by agent:requirements_

## URL shortener service

Provide an HTTP service that maps short codes to long URLs, redirects visitors, and counts clicks, as a single self-contained process. The redirect is the hot path and must stay fast and available even when analytics or individual callers misbehave.

## Functional requirements

**FR-1** (must) A client can create a short link for an http or https URL, with a generated code or a custom alias.

- AC-1.1: POST /api/v1/links with a valid URL returns 201 with the code, the short URL, the normalized target URL and the creation time.
- AC-1.2: A supplied alias becomes the code. An alias that is already in use returns 409.
- AC-1.3: Invalid input returns 400 as a problem document: a URL that is not http/https, carries credentials, exceeds 2048 characters or points at the service itself; an invalid or reserved alias; unknown fields.
- AC-1.4: A generated code that collides with an existing one is retried with a new code. If no unique code is found after a bounded number of tries the response is 503.

**FR-2** (must) Visiting a short link redirects to its target URL.

- AC-2.1: GET /{code} returns 302 with the target in Location and Cache-Control: no-store.
- AC-2.2: An unknown or malformed code returns 404 as a problem document.

**FR-3** (must) A client can look up a link by its code.

- AC-3.1: GET /api/v1/links/{code} returns the link, or 404 for an unknown code.

**FR-4** (must) A client can read click analytics for a link.

- AC-4.1: Total clicks counts every successful redirect and nothing else.
- AC-4.2: Clicks are reported per UTC day, oldest first, for the last 30 days.
- AC-4.3: The top referrers are reported by host, with clicks that have no referrer counted as "direct". Only the referrer's host is stored.

**FR-5** (must) Link creation and the rest of the management API are rate limited per client.

- AC-5.1: A client that exceeds its burst receives 429 with Retry-After, and is served again once its allowance refills.
- AC-5.2: Redirects are not rate limited.

**FR-6** (must) Recording a click never slows down or fails a redirect.

- AC-6.1: Redirects keep succeeding when the click queue is full; the excess clicks are dropped and counted.
- AC-6.2: Buffered clicks and the per-link totals are written in one transaction; a failed write changes nothing and keeps the batch.

**FR-7** (must) The service exposes liveness and readiness endpoints.

- AC-7.1: GET /healthz returns 200 while the process runs. GET /readyz returns 200 when the database is reachable and 503 when it is not.

**FR-8** (must) Every failure produces a well-formed error response.

- AC-8.1: Malformed JSON returns 400 and an oversized body returns 413.
- AC-8.2: An unexpected internal failure returns a generic 500 problem document that exposes no internal detail.

## Non-functional requirements

- **NFR-1** (operability) The service starts with one command and depends on no external service.
- **NFR-2** (maintainability) The database schema is created by versioned migrations, and an applied migration is never edited.
- **NFR-3** (privacy) No client address is stored or written to logs.
- **NFR-4** (security) Every SQL statement is parameterized, and configuration is validated at startup.

## Ambiguities

### Q-1: "top referrers" (proceeding on the default assumption)

How many referrers, and at what granularity: the full referring URL or only its host?

Why it matters: A full referrer URL can contain personal data in its path or query, so storing it changes the privacy position of the service.

- Top 10 by host
- Top N by full URL
- All referrers

Default assumption: Top 10 by host; only the host is ever stored.

### Q-2: "clicks per day" (proceeding on the default assumption)

In which time zone is a day, and how far back does the report go?

Why it matters: It decides how clicks near midnight are attributed and how much data each stats request scans.

- UTC days, last 30 days
- Caller-supplied time zone
- Full history

Default assumption: UTC days over the last 30 days; the total covers all time.

### Q-3: "Limit how fast one client can create links" (proceeding on the default assumption)

What identifies a client, and what are the limits?

Why it matters: The API has no authentication, so the only available identity is the network address, and the limits decide what a legitimate bulk user can do.

- Per client address, burst 20 then 1 per second, configurable
- Per API key
- One global limit

Default assumption: Per client address with a token bucket, burst 20 and 1 request per second, both configurable.

### Q-4: "redirects to the original URL" (proceeding on the default assumption)

Permanent (301) or temporary (302) redirect?

Why it matters: Browsers cache a 301, so later visits never reach the service: clicks go uncounted and a link can never be changed or withdrawn.

- 302 with no-store
- 301

Default assumption: 302 with Cache-Control: no-store, because analytics is a stated requirement.

### Q-5: "The caller" (proceeding on the default assumption)

Who is allowed to create links and read stats? The requirement does not mention authentication.

Why it matters: Without authentication anyone who can reach the API can create links and read any link's stats.

- No authentication in this version; deploy behind a trusted gateway
- API keys
- Per-user accounts

Default assumption: No authentication in this version. It is recorded as a risk and a limitation, and the API is rate limited.

## Assumptions

- **A-1** One instance of the service runs at a time, so an embedded database and in-process state are acceptable.
- **A-2** Analytics are best-effort: losing a small number of clicks is acceptable, failing a redirect is not.
- **A-3** Links do not expire and cannot be edited or deleted in this version.

## Out of scope

- Authentication and per-user ownership of links
- Editing, deleting or expiring links
- Running several instances behind a load balancer
- Checking destinations against malware or phishing lists
