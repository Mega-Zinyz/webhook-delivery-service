const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { after, before, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-service-test-'));
process.env.WEBHOOK_DB_PATH = path.join(temporaryDirectory, 'test.sqlite');
process.env.WEBHOOK_ALLOW_PRIVATE_ENDPOINTS = 'true';
process.env.WEBHOOK_RETRY_WINDOW_MS = '5000';

const app = require('../index');
const { database } = require('../config/sqlite-database');
const webhookDispatcher = require('../services/webhookDispatcher');
const TokenBucket = require('../utils/tokenBucket');
const { isPublicAddress, validateWebhookUrl } = require('../utils/webhookUrl');

let serviceServer;
let receiverServer;
let serviceUrl;
let receiverUrl;
const receivedEvents = [];
const attemptsByEvent = new Map();

before(async () => {
  receiverServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const eventId = req.headers['x-webhook-event-id'];
      const attempt = (attemptsByEvent.get(eventId) || 0) + 1;
      attemptsByEvent.set(eventId, attempt);
      receivedEvents.push({
        eventId,
        path: req.url,
        idempotencyKey: req.headers['idempotency-key'],
        body: Buffer.concat(chunks).toString(),
        receivedAt: Date.now(),
      });

      if (req.url === '/always-400') {
        res.writeHead(400);
        res.end('invalid');
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' });
        res.end('redirect');
        return;
      }
      if (req.url === '/retry-once' && attempt === 1) {
        res.writeHead(503, { 'retry-after': '0' });
        res.end('temporary');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${receiverServer.address().port}`;

  serviceServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => serviceServer.once('listening', resolve));
  serviceUrl = `http://127.0.0.1:${serviceServer.address().port}`;
  webhookDispatcher.start();
});

after(async () => {
  webhookDispatcher.stop();
  await webhookDispatcher.waitForDeliveries();
  await new Promise((resolve) => serviceServer.close(resolve));
  await new Promise((resolve) => receiverServer.close(resolve));
  database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function requestJson(method, route, body, headers = {}) {
  const response = await fetch(`${serviceUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function registerSubscription(subscriptionId, endpointUrl) {
  const result = await requestJson('POST', '/subscriptions', { subscriptionId, endpointUrl });
  assert.equal(result.response.status, 201);
}

async function waitForEvent(eventId, expectedStatus, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await requestJson('GET', `/events/${eventId}`);
    if (result.body.status === expectedStatus) {
      return result.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Event ${eventId} did not reach status ${expectedStatus}`);
}

test('webhook delivery, retry classification, safety, and metrics', async (t) => {
  await t.test('blocks private callback addresses unless explicitly allowed', async () => {
    assert.equal(isPublicAddress('127.0.0.1'), false);
    assert.equal(isPublicAddress('10.0.0.1'), false);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    await assert.rejects(
      validateWebhookUrl('http://127.0.0.1:4100/webhook', false),
      /only to public IP addresses/,
    );
  });

  await t.test('deduplicates producer retries using Idempotency-Key', async () => {
    await registerSubscription('idempotent', `${receiverUrl}/ok`);
    const first = await requestJson('POST', '/events', {
      subscriptionId: 'idempotent',
      payload: { value: 1 },
    }, { 'Idempotency-Key': 'producer-event-1' });
    const duplicate = await requestJson('POST', '/events', {
      subscriptionId: 'idempotent',
      payload: { value: 1 },
    }, { 'Idempotency-Key': 'producer-event-1' });

    assert.equal(first.response.status, 202);
    assert.equal(duplicate.body.eventId, first.body.eventId);
    assert.equal(duplicate.body.deduplicated, true);
    await waitForEvent(first.body.eventId, 'delivered');
    assert.equal(receivedEvents.filter((event) => event.eventId === first.body.eventId).length, 1);
  });

  await t.test('does not retry permanent 4xx responses and records attempt history', async () => {
    await registerSubscription('permanent-error', `${receiverUrl}/always-400`);
    const accepted = await requestJson('POST', '/events', {
      subscriptionId: 'permanent-error',
      payload: { value: 'bad' },
    });
    const status = await waitForEvent(accepted.body.eventId, 'failed');
    assert.equal(status.attemptCount, 1);

    const history = await requestJson('GET', `/events/${accepted.body.eventId}/attempts`);
    assert.equal(history.body.attempts.length, 1);
    assert.equal(history.body.attempts[0].httpStatus, 400);
    assert.match(history.body.attempts[0].error, /HTTP 400/);
  });

  await t.test('does not follow callback redirects', async () => {
    await registerSubscription('redirect', `${receiverUrl}/redirect`);
    const accepted = await requestJson('POST', '/events', {
      subscriptionId: 'redirect',
      payload: { value: 'redirect' },
    });
    const status = await waitForEvent(accepted.body.eventId, 'failed');
    assert.equal(status.attemptCount, 1);
    assert.equal(receivedEvents.some((event) => (
      event.eventId === accepted.body.eventId && event.path === '/ok'
    )), false);
  });

  await t.test('retries 5xx responses and respects Retry-After', async () => {
    await registerSubscription('temporary-error', `${receiverUrl}/retry-once`);
    const accepted = await requestJson('POST', '/events', {
      subscriptionId: 'temporary-error',
      payload: { value: 'retry' },
    });
    const status = await waitForEvent(accepted.body.eventId, 'delivered');
    assert.equal(status.attemptCount, 2);

    const history = await requestJson('GET', `/events/${accepted.body.eventId}/attempts`);
    assert.deepEqual(history.body.attempts.map((attempt) => attempt.httpStatus), [503, 200]);
    assert.equal(history.body.attempts[0].retryAfterMs, 0);
  });

  await t.test('limits delivery rate per subscription while preserving order', async () => {
    await registerSubscription('rate-limited', `${receiverUrl}/ok`);
    const eventIds = [];
    for (let index = 0; index < 6; index += 1) {
      const accepted = await requestJson('POST', '/events', {
        subscriptionId: 'rate-limited',
        payload: { sequence: index },
      });
      eventIds.push(accepted.body.eventId);
    }

    for (const eventId of eventIds) {
      await waitForEvent(eventId, 'delivered');
    }
    const deliveries = receivedEvents
      .filter((event) => eventIds.includes(event.eventId))
      .sort((left, right) => left.receivedAt - right.receivedAt);
    assert.deepEqual(deliveries.map((event) => event.eventId), eventIds);
    assert.ok(deliveries[5].receivedAt - deliveries[0].receivedAt >= 500);
  });

  await t.test('reports operational queue metrics', async () => {
    const metrics = await requestJson('GET', '/metrics');
    assert.equal(metrics.response.status, 200);
    assert.ok(metrics.body.events.delivered >= 2);
    assert.ok(metrics.body.events.failed >= 1);
    assert.equal(typeof metrics.body.activeDeliveries, 'number');
  });

  await t.test('enforces token-bucket burst and refill', () => {
    const bucket = new TokenBucket({ capacity: 2, refillRatePerSecond: 1 });
    assert.equal(bucket.take('subscription', 1000).allowed, true);
    assert.equal(bucket.take('subscription', 1000).allowed, true);
    const limited = bucket.take('subscription', 1000);
    assert.equal(limited.allowed, false);
    assert.equal(limited.retryAt, 2000);
    assert.equal(bucket.take('subscription', 2000).allowed, true);
  });
});
