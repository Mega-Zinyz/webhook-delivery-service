const { database } = require('../config/sqlite-database');

const automaticRetryWindowMs = Number(process.env.WEBHOOK_RETRY_WINDOW_MS || 24 * 60 * 60 * 1000);
if (!Number.isSafeInteger(automaticRetryWindowMs) || automaticRetryWindowMs <= 0) {
  throw new Error('WEBHOOK_RETRY_WINDOW_MS must be a positive integer');
}
const initialRetryDelayMs = 1000;
const maxRetryDelayMs = 5 * 60 * 1000;
const deliveryTimeoutMs = 5000;
const pollIntervalMs = 250;
const maxConcurrentDeliveries = 10;
const activeSubscriptions = new Set();
const activeDeliveries = new Set();

function retryDelay(attemptCount) {
  const exponentialDelay = Math.min(initialRetryDelayMs * (2 ** (attemptCount - 1)), maxRetryDelayMs);
  return Math.min(Math.round(exponentialDelay * (0.5 + Math.random())), maxRetryDelayMs);
}

async function deliver(event) {
  const now = Date.now();
  const attemptCount = event.attempt_count + 1;
  const firstAttemptAt = event.first_attempt_at || now;
  const claimed = database.prepare(`
    UPDATE events SET status = 'delivering', attempt_count = ?,
      first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(attemptCount, now, now, event.id);
  if (claimed.changes === 0) {
    return;
  }

  try {
    const response = await fetch(event.endpoint_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': event.id,
        'x-webhook-event-id': event.id,
        'x-webhook-subscription-id': event.subscription_id,
      },
      body: event.payload,
      signal: AbortSignal.timeout(deliveryTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Endpoint returned HTTP ${response.status}`);
    }

    const deliveredAt = Date.now();
    database.prepare(`
      UPDATE events SET status = 'delivered', last_error = NULL, delivered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(deliveredAt, deliveredAt, event.id);
  } catch (error) {
    const failedAt = Date.now();
    const isFailed = failedAt - firstAttemptAt >= automaticRetryWindowMs;
    const nextAttemptAt = failedAt + retryDelay(attemptCount);
    database.prepare(`
      UPDATE events SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(isFailed ? 'failed' : 'pending', nextAttemptAt, error.message, failedAt, event.id);
    console.error(`Webhook delivery ${event.id} failed (attempt ${attemptCount}, ${isFailed ? 'retry window expired' : 'will retry'}): ${error.message}`);
  }
}

function dispatchDueEvents() {
  try {
    const now = Date.now();
    const retryCutoff = now - automaticRetryWindowMs;
    database.prepare(`
      UPDATE events SET status = 'failed', updated_at = ?,
        last_error = 'Automatic retry window expired'
      WHERE status = 'pending' AND first_attempt_at IS NOT NULL AND first_attempt_at <= ?
    `).run(now, retryCutoff);

    const availableSlots = maxConcurrentDeliveries - activeSubscriptions.size;
    if (availableSlots <= 0) {
      return;
    }

    const activeIds = [...activeSubscriptions];
    const activeFilter = activeIds.length > 0
      ? `AND e.subscription_id NOT IN (${activeIds.map(() => '?').join(', ')})`
      : '';
    const dueEvents = database.prepare(`
      SELECT e.id, e.subscription_id, e.endpoint_url, e.payload, e.attempt_count, e.first_attempt_at
      FROM events AS e
      WHERE e.status = 'pending' AND e.next_attempt_at <= ?
        ${activeFilter}
        AND NOT EXISTS (
          SELECT 1 FROM events AS earlier
          WHERE earlier.subscription_id = e.subscription_id
            AND (earlier.created_at < e.created_at
              OR (earlier.created_at = e.created_at AND earlier.rowid < e.rowid))
            AND earlier.status != 'delivered'
        )
      ORDER BY e.created_at, e.rowid
      LIMIT ?
    `).all(now, ...activeIds, availableSlots);

    for (const event of dueEvents) {
      activeSubscriptions.add(event.subscription_id);
      let delivery;
      delivery = deliver(event)
        .catch((error) => console.error(`Failed to process webhook ${event.id}:`, error))
        .finally(() => {
          activeSubscriptions.delete(event.subscription_id);
          activeDeliveries.delete(delivery);
        });
      activeDeliveries.add(delivery);
    }
  } catch (error) {
    console.error('Failed to dispatch webhook events:', error);
  }
}

let pollingTimer;
function start() {
  if (pollingTimer) {
    return;
  }
  dispatchDueEvents();
  pollingTimer = setInterval(dispatchDueEvents, pollIntervalMs);
}

function stop() {
  clearInterval(pollingTimer);
  pollingTimer = undefined;
}

async function waitForDeliveries() {
  while (activeDeliveries.size > 0) {
    await Promise.allSettled([...activeDeliveries]);
  }
}

module.exports = { start, stop, waitForDeliveries };
