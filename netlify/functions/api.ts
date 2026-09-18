import { getService, triggerBackgroundSyncIfNeeded, syncStateInstance } from '../../src/server/service-singleton.ts';
import { handleWebRequest } from '../../src/server/web.ts';

// Modern Netlify Functions v2 (Standard Web Request/Response)
export default async function (req: Request): Promise<Response> {
  const service = getService();
  triggerBackgroundSyncIfNeeded(service);
  return handleWebRequest(service, req, { syncState: syncStateInstance });
}

// Universal Netlify Functions v1 handler (Classic AWS Lambda style)
export const handler = async (event: any, _context: any) => {
  const service = getService();
  triggerBackgroundSyncIfNeeded(service);

  const protocol = event.headers?.['x-forwarded-proto'] || 'https';
  const host = event.headers?.host || 'localhost';
  const qs = event.queryStringParameters ? '?' + new URLSearchParams(event.queryStringParameters).toString() : '';
  const url = `${protocol}://${host}${event.path || '/'}${qs}`;

  const request = new Request(url, {
    method: event.httpMethod || 'GET',
    headers: event.headers,
    body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined,
  });

  const response = await handleWebRequest(service, request, { syncState: syncStateInstance });
  const bodyText = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((val, key) => {
    responseHeaders[key] = val;
  });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: bodyText,
  };
};

export const config = {
  path: '/*',
};
