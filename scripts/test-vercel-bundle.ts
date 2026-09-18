// @ts-ignore
import handler from '../api/index.js';
import { EventEmitter } from 'node:events';

async function invoke(url: string) {
  const req = Object.assign(new EventEmitter(), {
    url,
    method: 'GET',
    headers: {
      host: 'pet-pricer.vercel.app',
      'x-matched-path': url,
    },
  });

  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body = '';

  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(status: number, hdrs: Record<string, string> = {}) {
      statusCode = status;
      headers = hdrs;
      return this;
    },
    setHeader(name: string, val: string) {
      headers[name] = val;
      return this;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      this.headersSent = true;
      return this;
    },
  });

  await handler(req as any, res as any);
  return { statusCode, headers, body };
}

async function run() {
  console.log('Testing bundled api/index.js across multiple routes...');

  // 1. Test Dashboard HTML (root /)
  const resRoot = await invoke('/');
  console.log(`[Test 1] GET / -> status ${resRoot.statusCode}, isHtml: ${resRoot.body.includes('Pet Pricer')}`);
  if (resRoot.statusCode !== 200 || !resRoot.body.includes('Pet Pricer')) {
    throw new Error('Root dashboard failed');
  }

  // 2. Test /api/status
  const resStatus = await invoke('/api/status');
  console.log(`[Test 2] GET /api/status -> status ${resStatus.statusCode}`);
  const statusObj = JSON.parse(resStatus.body);
  console.log(`  ✔ Returned ${statusObj.petCount} pets, ${statusObj.itemCount} items`);

  // 3. Test /api/opportunities
  const resOpp = await invoke('/api/opportunities');
  console.log(`[Test 3] GET /api/opportunities -> status ${resOpp.statusCode}`);
  const oppObj = JSON.parse(resOpp.body);
  console.log(`  ✔ Returned ${oppObj.count} opportunities`);

  // 4. Test /api/catalog
  const resCat = await invoke('/api/catalog?rarity=rare,ultra_rare,legendary&fee=0.25&cap=3');
  console.log(`[Test 4] GET /api/catalog -> status ${resCat.statusCode}`);
  const catObj = JSON.parse(resCat.body);
  console.log(`  ✔ Returned ${catObj.count} catalog items`);

  console.log('\nAll Vercel bundle tests passed! 🚀');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
