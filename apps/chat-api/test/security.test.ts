import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { createProxyTransport } from '../src/proxy.js';
import { createPinnedLookup, isUnsafeAddress, resolvePublicAddresses, validateUpstreamUrl } from '../src/egress.js';
import { CHAT_KEY, PROVIDER_KEY, MODEL, chatBody, chatResult, fixture, json, rawRequest } from './fixture.js';
import type { FixtureHandler, FixtureOptions } from './fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
async function setup(handler: FixtureHandler, options?: FixtureOptions) {
  const app = await fixture(handler, options);
  cleanups.push(app.close);
  return app;
}
const errorEnvelope = (body: string) => {
  const parsed = JSON.parse(body);
  expect(parsed.error).toMatchObject({ message: expect.any(String), type: expect.any(String), param: null, code: expect.any(String) });
  return parsed.error;
};

describe('public route and authentication boundary', () => {
  it('accepts original and additional client keys on the same HTTP route without forwarding them', async () => {
    const additionalKey = 'additional-chat-test-key-12345678901234567890';
    const app = await setup((_req, res) => json(res, chatResult), { apiKeys: [CHAT_KEY, additionalKey] });
    for (const key of [CHAT_KEY, additionalKey]) {
      const res = await app.send('/v1/chat/completions', chatBody, { authorization: `Bearer ${key}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(chatResult);
    }
    for (const key of ['unknown-chat-key-12345678901234567890', PROVIDER_KEY]) {
      const res = await app.send('/v1/chat/completions', chatBody, { authorization: `Bearer ${key}` });
      expect(res.status).toBe(401);
      expect(errorEnvelope(await res.text()).code).toBe('invalid_api_key');
    }
    expect(app.calls).toBe(2);
    for (const captured of app.captured) {
      expect(captured.path).toBe('/prefix/v1/chat/completions');
      expect(captured.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
      expect(JSON.parse(captured.body.toString())).toEqual(chatBody);
    }
  });

  it('rejects absent, wrong, MCP, malformed and duplicate credentials before upstream', async () => {
    const app = await setup((_req, res) => json(res, chatResult));
    const variants = [
      [], ['Authorization', 'Bearer wrong-key'], ['Authorization', 'Bearer mcp-bearer-not-chat'],
      ['Authorization', CHAT_KEY], ['Authorization', `Basic ${CHAT_KEY}`],
      ['Authorization', `Bearer ${CHAT_KEY} extra`], ['Authorization', `Bearer ${CHAT_KEY}, Bearer ${CHAT_KEY}`],
      ['Authorization', `Bearer ${CHAT_KEY}`, 'authorization', `Bearer ${CHAT_KEY}`],
    ];
    for (const auth of variants) {
      const res = await rawRequest(app.base, '/v1/chat/completions', ['Host', new URL(app.base).host, 'Content-Type', 'application/json', ...auth], JSON.stringify(chatBody));
      expect(res.status).toBe(401);
      errorEnvelope(res.body);
    }
    expect(app.calls).toBe(0);
  });

  it('does not trust cookies, query, forwarding, Access identities or Origin', async () => {
    const app = await setup((_req, res) => json(res, chatResult));
    const res = await rawRequest(app.base, '/v1/chat/completions', [
      'Host', new URL(app.base).host, 'Content-Type', 'application/json', 'Cookie', `api_key=${CHAT_KEY}`,
      'X-Forwarded-For', '127.0.0.1', 'X-Forwarded-Host', 'chat.example.test', 'X-Forwarded-Proto', 'https',
      'Cf-Access-Authenticated-User-Email', 'admin@example.test', 'Cf-Access-Jwt-Assertion', CHAT_KEY, 'Origin', 'https://chat.example.test',
    ], JSON.stringify(chatBody));
    expect(res.status).toBe(401);
    const query = await rawRequest(app.base, `/v1/chat/completions?api_key=${CHAT_KEY}`, ['Host', new URL(app.base).host, 'Content-Type', 'application/json'], JSON.stringify(chatBody));
    expect([401, 404]).toContain(query.status);
    expect(app.calls).toBe(0);
  });

  it('isolates all MCP/admin routes and methods without permissive CORS', async () => {
    const app = await setup((_req, res) => json(res, chatResult));
    for (const path of ['/mcp', '/mcp-gateway', '/mcp-api-key', '/dashboard', '/exec', '/v1/messages', '/v1/models/info', '/v1/responses/resp_fixture', '/v1/chat/completions/extra']) {
      expect((await app.send(path)).status).toBe(404);
    }
    for (const [path, method] of [['/v1/models', 'POST'], ['/v1/chat/completions', 'GET'], ['/v1/responses', 'DELETE']]) {
      const res = await rawRequest(app.base, path!, ['Host', new URL(app.base).host, 'Authorization', `Bearer ${CHAT_KEY}`], '', method);
      expect(res.status).toBe(405);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    for (const path of ['/healthz', '/readyz']) {
      const res = await fetch(app.base + path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(PROVIDER_KEY);
      expect(body).not.toContain(MODEL);
      expect(body).not.toContain('provider.example');
    }
    const invalidHost = await rawRequest(app.base, '/v1/models', ['Host', 'attacker.example', 'Authorization', `Bearer ${CHAT_KEY}`], '', 'GET');
    expect(invalidHost.status).toBeGreaterThanOrEqual(400);
    const duplicateHost = await rawRequest(app.base, '/v1/models', ['Host', new URL(app.base).host, 'Host', 'chat.example.test', 'Authorization', `Bearer ${CHAT_KEY}`], '', 'GET');
    expect(duplicateHost.status).toBeGreaterThanOrEqual(400);
    expect(app.calls).toBe(0);
  });
});

describe('consumer validation and byte boundaries', () => {
  it('rejects envelope, media, models, malformed JSON and oversized bodies without upstream', async () => {
    const app = await setup((_req, res) => json(res, chatResult), { limits: { requestBytes: 180 } });
    for (const body of [null, [], 'text', { model: MODEL }, { model: MODEL, messages: {} }, { ...chatBody, stream: 'yes' }, { ...chatBody, model: 'not-allowed' }]) {
      const res = await app.send('/v1/chat/completions', body);
      expect(res.status).toBe(400);
      errorEnvelope(await res.text());
    }
    for (const body of [{ model: MODEL, input: {} }, { model: MODEL, previous_response_id: 1 }, { model: MODEL, input: 'ok', stream: 1 }]) {
      expect((await app.send('/v1/responses', body)).status).toBe(400);
    }
    const media = await app.send('/v1/chat/completions', chatBody, { 'content-type': 'text/plain' });
    expect(media.status).toBe(415);
    const duplicateMedia = await rawRequest(app.base, '/v1/chat/completions', ['Host', new URL(app.base).host, 'Authorization', `Bearer ${CHAT_KEY}`, 'Content-Type', 'application/json', 'Content-Type', 'application/json'], JSON.stringify(chatBody));
    expect(duplicateMedia.status).toBe(415);
    expect((await app.send('/v1/chat/completions', chatBody, { 'content-encoding': 'gzip' })).status).toBe(415);
    const malformed = await rawRequest(app.base, '/v1/chat/completions', ['Host', new URL(app.base).host, 'Authorization', `Bearer ${CHAT_KEY}`, 'Content-Type', 'application/json'], '{');
    expect(malformed.status).toBe(400);
    expect((await app.send('/v1/chat/completions', { ...chatBody, extra: 'x'.repeat(200) })).status).toBe(413);
    // A chunked body has no declared size, so the reader must enforce the cap.
    const result = Promise.withResolvers<number>();
    const req = request(app.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => { res.resume(); result.resolve(res.statusCode!); });
    req.on('error', result.reject);
    req.write('{"model":"');
    req.end('x'.repeat(300));
    expect(await result.promise).toBe(413);
    expect(app.calls).toBe(0);
  });

  it('rebuilds outbound headers and redacts credential/error/header leaks without retries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = await setup((_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1', 'x-request-id': 'safe-request-123', 'set-cookie': `key=${PROVIDER_KEY}`, 'x-provider-secret': PROVIDER_KEY });
        res.end(JSON.stringify({ error: { message: `denied ${PROVIDER_KEY} ${CHAT_KEY}`, type: 'rate_limit_error', param: null, code: 'quota' } }));
      }, { upstreamKeys: [PROVIDER_KEY, 'second-provider-secret-12345678901234567890'] });
      const response = await app.send('/v1/chat/completions', chatBody, { cookie: `key=${CHAT_KEY}`, 'x-arbitrary': 'private', origin: 'https://browser.example' });
      expect(response.status).toBe(429);
      const body = await response.text();
      expect(body).not.toContain(PROVIDER_KEY);
      expect(body).not.toContain(CHAT_KEY);
      expect(errorEnvelope(body).code).toBe('quota');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('x-provider-secret')).toBeNull();
      expect(response.headers.get('retry-after')).toBe('1');
      expect(app.captured[0]!.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
      expect(app.captured[0]!.headers.cookie).toBeUndefined();
      expect(app.captured[0]!.headers['x-arbitrary']).toBeUndefined();
      expect(app.captured[0]!.headers.origin).toBeUndefined();
      expect(app.calls).toBe(1);
      expect(JSON.stringify([...log.mock.calls, ...errorLog.mock.calls])).not.toMatch(new RegExp(`${PROVIDER_KEY}|${CHAT_KEY}|fixture`));
    } finally { log.mockRestore(); errorLog.mockRestore(); }
  });

  it('does not follow redirect or accept upstream HTML as a successful model response', async () => {
    for (const status of [302, 200]) {
      const app = await setup((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/html', location: 'https://attacker.example/steal' });
        res.end(`<html>${PROVIDER_KEY}</html>`);
      });
      const response = await app.send('/v1/chat/completions', chatBody);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(PROVIDER_KEY);
      expect(response.headers.get('location')).toBeNull();
      expect(app.calls).toBe(1);
    }
  });

  it('redacts native Responses failed JSON and SSE error credentials split across bytes', async () => {
    const failure = { id: 'resp_fixture', object: 'response', created_at: 10, status: 'failed', model: MODEL, output: [], error: { code: 'server_error', message: `echo ${PROVIDER_KEY} ${CHAT_KEY}` }, usage: null };
    const app = await setup(async (_req, res) => {
      if (app.calls === 1) { json(res, failure); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: 1, response: failure })}\n\n`;
      for (const byte of Buffer.from(wire)) res.write(Buffer.from([byte]));
      res.end();
    });
    const failed = await app.send('/v1/responses', { model: MODEL, input: 'fixture' });
    expect(failed.status).toBe(200);
    const body = await failed.text();
    expect(JSON.parse(body)).toMatchObject({ status: 'failed', error: { code: 'server_error' } });
    expect(body).not.toContain(PROVIDER_KEY);
    expect(body).not.toContain(CHAT_KEY);
    const stream = await app.send('/v1/responses', { model: MODEL, input: 'fixture', stream: true });
    const wire = await stream.text();
    expect(wire).toContain('response.failed');
    expect(wire).not.toContain('response.completed');
    expect(wire).not.toContain(PROVIDER_KEY);
    expect(wire).not.toContain(CHAT_KEY);
    expect(app.calls).toBe(2);
  });
});

describe('production safe egress boundary', () => {
  it('rejects unsafe destinations and validates HTTPS /v1 without credential URL components', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isUnsafeAddress(address)).toBe(true);
    expect(isUnsafeAddress('8.8.8.8')).toBe(false);
    for (const url of ['http://public.example/v1', 'https://u:p@public.example/v1', 'https://public.example/v1?q=secret', 'https://public.example/v1#secret', 'https://public.example/not-v1', 'https://127.0.0.1/v1', 'https://169.254.169.254/v1']) expect(() => validateUpstreamUrl(url)).toThrow();
    const url = validateUpstreamUrl('https://provider.example.com/prefix/v1');
    await expect(resolvePublicAddresses(url, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toThrow();
    await expect(resolvePublicAddresses(url, async () => [])).rejects.toThrow();
    const publicAddresses = await resolvePublicAddresses(url, async () => [{ address: '8.8.8.8', family: 4 }]);
    expect(publicAddresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    // Pin survives a later DNS answer change: no resolver is called at connect time.
    const pinned = createPinnedLookup(publicAddresses);
    const result = Promise.withResolvers<unknown>();
    pinned('provider.example', {}, (error, address, family) => error ? result.reject(error) : result.resolve({ address, family }));
    expect(await result.promise).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('production transport rejects mixed private DNS before any dial', async () => {
    const dial = vi.fn();
    const transport = createProxyTransport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }], request: dial as never });
    await expect(transport({ url: new URL('https://provider.example/v1/models'), method: 'GET', headers: { authorization: `Bearer ${PROVIDER_KEY}` }, signal: new AbortController().signal })).rejects.toThrow();
    expect(dial).not.toHaveBeenCalled();
  });

  it('production dial pins public DNS and refuses private rebinding on the next request', async () => {
    const app = await setup((_req, res) => json(res, chatResult));
    const endpoint = app.upstream.address();
    if (!endpoint || typeof endpoint === 'string') throw new Error('Missing fixture port');
    let resolutions = 0;
    let pinnedAddress: unknown;
    const dial = vi.fn((_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      expect(options.agent).toBe(false);
      const secure = options as RequestOptions & { rejectUnauthorized: boolean };
      expect(secure.rejectUnauthorized).toBe(true);
      options.lookup!('provider.example', {}, (error, address, family) => {
        expect(error).toBeNull();
        pinnedAddress = { address, family };
      });
      return request(`http://127.0.0.1:${endpoint.port}/prefix/v1/chat/completions`, { method: options.method, headers: options.headers, signal: options.signal }, callback);
    });
    const transport = createProxyTransport({
      resolve: async () => ++resolutions === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
      request: dial as never,
    });
    const input = { url: new URL('https://provider.example/v1/chat/completions'), method: 'POST' as const, headers: { authorization: `Bearer ${PROVIDER_KEY}` }, body: Buffer.from(JSON.stringify(chatBody)), signal: new AbortController().signal };
    const response = await transport(input);
    let body = '';
    for await (const chunk of response.body) body += chunk.toString();
    expect(JSON.parse(body)).toEqual(chatResult);
    expect(pinnedAddress).toEqual({ address: '8.8.8.8', family: 4 });
    await expect(transport(input)).rejects.toThrow();
    expect(resolutions).toBe(2);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(app.calls).toBe(1);
  });
});
