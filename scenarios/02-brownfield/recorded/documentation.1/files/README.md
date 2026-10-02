# URL Shortener

A small HTTP service that creates short links, redirects to their targets, and reports click analytics.

## Run it

Requires Node.js 22.18 or newer. There is no build step: Node runs the TypeScript sources directly.

```bash
npm install
npm start            # http://localhost:3000
npm run verify       # type-check and run all tests
```

```bash
curl -s -X POST localhost:3000/api/v1/links \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/landing", "alias": "spring-sale"}'

curl -s -X POST localhost:3000/api/v1/links \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/offer", "ttlSeconds": 3600}'   # expires in an hour

curl -i localhost:3000/spring-sale                      # 302 to the target
curl -s localhost:3000/api/v1/links/spring-sale/stats   # click analytics
```

## API

The contract is in [`openapi.yaml`](openapi.yaml).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/links` | Create a link, optionally with a custom alias and an expiry |
| `GET` | `/api/v1/links/{code}` | Read a link, expired or not |
| `GET` | `/api/v1/links/{code}/stats` | Total clicks, clicks per day, top referrers |
| `GET` | `/{code}` | Redirect to the target (`302`, never cached); `410` once expired |
| `GET` | `/healthz`, `/readyz` | Liveness and readiness probes |

Errors are RFC 9457 problem documents (`application/problem+json`) with a stable `code` field.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | Listen port |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Base of the short URLs returned to clients |
| `DATABASE_PATH` | `./data/shortener.db` | SQLite file |
| `TRUST_PROXY` | `false` | Set `true` only behind a trusted reverse proxy |
| `RATE_LIMIT_CAPACITY` | `20` | Burst size per client for `/api/*` |
| `RATE_LIMIT_REFILL_PER_SECOND` | `1` | Sustained requests per second per client |
| `CLICK_FLUSH_INTERVAL_MS` | `1000` | How often buffered clicks are written |
| `CLICK_QUEUE_MAX` | `10000` | Maximum buffered clicks |
| `LOG_LEVEL` | `info` | `silent` to `trace` |

Invalid configuration stops the process at startup.

## Design notes

- **Layers.** `http/` handles requests, `links/` and `analytics/` hold the logic, `db/` owns SQLite. Only the repository and analytics classes contain SQL, and every statement is parameterized.
- **Codes.** Seven random base62 characters from a cryptographic source. Uniqueness is enforced by the primary key: insert, and retry on a clash.
- **Destination rules.** Only `http` and `https`, no embedded credentials, at most 2048 characters, and never a link back to this service.
- **Expiry.** A link may be created with `expiresAt` (absolute, with a time zone) or `ttlSeconds` (relative), not both. From that instant the redirect returns `410 Gone` and records no click. Metadata and stats stay readable, and the alias stays reserved so an expired link cannot be taken over.
- **Redirects** use `302` with `Cache-Control: no-store`, so every click reaches the service and is counted.
- **Click recording** is decoupled from the redirect. A redirect pushes an event onto a bounded in-memory queue; a timer writes batches in one transaction together with the running totals. On graceful shutdown the remaining events are written before the database closes.
- **Rate limiting** is a per-client token bucket on `/api/*`. Redirects are not limited.
- **Privacy.** Only the referrer's host is stored. Request logs contain the method and path, not the client address.
- **Migrations** are plain SQL files applied in order. An applied file may not change; the stored checksum is verified at startup.

## Known limitations

- Clicks are dropped when the queue is full, and clicks still buffered when the process is killed without a graceful shutdown (`SIGKILL`, crash, power loss) are lost. Analytics are best-effort by design.
- Expired links are kept, not deleted, so their stats remain available.
- The API has no authentication: anyone who can reach it can create links and read stats.
- Rate limits and the click queue live in one process. Running several instances needs a shared store.
- SQLite is a single-writer, single-node database.
- `node:sqlite` prints an experimental-feature warning on current Node.js releases.
- Click events are kept indefinitely.
