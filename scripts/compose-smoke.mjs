import assert from 'node:assert/strict';
const base = 'http://localhost:3000';
const input = {
  label: 'Compose persistence check',
  operationId: '00000000-0000-4000-8000-000000000002',
};
assert.equal((await fetch(`${base}/api/v1/health/ready`)).status, 200);
assert.equal((await fetch(`${base}/`)).status, 200);
assert.equal((await fetch(`${base}/login`)).status, 200);
assert.equal((await fetch(`${base}/plan`)).status, 401);
assert.equal((await fetch(`${base}/temporary/private.json`)).status, 404);
const captcha = await (await fetch(`${base}/api/v1/auth/captcha?purpose=login`)).json();
assert.ok(captcha.data.imageDataUrl.startsWith('data:image/png;base64,'));
if (process.argv[2] !== 'verify') {
  const response = await fetch(`${base}/api/v1/dev/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.ok([200, 201].includes(response.status));
}
const records = await (await fetch(`${base}/api/v1/dev/records`)).json();
assert.equal(records.data.filter((record) => record.operationId === input.operationId).length, 1);
console.log('Compose API, SPA routing and persisted record verified.');
