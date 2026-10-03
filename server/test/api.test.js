import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';

let server, base;
before(() => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.INVITE_CODE;
  server = createApp(openDb(':memory:')).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(() => server.close());

// Tiny client with its own cookie jar (one per "person").
const client = () => {
  let cookie = '';
  return async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...headers }, body: body && JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  };
};
const pi = (token) => (b) => fetch(base + '/device/readings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json() }));
const newPi = async () => (await (await fetch(base + '/device/register', { method: 'POST' })).json());

test('signup, login, logout, validation', async () => {
  const a = client();
  assert.equal((await a('/plants')).status, 401);
  assert.equal((await a('/auth/signup', 'POST', { email: 'bad', password: '12345678' })).status, 400);
  assert.equal((await a('/auth/signup', 'POST', { email: 'a@x.com', password: 'short' })).status, 400);
  assert.equal((await a('/auth/signup', 'POST', { email: 'a@x.com', password: 'password1' })).status, 201);
  assert.equal((await a('/auth/me')).data.user.email, 'a@x.com');
  assert.equal((await a('/auth/signup', 'POST', { email: 'A@x.com', password: 'password1' })).status, 409);
  await a('/auth/logout', 'POST');
  assert.equal((await a('/auth/me')).status, 401);
  const b = client();
  assert.equal((await b('/auth/login', 'POST', { email: 'a@x.com', password: 'wrongpass' })).status, 401);
  assert.equal((await b('/auth/login', 'POST', { email: 'a@x.com', password: 'password1' })).status, 200);
});

test('Pi pairing: unclaimed device gets a code, claiming links it to the user', async () => {
  const u = client(); await u('/auth/signup', 'POST', { email: 'p@x.com', password: 'password1' });
  const dev = await newPi(); const send = pi(dev.device_token);
  const first = await send({ moisture: 60, temperature: 24, ph: 6.4 });
  assert.equal(first.data.claimed, false); assert.equal(first.data.pairing_code, dev.pairing_code);
  assert.equal((await u('/devices/claim', 'POST', { code: 'WRONG123' })).status, 404);
  const claim = await u('/devices/claim', 'POST', { code: dev.pairing_code.toLowerCase(), plant_name: 'Monty' });
  assert.equal(claim.status, 201);
  assert.equal((await u('/devices/claim', 'POST', { code: dev.pairing_code })).status, 404); // single use
  const ok = await send({ moisture: 60, temperature: 24, ph: 6.4 });
  assert.equal(ok.data.claimed, true); assert.equal(ok.data.health.label, 'thriving');
  assert.equal((await send({ moisture: 'x', temperature: 1, ph: 1 })).status, 400);
  const plants = (await u('/plants')).data;
  assert.equal(plants[0].name, 'Monty'); assert.equal(plants[0].device_online, true); assert.equal(plants[0].latest.moisture, 60);
  assert.equal((await pi('bogus')({})).status, 401);
});

test('auto-irrigation, manual watering is queued then delivered to the Pi', async () => {
  const u = client(); await u('/auth/signup', 'POST', { email: 'w@x.com', password: 'password1' });
  const dev = await newPi(); const send = pi(dev.device_token);
  const { data: c } = await u('/devices/claim', 'POST', { code: dev.pairing_code });
  const dry = await send({ moisture: 30, temperature: 24, ph: 6.4 });
  assert.equal(dry.data.pump.run, true);
  assert.equal((await send({ moisture: 30, temperature: 24, ph: 6.4 })).data.pump.run, false); // cooldown
  await u(`/plants/${c.plant_id}/settings`, 'PUT', { auto_water: false });
  const q = await u(`/plants/${c.plant_id}/water`, 'POST');
  assert.equal(q.status, 202); assert.equal(q.data.device_online, true);
  assert.equal((await send({ moisture: 60, temperature: 24, ph: 6.4 })).data.pump.run, true); // delivered
  assert.equal((await send({ moisture: 60, temperature: 24, ph: 6.4 })).data.pump.run, false); // only once
  const log = (await u(`/plants/${c.plant_id}/watering`)).data;
  assert.deepEqual(log.map((e) => e.source).sort(), ['auto', 'manual']);
});

test('users cannot see or touch each other\'s data', async () => {
  const a = client(), b = client();
  await a('/auth/signup', 'POST', { email: 'own@x.com', password: 'password1' });
  await b('/auth/signup', 'POST', { email: 'other@x.com', password: 'password1' });
  const dev = await newPi();
  const { data: c } = await a('/devices/claim', 'POST', { code: dev.pairing_code });
  assert.equal((await b(`/plants/${c.plant_id}`)).status, 404);
  assert.equal((await b(`/plants/${c.plant_id}/readings`)).status, 404);
  assert.equal((await b(`/plants/${c.plant_id}/water`, 'POST')).status, 404);
  assert.equal((await b(`/plants/${c.plant_id}`, 'DELETE')).status, 404);
  assert.equal((await b(`/devices/${c.device_id}`, 'DELETE')).status, 404);
  assert.equal((await b('/plants')).data.length, 0);
  assert.equal((await a(`/plants/${c.plant_id}`)).status, 200);
});

test('removing a device revokes it; AI needs login and falls back safely; cross-site writes are blocked', async () => {
  const u = client(); await u('/auth/signup', 'POST', { email: 'r@x.com', password: 'password1' });
  const dev = await newPi(); const { data: c } = await u('/devices/claim', 'POST', { code: dev.pairing_code });
  assert.equal((await u(`/devices/${c.device_id}`, 'DELETE')).status, 204);
  assert.equal((await pi(dev.device_token)({ moisture: 50, temperature: 20, ph: 6 })).status, 401);
  assert.equal((await client()('/chat', 'POST', { question: 'hi' })).status, 401);
  assert.equal((await u('/chat', 'POST', { question: 'hi' })).data.demo, true);
  assert.equal((await u('/scan', 'POST', { image_base64: 'abc', media_type: 'image/png' })).status, 200);
  assert.equal((await u('/plants', 'GET', null, { origin: 'https://evil.example' })).status, 200); // reads are fine
  assert.equal((await u('/chat', 'POST', { question: 'hi' }, { origin: 'https://evil.example' })).status, 403);
});
