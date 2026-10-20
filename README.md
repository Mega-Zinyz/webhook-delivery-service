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
milliseconds; it defaults to 86400000 (24 hours).

## Test a failed delivery

Start a mock endpoint that always responds with HTTP 500:

```sh
node -e "require('node:http').createServer((req,res)=>{req.resume();res.writeHead(500);res.end('test failure')}).listen(4101,()=>console.log('Failing mock on port 4101'))"
```

In another terminal, run the service with a short retry window. For
PowerShell:

```powershell
$env:WEBHOOK_RETRY_WINDOW_MS='5000'; npm start
```

Register a **new subscription ID** pointing to
`http://localhost:4101/webhook`, then submit an event for it. Poll
`GET /events/:eventId`; it should become `failed` after about five seconds.
Use a new subscription ID so earlier queued events do not block this test.
Without the override, the production-default retry window is 24 hours.

## Project structure

```text
index.js                         Express app and service startup
config/sqlite-database.js        SQLite connection, schema, and startup recovery
routes/                          Health, subscription, and event handlers
services/webhookDispatcher.js    Delivery attempts, retries, and scheduling
utils/                           Request logging and error handling middleware
```

The database module is under `config/`, following the backend layout used in
the [Sentiment-Analysis repository](https://github.com/Mega-Zinyz/Sentiment-Analysis/tree/main/Backend/config).

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

Deliveries are HTTP POST requests containing the original JSON payload and
`Idempotency-Key`, `X-Webhook-Event-Id`, and `X-Webhook-Subscription-Id`
headers.
