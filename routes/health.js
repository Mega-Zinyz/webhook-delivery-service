const express = require('express');

module.exports = (startedAt) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
