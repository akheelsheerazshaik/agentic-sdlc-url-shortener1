# URL shortener service

Build a URL shortener as an HTTP service.

## Core API

- Create a short link for a long URL. The caller may supply a custom alias; otherwise the service generates a code.
- Visiting a short link redirects to the original URL.
- Look up a link by its code.

## Analytics

- For each link, report total clicks, clicks per day, and the top referrers.

## Reliability

- Limit how fast one client can create links, so a burst from one caller does not degrade the service for others.
- Recording a click must never slow down or fail a redirect.
- Provide liveness and readiness endpoints for the platform.
- Bad input must produce a clear error response, never a crash.

## Constraints

- TypeScript on Node.js, started with a single command, with no external services to install.
- Ship with automated tests and an OpenAPI description of the API.
