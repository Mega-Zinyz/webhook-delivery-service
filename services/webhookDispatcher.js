const http = require('node:http');
const https = require('node:https');
const { database } = require('../config/sqlite-database');
const TokenBucket = require('../utils/tokenBucket');
const { safeLookup } = require('../utils/webhookUrl');

const automaticRetryWindowMs = Number(process.env.WEBHOOK_RETRY_WINDOW_MS || 24 * 60 * 60 * 1000);
if (!Number.isSafeInteger(automaticRetryWindowMs) || automaticRetryWindowMs <= 0) {
  throw new Error('WEBHOOK_RETRY_WINDOW_MS must be a positive integer');
}
const initialRetryDelayMs = 1000;
const maxRetryDelayMs = 5 * 60 * 1000;
const deliveryTimeoutMs = 5000;
const pollIntervalMs = 250;
const maxConcurrentDeliveries = 10;
const perSubscriptionBurst = 5;
const perSubscriptionRatePerSecond = 1;
const activeSubscriptions = new Set();
const activeDeliveries = new Set();
const deliveryBuckets = new TokenBucket({
  capacity: perSubscriptionBurst,
  refillRatePerSecond: perSubscriptionRatePerSecond,
});

function retryDelay(attemptCount, retryAfterMs) {
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, maxRetryDelayMs);
  }
  const exponentialDelay = Math.min(initialRetryDelayMs * (2 ** (attemptCount - 1)), maxRetryDelayMs);
  return Math.min(Math.round(exponentialDelay * (0.5 + Math.random())), maxRetryDelayMs);
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function requestWebhook(event) {
  const endpointUrl = new URL(event.endpoint_url);
  const requestModule = endpointUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = requestModule.request(endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(event.payload),
        'idempotency-key': event.id,
        'x-webhook-event-id': event.id,
        'x-webhook-subscription-id': event.subscription_id,
      },
      lookup: safeLookup,
      signal: AbortSignal.timeout(deliveryTimeoutMs),
    }, (response) => {
      const result = {
        status: response.statusCode || 0,
        retryAfterMs: parseRetryAfter(response.headers['retry-after']),
      };
      response.destroy();
      resolve(result);
    });

    request.once('error', reject);
    request.end(event.payload);
  });
}

function beginAttempt(event, now) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const claimed = database.prepare(`
      UPDATE events SET status = 'delivering', attempt_count = attempt_count + 1,
        first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, now, event.id);
    if (claimed.changes === 0) {
      database.exec('ROLLBACK');
      return null;
    }

    const attemptNumber = database.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt
      FROM delivery_attempts WHERE event_id = ?
    `).get(event.id).next_attempt;
    const inserted = database.prepare(`
      INSERT INTO delivery_attempts (event_id, attempt_number, started_at)
      VALUES (?, ?, ?)
    `).run(event.id, attemptNumber, now);
    const attemptCount = database.prepare('SELECT attempt_count FROM events WHERE id = ?').get(event.id).attempt_count;
    database.exec('COMMIT');
    return { id: inserted.lastInsertRowid, attemptCount };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function finishAttempt(eventId, attemptId, { status, error, retryAfterMs }, attemptCount, firstAttemptAt) {
  const completedAt = Date.now();
  const succeeded = status >= 200 && status < 300;
  const retryable = status === null || status === 0 || status === 408 || status === 429 || status >= 500;
  const windowExpired = completedAt - firstAttemptAt >= automaticRetryWindowMs;
  const terminal = !succeeded && (!retryable || windowExpired);
  const nextAttemptAt = terminal ? completedAt : completedAt + retryDelay(attemptCount, retryAfterMs);
  const lastError = succeeded ? null : error;

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      UPDATE delivery_attempts
      SET completed_at = ?, http_status = ?, error = ?, retry_after_ms = ?
      WHERE id = ?
    `).run(completedAt, status, error, retryAfterMs, attemptId);

    database.prepare(`
      UPDATE events SET status = ?, next_attempt_at = ?, last_error = ?, delivered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      succeeded ? 'delivered' : (terminal ? 'failed' : 'pending'),
      nextAttemptAt,
      lastError,
      succeeded ? completedAt : null,
      completedAt,
      eventId,
    );
    database.exec('COMMIT');
  } catch (databaseError) {
    database.exec('ROLLBACK');
    throw databaseError;
  }

  if (!succeeded) {
    const reason = terminal
      ? (retryable ? 'retry window expired' : 'non-retryable response')
      : 'will retry';
    console.error(`Webhook delivery ${eventId} failed (attempt ${attemptCount}, ${reason}): ${error}`);
  }
}

async function deliver(event) {
  const startedAt = Date.now();
  const attempt = beginAttempt(event, startedAt);
  if (!attempt) {
    return;
  }
  const firstAttemptAt = event.first_attempt_at || startedAt;

  let result;
  try {
    const { status, retryAfterMs } = await requestWebhook(event);
    result = {
      status,
      error: status >= 200 && status < 300 ? null : `Endpoint returned HTTP ${status}`,
      retryAfterMs,
    };
  } catch (error) {
    result = { status: null, error: error.message, retryAfterMs: null };
  }
  finishAttempt(event.id, attempt.id, result, attempt.attemptCount, firstAttemptAt);
}

function dispatchDueEvents() {
  try {
    const now = Date.now();
    const retryCutoff = now - automaticRetryWindowMs;
    database.prepare(`
      UPDATE events SET status = 'failed', updated_at = ?,
        last_error = COALESCE(last_error, 'Automatic retry window expired')
      WHERE status = 'pending' AND first_attempt_at IS NOT NULL AND first_attempt_at <= ?
    `).run(now, retryCutoff);
    deliveryBuckets.prune(now);

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
      const bucket = deliveryBuckets.take(event.subscription_id, now);
      if (!bucket.allowed) {
        database.prepare(`
          UPDATE events SET next_attempt_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(bucket.retryAt, now, event.id);
        continue;
      }

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

module.exports = {
  start,
  stop,
  waitForDeliveries,
  getConcurrency: () => activeDeliveries.size,
};
