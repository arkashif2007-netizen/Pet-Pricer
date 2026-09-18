import { getService } from '../src/server/service-singleton.ts';
import { handleWebRequest } from '../src/server/web.ts';
import netlifyHandler from '../netlify/functions/api.ts';
import { handler as netlifyV1Handler } from '../netlify/functions/api.ts';

async function run() {
  console.log('Testing handleWebRequest and Netlify functions...');
  const service = getService();

  // Test 1: GET / (Dashboard HTML)
  const reqRoot = new Request('https://pet-pricer.netlify.app/');
  const resRoot = await handleWebRequest(service, reqRoot);
  console.log(`[Test 1] GET / -> status ${resRoot.status}, contentType: ${resRoot.headers.get('content-type')}`);
  if (resRoot.status !== 200) throw new Error(`Expected 200, got ${resRoot.status}`);
  const html = await resRoot.text();
  if (!html.includes('Pet Pricer')) throw new Error('Dashboard HTML does not contain Pet Pricer');
  console.log('  ✔ Dashboard HTML rendered successfully');

  // Test 2: GET /api/status
  const reqStatus = new Request('https://pet-pricer.netlify.app/api/status');
  const resStatus = await handleWebRequest(service, reqStatus);
  console.log(`[Test 2] GET /api/status -> status ${resStatus.status}`);
  if (resStatus.status !== 200) throw new Error(`Expected 200, got ${resStatus.status}`);
  const statusJson = (await resStatus.json()) as any;
  console.log(`  ✔ Status JSON returned: ${statusJson.petCount} pets, ${statusJson.itemCount} items`);

  // Test 3: GET /api/opportunities
  const reqOpp = new Request('https://pet-pricer.netlify.app/api/opportunities');
  const resOpp = await handleWebRequest(service, reqOpp);
  console.log(`[Test 3] GET /api/opportunities -> status ${resOpp.status}`);
  if (resOpp.status !== 200) throw new Error(`Expected 200, got ${resOpp.status}`);
  const oppJson = (await resOpp.json()) as any;
  console.log(`  ✔ Opportunities JSON returned: count=${oppJson.count}`);

  // Test 4: Netlify v2 handler (default export)
  const netlifyV2Res = await netlifyHandler(new Request('https://pet-pricer.netlify.app/api/pets'));
  console.log(`[Test 4] Netlify v2 GET /api/pets -> status ${netlifyV2Res.status}`);
  if (netlifyV2Res.status !== 200) throw new Error(`Expected 200, got ${netlifyV2Res.status}`);
  const petsJson = (await netlifyV2Res.json()) as any;
  console.log(`  ✔ Netlify v2 handler returned ${petsJson.count} pets`);

  // Test 5: Netlify v1 handler (AWS Lambda style)
  const netlifyV1Res = await netlifyV1Handler({
    path: '/api/status',
    httpMethod: 'GET',
    headers: { host: 'pet-pricer.netlify.app' },
  }, {});
  console.log(`[Test 5] Netlify v1 GET /api/status -> statusCode ${netlifyV1Res.statusCode}`);
  if (netlifyV1Res.statusCode !== 200) throw new Error(`Expected 200, got ${netlifyV1Res.statusCode}`);
  console.log('  ✔ Netlify v1 handler returned valid response');

  console.log('\nAll web & Netlify tests passed with flying colors! 🎉');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
