import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { GoogleGenAI, GenerateContentResponse, ApiError } from '@google/genai';
import { createAgent, parseAgentResponse, SYSTEM_INSTRUCTION, DEFAULT_MODEL } from '../server/agent.js';
import { createSessionStore } from '../server/sessions.js';
import { createApp } from '../server/app.js';
import { liveErrorDetails } from '../scripts/live-diagnostics.js';

const card = (overrides = {}) => ({ appliance: null, brand: null, model: null, problem: null, location: null, contact: null, additionalInformation: null, ...overrides });
const reply = (jobCard = card(), text = 'Which appliance needs attention?') => JSON.stringify({ reply: text, jobCard });

// Use actual SDK Chat objects; replace only the outbound model transport.
function fixture(responder = () => reply(), options = {}) {
  const calls = [];
  const client = new GoogleGenAI({ apiKey: 'offline-test-key' });
  client.models.generateContent = async params => {
    calls.push(structuredClone(params));
    const text = await responder(params, calls.length);
    const response = new GenerateContentResponse();
    response.candidates = [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }];
    return response;
  };
  return { agent: createAgent({ client, model: DEFAULT_MODEL, ...options }), calls };
}
async function withServer(t, agent, store) {
  const server = createApp({ agent, store }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  const create = async () => (await request('/api/sessions', {})).body.id;
  return { request, create, base };
}

test('real SDK chat retains turns and receives domain instructions and schema', async () => {
  const { agent, calls } = fixture((params, count) => count === 1
    ? reply(card({ appliance: 'Washing machine', brand: 'Samsung', problem: 'Stopped spinning' }), 'Which suburb are you in?')
    : reply(card({ appliance: 'Washing machine', brand: 'Samsung', problem: 'Stopped spinning', location: 'Randburg' }), 'Please review your request.'));
  const session = { chat: agent.createChat() };
  await agent.respond(session, 'My Samsung washing machine stopped spinning.');
  const result = await agent.respond(session, "I'm in Randburg. Can you summarise what I've told you?");
  assert.equal(calls[0].model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(calls[0].config.systemInstruction, SYSTEM_INSTRUCTION);
  assert.equal(calls[0].config.responseMimeType, 'application/json');
  assert.ok(calls[0].config.responseJsonSchema);
  assert.deepEqual(calls[1].contents.map(content => content.role), ['user', 'model', 'user']);
  assert.match(calls[1].contents[0].parts[0].text, /Samsung/);
  assert.equal(result.jobCard.location, 'Randburg');
  assert.equal(result.jobCard.brand, 'Samsung');
  assert.equal(result.jobCard.status, 'Awaiting business review');
  assert.equal(result.jobCard.contact, null);
});

test('partial job cards remain collecting; model-generated status cannot confirm a booking', () => {
  const result = parseAgentResponse(reply({ ...card({ appliance: 'Fridge' }), status: 'Booking confirmed', readyForReview: true }));
  assert.equal(result.jobCard.status, 'Collecting details');
  assert.equal(result.jobCard.readyForReview, false);
  for (const invalid of ['not json', '{}', reply({ appliance: 'Fridge' }), reply(card({ brand: 123 }))]) {
    assert.throws(() => parseAgentResponse(invalid), { code: 'INVALID_AGENT_RESPONSE' });
  }
});

test('failed or malformed model output rolls history back, then retry succeeds', async () => {
  let fail = false;
  const { agent, calls } = fixture(() => {
    if (fail) return 'not valid json';
    return reply();
  });
  const session = { chat: agent.createChat() };
  await agent.respond(session, 'First detail');
  fail = true;
  await assert.rejects(agent.respond(session, 'Bad turn'), { code: 'INVALID_AGENT_RESPONSE' });
  assert.equal(session.chat.getHistory(true).length, 2);
  fail = false;
  await agent.respond(session, 'Retry detail');
  assert.equal(calls[2].contents.length, 3);
  assert.ok(!JSON.stringify(calls[2].contents).includes('Bad turn'));
});

test('API separates sessions, resumes transcripts, and deletes the old enquiry', async t => {
  const { agent, calls } = fixture();
  const { request, create } = await withServer(t, agent);
  const first = await create();
  const second = await create();
  assert.notEqual(first, second);
  await request(`/api/sessions/${first}/messages`, { message: 'Private Samsung enquiry' });
  await request(`/api/sessions/${second}/messages`, { message: 'A separate fridge enquiry' });
  assert.equal(calls[1].contents.length, 1);
  assert.ok(!JSON.stringify(calls[1].contents).includes('Samsung'));
  assert.equal((await request(`/api/sessions/${first}`)).body.messages[0].text, 'Private Samsung enquiry');
  assert.equal((await request(`/api/sessions/${first}`, undefined, 'DELETE')).status, 204);
  assert.equal((await request(`/api/sessions/${first}`)).status, 404);
  assert.equal((await request(`/api/sessions/${second}`)).body.messages.length, 2);
});

test('request validation rejects empty, oversized, malformed, and invalid-session requests', async t => {
  const { request, create, base } = await withServer(t, fixture().agent);
  const id = await create();
  for (const message of ['', '  ', 123, null, 'x'.repeat(4001)]) {
    assert.equal((await request(`/api/sessions/${id}/messages`, { message })).status, 400);
  }
  assert.equal((await request('/api/sessions/not-a-uuid')).status, 400);
  const malformed = await fetch(`${base}/api/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const tooLarge = await request(`/api/sessions/${id}/messages`, { message: 'x'.repeat(25000) });
  assert.equal(tooLarge.status, 413);
  const wrongType = await fetch(`${base}/api/sessions/${id}/messages`, { method: 'POST', body: 'text' });
  assert.equal(wrongType.status, 415);
  assert.equal((await request(`/api/sessions/${id}`)).body.messages.length, 0);
});

test('missing API credentials produce useful 503 and no internal error details', async t => {
  const { request } = await withServer(t, createAgent({ apiKey: '' }));
  assert.equal((await request('/api/health')).body.configured, false);
  const result = await request('/api/sessions', {});
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'NOT_CONFIGURED');
});

test('provider errors are sanitised, no transcript is committed, and enquiry can retry', async t => {
  let fail = true;
  const { agent } = fixture(() => {
    if (fail) throw Object.assign(new Error('secret-key provider stack trace'), { status: 429 });
    return reply();
  });
  const { request, create } = await withServer(t, agent);
  const id = await create();
  const result = await request(`/api/sessions/${id}/messages`, { message: 'Hello' });
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result.body).includes('secret-key'));
  assert.equal((await request(`/api/sessions/${id}`)).body.messages.length, 0);
  fail = false;
  assert.equal((await request(`/api/sessions/${id}/messages`, { message: 'Retry' })).status, 200);
});

test('network failure returns a safe 502 and preserves a previously collected card', async t => {
  let fail = false;
  const { agent } = fixture(() => {
    if (fail) throw new Error('private provider connection details');
    return reply(card({ appliance: 'Fridge', problem: 'Not cooling' }));
  });
  const { request, create } = await withServer(t, agent);
  const id = await create();
  const previous = await request(`/api/sessions/${id}/messages`, { message: 'My fridge is not cooling.' });
  fail = true;
  const failed = await request(`/api/sessions/${id}/messages`, { message: 'Randburg' });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'ASSISTANT_UNAVAILABLE');
  assert.ok(!JSON.stringify(failed.body).includes('private provider'));
  const current = await request(`/api/sessions/${id}`);
  assert.deepEqual(current.body.jobCard, previous.body.jobCard);
  assert.deepEqual(current.body.messages, previous.body.messages);
});

test('live diagnostics retain actual Gemini status and message without changing public API errors', async t => {
  for (const status of [404, 429]) {
    const provider = new ApiError({ status, message: JSON.stringify({ error: { code: status, message: 'Gemini model is unavailable for this project.' } }) });
    const { agent } = fixture(() => { throw provider; });
    await assert.rejects(agent.respond({ chat: agent.createChat() }, 'Test enquiry'), error => {
      assert.equal(error.cause, provider);
      assert.deepEqual(liveErrorDetails(error), { status, message: 'Gemini model is unavailable for this project.' });
      return true;
    });
    const { request, create } = await withServer(t, agent);
    const id = await create();
    const response = await request(`/api/sessions/${id}/messages`, { message: 'Test enquiry' });
    assert.equal(response.status, status === 429 ? 503 : 502);
    assert.ok(!JSON.stringify(response.body).includes('unavailable for this project'));
    assert.equal(response.body.error.cause, undefined);
  }
});

test('live diagnostics redact configured keys, URL credentials and bearer tokens', () => {
  const key = 'synthetic/key+credential';
  const provider = new ApiError({ status: 403, message: JSON.stringify({ error: {
    message: `Denied ${key}; URL ?key=${encodeURIComponent(key)}&alt=json; x-goog-api-key: other-secret; Bearer token-secret; AIzaSyntheticCredential`,
  } }) });
  const details = liveErrorDetails(provider, key);
  assert.equal(details.status, 403);
  for (const secret of [key, encodeURIComponent(key), 'other-secret', 'token-secret', 'AIzaSyntheticCredential']) {
    assert.ok(!details.message.includes(secret));
  }
  assert.match(details.message, /Denied \[REDACTED\]/);
});

test('network diagnostics do not mistake the app 502 for a Gemini HTTP status', () => {
  const wrapped = new Error('Customer-safe error', { cause: new Error('fetch failed') });
  wrapped.status = 502;
  assert.deepEqual(liveErrorDetails(wrapped), { status: null, message: 'fetch failed' });
});

test('turn limit stops unbounded chat history before a provider request', async t => {
  const { agent, calls } = fixture();
  const store = createSessionStore();
  const session = store.create(agent.createChat());
  session.messages = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: 'Earlier turn' }));
  const { request } = await withServer(t, agent, store);
  const result = await request(`/api/sessions/${session.id}/messages`, { message: 'One more' });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'TURN_LIMIT');
  assert.equal(calls.length, 0);
});

test('concurrent messages and reset cannot interleave the same chat', async t => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const { agent } = fixture(async () => { started(); await new Promise(resolve => { release = resolve; }); return reply(); });
  const { request, create } = await withServer(t, agent);
  const id = await create();
  const first = request(`/api/sessions/${id}/messages`, { message: 'First' });
  await entered;
  try {
    assert.equal((await request(`/api/sessions/${id}/messages`, { message: 'Second' })).status, 409);
    assert.equal((await request(`/api/sessions/${id}`, undefined, 'DELETE')).status, 409);
  } finally { release(); }
  assert.equal((await first).status, 200);
});

test('idle sessions expire and capacity is bounded without evicting active enquiries', () => {
  let time = 0;
  const store = createSessionStore({ ttlMs: 100, maxSessions: 1, now: () => time });
  const first = store.create({});
  assert.throws(() => store.create({}), { code: 'SESSION_LIMIT' });
  first.busy = true;
  time = 101;
  assert.equal(store.get(first.id).id, first.id);
  first.busy = false;
  time = 202;
  assert.throws(() => store.get(first.id), { code: 'SESSION_NOT_FOUND' });
  assert.notEqual(store.create({}).id, first.id);
});

test('serves frontend with security headers and keeps source and credentials private', async t => {
  const { base, request } = await withServer(t, fixture().agent);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Your repair request/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  for (const path of ['/.env', '/server/agent.js', '/package.json']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await request('/api/health')).headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/health')).body.model, DEFAULT_MODEL);
});

test('GEMINI_MODEL selects the configured model and blank values use the working default', () => {
  const previous = process.env.GEMINI_MODEL;
  try {
    delete process.env.GEMINI_MODEL;
    assert.equal(createAgent({ apiKey: '' }).model, 'gemini-3.5-flash-lite');
    process.env.GEMINI_MODEL = '  gemini-3.1-flash-lite  ';
    assert.equal(createAgent({ apiKey: '' }).model, 'gemini-3.1-flash-lite');
    process.env.GEMINI_MODEL = '   ';
    assert.equal(createAgent({ apiKey: '' }).model, DEFAULT_MODEL);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previous;
  }
});

test('custom model is used by the SDK, retries and health endpoint', async t => {
  const { agent, calls } = fixture(() => reply(), { model: 'gemini-3.1-flash-lite' });
  await agent.respond({ chat: agent.createChat() }, 'Test enquiry');
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
  const { request } = await withServer(t, agent);
  assert.equal((await request('/api/health')).body.model, 'gemini-3.1-flash-lite');
});

test('temporary 503 retries once after 500 ms and preserves successful multi-turn history', async () => {
  const delays = [];
  const { agent, calls } = fixture((params, count) => {
    if (count === 2) throw new ApiError({ status: 503, message: 'Temporary high demand' });
    return reply();
  }, { model: 'gemini-3.1-flash-lite', wait: async ms => { delays.push(ms); } });
  const session = { chat: agent.createChat() };
  await agent.respond(session, 'First detail');
  await agent.respond(session, 'Second detail');
  assert.deepEqual(delays, [500]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].contents, calls[2].contents);
  assert.equal(calls[2].contents.length, 3);
  assert.equal(calls[2].model, 'gemini-3.1-flash-lite');
  assert.equal(session.chat.getHistory(true).length, 4);
  assert.equal(calls[2].config.httpOptions.timeout, 15000);
});

test('persistent 503 stops after two attempts and retains original diagnostics and prior history', async () => {
  const delays = [];
  const provider = new ApiError({ status: 503, message: 'Still busy' });
  const { agent, calls } = fixture((params, count) => {
    if (count > 1) throw provider;
    return reply();
  }, { wait: async ms => { delays.push(ms); } });
  const session = { chat: agent.createChat() };
  await agent.respond(session, 'First detail');
  await assert.rejects(agent.respond(session, 'Second detail'), error => {
    assert.equal(error.code, 'ASSISTANT_UNAVAILABLE');
    assert.equal(error.cause, provider);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [500]);
  assert.equal(session.chat.getHistory(true).length, 2);
});

test('non-503 errors are never retried', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const delays = [];
    const { agent, calls } = fixture(() => { throw new ApiError({ status, message: 'Provider failure' }); }, { wait: async ms => { delays.push(ms); } });
    await assert.rejects(agent.respond({ chat: agent.createChat() }, 'Test enquiry'));
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
  }
});
