# Delivery decisions

- **Delivery semantics:** At-least-once delivery attempts, not exactly-once
  processing. Events are persisted before acceptance and use a stable event ID
  as the idempotency key. A timeout after the endpoint processes a request can
  still cause a duplicate, so consumers should deduplicate by that ID.
- **Retries:** Failed requests use exponential backoff with jitter, capped at
  five minutes; each request times out after five seconds. Automatic retries
  continue for 24 hours by default. After that, the event remains stored with
  status `failed` for inspection or manual retry. The retry window can be
  shortened with `WEBHOOK_RETRY_WINDOW_MS` for testing.
- **Long outages and isolation:** Events remain durably queued during endpoint
  outages. Up to ten deliveries can run concurrently, but only one at a time
  per subscription, leaving capacity for other customers while preserving
  each customer's order.
- **Ordering:** Events are delivered in enqueue order per subscription. A
  failing event blocks later events for that customer until it succeeds or is
  manually retried; this trades per-customer throughput for ordering.
- **Out of scope:** This is a single-process SQLite service for one host. It
  does not include authentication, a UI, billing, distributed worker
  coordination, or production deployment.
- **Known limitations / next steps:**
- `last_error` is overwritten with "Automatic retry window expired" when
  retries stop, so the original cause (e.g. HTTP 500) is only in the logs.
  Next: keep the last HTTP status/error separately.
- Manual retry endpoint for failed events (not built yet).
- Endpoint URL is copied onto each event at creation time; changing a
  subscription's URL does not affect events already queued.
