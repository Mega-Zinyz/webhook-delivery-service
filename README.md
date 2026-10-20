# Webhook delivery service

## Run

Requires Node.js 22.13 or newer and npm.

```sh
npm install
npm start
```

`npm start` is the one-line run command after dependencies are installed.
The service listens on port `3000` by default. Set `PORT` to change it and
`WEBHOOK_DB_PATH` to choose the SQLite database file (default:
`webhooks.sqlite` in the working directory).
`WEBHOOK_RETRY_WINDOW_MS` optionally overrides the automatic retry window in
milliseconds; it defaults to 86400000 (24 hours). Callback URLs resolving to
private/local IP addresses are blocked by default. For a trusted local mock
endpoint, opt in explicitly with
`WEBHOOK_ALLOW_PRIVATE_ENDPOINTS=true` before starting the service.

## Verify retry exhaustion

Start a mock endpoint that always responds with HTTP 500:

```sh
node -e "require('node:http').createServer((req,res)=>{req.resume();res.writeHead(500);res.end('test failure')}).listen(4101,()=>console.log('Failing mock on port 4101'))"
```

In another terminal, run the service with a short retry window and allow the
local mock callback. For PowerShell:

```powershell
$env:WEBHOOK_ALLOW_PRIVATE_ENDPOINTS='true'; $env:WEBHOOK_RETRY_WINDOW_MS='5000'; npm start
```

Register a **new subscription ID** pointing to
`http://localhost:4101/webhook`, then submit an event for it. Poll
`GET /events/:eventId`; it should become `failed` after about five seconds.
Use a new subscription ID so earlier queued events do not block the example.
Without the override, the production-default retry window is 24 hours.

## Automated tests

```sh
npm test
```

## Project structure

```text
index.js                         Express app and service startup
config/sqlite-database.js        SQLite connection, schema, and startup recovery
routes/                          Health, metrics, subscription, and event handlers
services/webhookDispatcher.js    Delivery, retry policy, rate limiting, scheduling
utils/                           URL safety, token bucket, and HTTP middleware
test/                            Delivery, retry, safety, and metrics tests
```

## API

Register or update an endpoint:

```http
POST /subscriptions
Content-Type: application/json

{"subscriptionId":"customer-123","endpointUrl":"https://example.com/hooks"}
```

Accept an event (the JSON `payload` can be any JSON value):

```http
POST /events
Content-Type: application/json

{"subscriptionId":"customer-123","payload":{"type":"invoice.paid"}}
```

The service returns `202` with an `eventId` after the event is committed to
SQLite. Check progress with `GET /events/:eventId`. Events that exhaust the
automatic retry window have status `failed`; retry one with
`POST /events/:eventId/retry`.

An optional `Idempotency-Key` request header deduplicates producer retries for
the same subscription. Inspect delivery history using
`GET /events/:eventId/attempts`. `GET /metrics` returns event counts, oldest
pending-event age, and active delivery count.

Deliveries are HTTP POST requests containing the original JSON payload and
`Idempotency-Key`, `X-Webhook-Event-Id`, and `X-Webhook-Subscription-Id`
headers.

Only HTTP 2xx responses count as delivered. HTTP 408, 429, 5xx, timeouts, and
network failures are retried; 429/5xx `Retry-After` is honored up to the
five-minute backoff cap. Other HTTP responses, including 3xx redirects, fail
without retry; redirects are not followed. Each subscription has a token
bucket allowing a burst of five deliveries, refilling at one delivery per
second. This limiter is process-local and resets on restart; multiple service
instances would need a shared rate-limit store.

Callback hostnames are checked at registration and resolved again when
connecting; the request connects to a validated public address, preventing a
DNS change between validation and connection from bypassing the check. Private
and local addresses are blocked unless explicitly enabled for trusted local
development. Network-level egress restrictions are still recommended in
production.
