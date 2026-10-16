const express = require('express');
const { database } = require('../config/sqlite-database');

const router = express.Router();

router.post('/', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const { subscriptionId, endpointUrl } = req.body;
  if (typeof subscriptionId !== 'string' || subscriptionId.trim() === '') {
    return res.status(400).json({ error: 'subscriptionId must be a non-empty string' });
  }
  if (typeof endpointUrl !== 'string') {
    return res.status(400).json({ error: 'endpointUrl must be a valid HTTP or HTTPS URL' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(endpointUrl);
  } catch {
    return res.status(400).json({ error: 'endpointUrl must be a valid HTTP or HTTPS URL' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    return res.status(400).json({ error: 'endpointUrl must be a valid HTTP or HTTPS URL without credentials' });
  }

  const normalizedSubscriptionId = subscriptionId.trim();
  const normalizedEndpointUrl = parsedUrl.toString();
  const now = Date.now();
  database.prepare(`
    INSERT INTO subscriptions (id, endpoint_url, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET endpoint_url = excluded.endpoint_url, updated_at = excluded.updated_at
  `).run(normalizedSubscriptionId, normalizedEndpointUrl, now, now);

  res.status(201).json({
    subscriptionId: normalizedSubscriptionId,
    endpointUrl: normalizedEndpointUrl,
  });
});

module.exports = router;
