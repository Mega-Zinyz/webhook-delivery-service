const express = require('express');
const { database, databasePath } = require('./config/sqlite-database');
const eventsRouter = require('./routes/events');
const healthRouter = require('./routes/health');
const subscriptionsRouter = require('./routes/subscriptions');
const errorHandler = require('./utils/errorHandler');
const notFoundHandler = require('./utils/notFoundHandler');
const requestLogger = require('./utils/requestLogger');
const webhookDispatcher = require('./services/webhookDispatcher');

const app = express();
const port = Number(process.env.PORT) || 3000;
const startedAt = Date.now();

app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);
app.use('/health', healthRouter(startedAt));
app.use('/subscriptions', subscriptionsRouter);
app.use('/events', eventsRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let server;
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  webhookDispatcher.stop();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await webhookDispatcher.waitForDeliveries();
  database.close();
  process.exit(0);
}

if (require.main === module) {
  server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Webhook database: ${databasePath}`);
  });
  webhookDispatcher.start();
  ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

module.exports = app;
