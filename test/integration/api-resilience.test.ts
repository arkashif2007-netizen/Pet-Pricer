import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { MarketApi, MarketUnavailableError } from '../../src/core/api.ts';

/**
 * These tests exist because of a concrete operational failure: a burst of
 * ~200 requests to the real host earned an IP-level block, after which every
 * connection timed out while the rest of the internet stayed reachable.
 *
 * Two behaviours have to hold or that happens again, and neither is observable
 * from the happy path:
 *   1. request starts are spaced out regardless of concurrency;
 *   2. a run of connection failures aborts the sweep instead of deepening it.
 *
 * Both are verified here against a local server that can be made to fail on
 * command, so the test is offline and deterministic.
 */

interface Harness {
  server: Server;
  baseUrl: string;
  hits: number[];
  fail: { value: boolean };
}

async function startServer(): Promise<Harness> {
  const harness: Harness = {
    server: createServer(),
    baseUrl: '',
    hits: [],
    fail: { value: false },
  };

  harness.server.on('request', (req, res) => {
    harness.hits.push(Date.now());
    if (harness.fail.value) {
      // Drop the connection the way the blocked host did: no HTTP response.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: true, items: [], count: 0, currency: 'usd' }));
  });

  const port = await new Promise<number>((resolve) => {
    harness.server.listen(0, '127.0.0.1', () => {
      const address = harness.server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  harness.baseUrl = `http://127.0.0.1:${port}`;
  return harness;
}

describe('API resilience', () => {
  let harness: Harness;

  before(async () => {
    harness = await startServer();
  });

  after(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  });

  it('spaces request starts out even when concurrency would allow a burst', async () => {
    harness.hits.length = 0;
    const minIntervalMs = 120;
    const api = new MarketApi({
      baseUrl: harness.baseUrl,
      concurrency: 8, // deliberately high
      minIntervalMs,
      maxRetries: 0,
      timeoutMs: 3_000,
    });

    // Client-side start timestamps. Arrival times at the server are the wrong
    // measurement under parallel test runs: a loaded event loop can deliver
    // two correctly-spaced requests in one scheduling slice, which used to
    // fail this test on arrival gaps that the client never actually emitted.
    const starts: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      starts.push(Date.now());
      return (originalFetch as typeof fetch)(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
    }) as typeof fetch;

    try {
      const started = Date.now();
      await Promise.all(
        Array.from({ length: 5 }, () =>
          api.listItems({ filter: { types: [{ type: 'pet' }] }, page: 1, amount: 1 })
        )
      );
      const elapsed = Date.now() - started;

      assert.equal(harness.hits.length, 5, 'every request should reach the server');
      assert.equal(starts.length, 5, 'every request start should be observed');
      // 5 starts with a 120ms floor need at least 4 gaps.
      assert.ok(
        elapsed >= 4 * minIntervalMs * 0.8,
        `expected throttling to spread 5 requests over >=${4 * minIntervalMs}ms, took ${elapsed}ms`
      );

      // The starts themselves must respect the floor. A small tolerance
      // absorbs timer clamping; a true burst would show gaps near zero.
      const sorted = [...starts].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i] as number) - (sorted[i - 1] as number);
        assert.ok(gap >= minIntervalMs * 0.5, `request starts ${i - 1}/${i} were only ${gap}ms apart`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('gives up on a dead host instead of retrying forever', async () => {
    harness.fail.value = true;
    const api = new MarketApi({
      baseUrl: harness.baseUrl,
      concurrency: 2,
      minIntervalMs: 0,
      maxRetries: 0, // isolate the breaker from the retry loop
      maxConsecutiveFailures: 3,
      timeoutMs: 2_000,
    });
    const attempt = () =>
      api.listItems({ filter: { types: [{ type: 'pet' }] }, page: 1, amount: 1 });

    // The breaker counts *consecutive failures*, not calls, so it trips partway
    // through a sweep rather than on the first blip.
    for (let call = 1; call <= 2; call++) {
      await assert.rejects(attempt, (error: unknown) => {
        assert.ok(
          !(error instanceof MarketUnavailableError),
          `call ${call} failed before the threshold was reached`
        );
        return true;
      });
    }

    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(
        error instanceof MarketUnavailableError,
        `expected MarketUnavailableError, got ${String(error)}`
      );
      assert.match(error.message, /rate-limit block/);
      assert.match(error.message, /STARPETS_MIN_INTERVAL_MS/);
      return true;
    });

    assert.equal(api.metrics.blocked, true, 'the breaker should mark the client blocked');

    harness.fail.value = false;
  });

  it('recovers once the host answers again', async () => {
    harness.fail.value = false;
    const api = new MarketApi({
      baseUrl: harness.baseUrl,
      minIntervalMs: 0,
      maxRetries: 0,
      maxConsecutiveFailures: 3,
      timeoutMs: 3_000,
    });
    const result = await api.listItems({ filter: { types: [{ type: 'pet' }] }, page: 1, amount: 1 });
    assert.equal(result.status, true);
    assert.equal(api.metrics.blocked, false);
  });

  it('surfaces the server validation message without retrying it', async () => {
    // A 400 is our fault, not a transient failure: it must fail fast and carry
    // the service's own explanation, which is how the schema was discovered.
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: false,
          code: 110,
          statusCode: 'INVALID_PARAMS',
          details: { details: [{ message: 'page must be less than or equal to 120' }] },
        })
      );
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    try {
      const api = new MarketApi({ baseUrl: `http://127.0.0.1:${port}`, minIntervalMs: 0, maxRetries: 3 });
      await assert.rejects(
        () => api.listItems({ filter: { types: [{ type: 'pet' }] }, page: 1, amount: 1 }),
        /page must be less than or equal to 120/
      );
      assert.equal(api.metrics.retries, 0, 'a 400 must not be retried');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
