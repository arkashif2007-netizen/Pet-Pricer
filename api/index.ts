import type { IncomingMessage, ServerResponse } from 'node:http';
import { getService, triggerBackgroundSyncIfNeeded, syncStateInstance } from '../src/server/service-singleton.ts';
import { handle } from '../src/server/http.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const log = (msg: string) => console.log(`[vercel] ${msg}`);

  try {
    // Normalize Vercel internal rewrite paths to root
    if (req.url) {
      const u = req.url;
      if (u === '/api' || u === '/api/' || u === '/api/index.ts' || u === '/api/index') {
        req.url = '/';
      } else if (u.startsWith('/api?') || u.startsWith('/api/?') || u.startsWith('/api/index.ts?') || u.startsWith('/api/index?')) {
        const query = u.substring(u.indexOf('?'));
        req.url = '/' + query;
      }
    }

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
