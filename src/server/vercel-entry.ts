import type { IncomingMessage, ServerResponse } from 'node:http';
import { getService, triggerBackgroundSyncIfNeeded, syncStateInstance } from './service-singleton.ts';
import { handle } from './http.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const log = (msg: string) => console.log(`[vercel] ${msg}`);

  try {
    // Vercel rewrites send the original requested path in x-matched-path header
    const rawPath =
      (req.headers['x-matched-path'] as string) ||
      (req.headers['x-vercel-matched-path'] as string) ||
      req.url ||
      '/';

    let path = rawPath;
    if (path === '/api' || path === '/api/' || path === '/api/index.ts' || path === '/api/index' || path === '/api/index.js') {
      path = '/';
    } else if (path.startsWith('/api?') || path.startsWith('/api/?')) {
      path = '/' + path.substring(path.indexOf('?'));
    }
    req.url = path;

    const service = getService();
    triggerBackgroundSyncIfNeeded(service, log);

    await handle(service, req, res, { port: 8787 }, log, syncStateInstance);
  } catch (err) {
    log(`Fatal handler error: ${err instanceof Error ? err.stack : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'internal_server_error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        })
      );
    }
  }
}
