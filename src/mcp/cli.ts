#!/usr/bin/env node
/**
 * MCP stdio entry point.
 *
 *   node src/mcp/cli.ts
 *
 * Reads the same snapshot the collector writes, through the same
 * `ScannerService` the HTTP API uses. Sharing the service layer (rather than
 * having MCP re-implement the margin maths or proxy HTTP) guarantees the
 * assistant and the Android app can never disagree about a number.
 *
 * NOTHING may be written to stdout except MCP protocol frames, so all logging
 * goes to stderr.
 */

import { Store } from '../collector/store.ts';
import { loadConfig } from '../config.ts';
import { MarketApi } from '../core/api.ts';
import { ScannerService } from '../service.ts';
import { createMcpServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const api = new MarketApi({
    baseUrl: config.storeBaseUrl,
    currency: config.currency,
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  const service = new ScannerService(store, api, config);
  const server = createMcpServer(service);

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();

  const status = service.status();
  console.error(
    `[mcp] ready — snapshot ${status.itemCount} items / ${status.petCount} pets` +
      (service.isStale() ? ' (STALE: run npm run sweep)' : '')
  );

  const shutdown = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch((error) => {
  console.error('[mcp] fatal:', error);
  process.exit(1);
});
