const crypto = require('node:crypto');
const express = require('express');
const { database } = require('../config/sqlite-database');

const router = express.Router();

router.post('/', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const { subscriptionId } = req.body;
  if (typeof subscriptionId !== 'string' || subscriptionId.trim() === '') {
    return res.status(400).json({ error: 'subscriptionId must be a non-empty string' });
  }
  if (!Object.prototype.hasOwnProperty.call(req.body, 'payload')) {
    return res.status(400).json({ error: 'payload is required' });
  }

  const normalizedSubscriptionId = subscriptionId.trim();
  const subscription = database.prepare(`
    SELECT endpoint_url FROM subscriptions WHERE id = ?
  `).get(normalizedSubscriptionId);
  if (!subscription) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  database.prepare(`
    INSERT INTO events (
      id, subscription_id, endpoint_url, payload, status, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    id,
    normalizedSubscriptionId,
    subscription.endpoint_url,
    JSON.stringify(req.body.payload),
    now,
    now,
    now,
  );

  res.status(202).json({ eventId: id, status: 'pending' });
});

router.get('/:eventId', (req, res) => {
  const event = database.prepare(`
    SELECT id, subscription_id AS subscriptionId, status, attempt_count AS attemptCount,
      next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt,
      updated_at AS updatedAt, delivered_at AS deliveredAt
    FROM events WHERE id = ?
  `).get(req.params.eventId);

  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  if (event.status === 'delivering') {
    event.status = 'pending';
  }
  res.status(200).json(event);
});

router.post('/:eventId/retry', (req, res) => {
  const now = Date.now();
  const result = database.prepare(`
    UPDATE events SET status = 'pending', attempt_count = 0, first_attempt_at = NULL, next_attempt_at = ?,
      last_error = NULL, updated_at = ?, delivered_at = NULL
    WHERE id = ? AND status = 'failed'
  `).run(now, now, req.params.eventId);

  if (result.changes === 0) {
    const exists = database.prepare('SELECT status FROM events WHERE id = ?').get(req.params.eventId);
    if (!exists) {
      return res.status(404).json({ error: 'Event not found' });
    }
    return res.status(409).json({ error: 'Only failed events can be retried', status: exists.status });
  }

  res.status(202).json({ eventId: req.params.eventId, status: 'pending' });
});

module.exports = router;
