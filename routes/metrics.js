const express = require('express');
const { database } = require('../config/sqlite-database');
const webhookDispatcher = require('../services/webhookDispatcher');

const router = express.Router();

router.get('/', (req, res) => {
  const counts = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM events
    GROUP BY status
  `).all().reduce((result, row) => {
    result[row.status] = row.count;
    return result;
  }, {
    pending: 0,
    delivering: 0,
    delivered: 0,
    failed: 0,
  });

  const oldestPending = database.prepare(`
    SELECT MIN(created_at) AS created_at FROM events WHERE status = 'pending'
  `).get();

  res.status(200).json({
    events: counts,
    oldestPendingAgeSeconds: oldestPending.created_at === null
      ? null
      : Math.floor((Date.now() - oldestPending.created_at) / 1000),
    activeDeliveries: webhookDispatcher.getConcurrency(),
  });
});

module.exports = router;
