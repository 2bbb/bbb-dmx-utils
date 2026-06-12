import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createFixtureEditorServer } from '../dist/web.js';

const server = createFixtureEditorServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
  const health = await fetch(`${base}/api/health`).then((res) => res.json());
  if(!health.ok) throw new Error('health endpoint did not return ok');

  const contentBase64 = readFileSync(new URL('minimal.gdtf.xml', import.meta.url)).toString('base64');
  const convertedResponse = await fetch(`${base}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'minimal.gdtf.xml', format: 'gdtf-xml', contentBase64 })
  });
  const converted = await convertedResponse.json();
  if(!convertedResponse.ok) throw new Error(converted.error ?? 'convert endpoint failed');
  if(converted.profiles?.[0]?.profile?.schema !== 'bbb.dmx.fixture.profile.v1') throw new Error('convert endpoint did not return a fixture profile');

  const validationResponse = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documents: [{ name: 'profile.json', data: converted.profiles[0].profile }] })
  });
  const validation = await validationResponse.json();
  if(!validationResponse.ok || !validation.ok) throw new Error(`validate endpoint failed: ${JSON.stringify(validation)}`);

  const page = await fetch(`${base}/`).then((res) => res.text());
  if(!page.includes('fixture / coordinate editor')) throw new Error('editor page did not render');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if(!script) throw new Error('editor page did not include client script');
  new Function(script);
} finally {
  server.close();
}
