import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatServer, shutdownChatServer } from '../src/app.js';
import type { ProxyRequest } from '../src/proxy.js';
import { CHAT_KEY, PROVIDER_KEY, MODEL, chatBody, chatResult, responseResult, fixture, config, listen, json, deferred } from './fixture.js';
import type { FixtureHandler, FixtureOptions } from './fixture.js';

const SECOND_KEY = 'second-provider-secret-12345678901234567890';
const THIRD_KEY = 'third-provider-secret-12345678901234567890';
const upstreamKeys = [PROVIDER_KEY, SECOND_KEY, THIRD_KEY];
const quota = { error: { message: 'Project quota exhausted.', type: 'rate_limit_error', param: null, code: 'insufficient_quota' } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
async function setup(handler: FixtureHandler, options: FixtureOptions = {}) {
  const app = await fixture(handler, { upstreamKeys, ...options });
  cleanups.push(app.close);
  return app;
}
const routes = ['/v1/chat/completions', '/v1/responses'];
const input = (route: string, stream = false) => route.endsWith('/responses')
  ? { model: MODEL, input: 'fixture', previous_response_id: 'resp_previous', store: false, stream }
  : { ...chatBody, stream };

async function broken(response: Response) {
  const chunks: Uint8Array[] = [];
  const reader = response.body!.getReader();
  let interrupted = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
    }
  } catch { interrupted = true; }
  return { interrupted, text: Buffer.concat(chunks).toString() };
}

describe('ordered per-request quota failover', () => {
  for (const route of routes) for (const stream of [false, true]) {
    it(`replays only pre-header quota for ${route}, stream=${stream}, and starts every request at the first key`, async () => {
      const nativeResult = route.endsWith('/responses') ? responseResult : chatResult;
      const nativeWire = route.endsWith('/responses')
        ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responseResult })}\n\n`
        : `data: ${JSON.stringify(chatResult)}\n\ndata: [DONE]\n\n`;
      const app = await setup((req, res) => {
        if (req.headers.authorization === `Bearer ${PROVIDER_KEY}`) {
          res.setHeader('retry-after', '77');
          res.setHeader('x-request-id', 'discarded-quota-request');
          json(res, quota, 429);
        } else {
          res.setHeader('x-request-id', 'successful-request');
          if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(nativeWire); }
          else json(res, nativeResult);
        }
      });
      const body = input(route, stream);
      for (let request = 0; request < 2; request++) {
        const response = await app.send(route, body);
        expect(response.status).toBe(200);
        expect(response.headers.get('retry-after')).toBeNull();
        expect(response.headers.get('x-request-id')).toBe('successful-request');
        if (stream) expect(await response.text()).toBe(nativeWire);
        else expect(await response.json()).toEqual(nativeResult);
      }
      expect(app.calls).toBe(4);
      expect(app.captured.map(call => call.headers.authorization)).toEqual([PROVIDER_KEY, SECOND_KEY, PROVIDER_KEY, SECOND_KEY].map(key => `Bearer ${key}`));
      for (const call of app.captured) {
        expect(call.path).toBe(`/prefix${route}`);
        expect(call.body.toString()).toBe(JSON.stringify(body));
        expect(call.headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(body))));
        expect(call.headers.accept).toBe(stream ? 'text/event-stream' : 'application/json');
        expect(call.headers['accept-encoding']).toBe('identity');
      }
    });
  }

  it('accepts native type-only quota only when the code is absent or null', async () => {
    for (const code of [undefined, null]) {
      const app = await setup((req, res) => req.headers.authorization === `Bearer ${PROVIDER_KEY}`
        ? json(res, { error: { message: 'quota', type: 'insufficient_quota', code } }, 429)
        : json(res, chatResult));
      expect((await app.send(routes[0]!, chatBody)).status).toBe(200);
      expect(app.calls).toBe(2);
    }
  });

  it('preserves the last sanitized quota and safe headers after attempting every key exactly once', async () => {
    const app = await setup((req, res) => {
      const last = req.headers.authorization === `Bearer ${THIRD_KEY}`;
      res.setHeader('retry-after', last ? '23' : '99');
      res.setHeader('x-request-id', last ? 'last-quota-request' : 'earlier-quota-request');
      res.setHeader('set-cookie', `secret=${THIRD_KEY}`);
      json(res, { error: { message: `${last ? 'last' : 'earlier'} quota ${upstreamKeys.join(' ')} ${CHAT_KEY}`, type: 'insufficient_quota', param: THIRD_KEY, code: 'insufficient_quota' } }, 429);
    });
    const response = await app.send('/v1/responses', input('/v1/responses', true));
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('retry-after')).toBe('23');
    expect(response.headers.get('x-request-id')).toBe('last-quota-request');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ error: { message: 'last quota [redacted] [redacted] [redacted] [redacted]', type: 'insufficient_quota', param: '[redacted]', code: 'insufficient_quota' } });
    expect(app.captured.map(call => call.headers.authorization)).toEqual(upstreamKeys.map(key => `Bearer ${key}`));
  });

  it('disposes the prior body and reuses the request buffer, endpoint and abort signal', async () => {
    let prior: Readable | undefined;
    let first: ProxyRequest | undefined;
    const keys: string[] = [];
    const server = createChatServer(config({}, [CHAT_KEY], upstreamKeys), { transport: async request => {
      keys.push(request.headers.authorization!);
      if (first) {
        expect(prior!.destroyed).toBe(true);
        expect(request.body).toBe(first.body);
        expect(request.url).toBe(first.url);
        expect(request.signal).toBe(first.signal);
        expect(request.method).toBe(first.method);
      } else first = request;
      prior = Readable.from([JSON.stringify(keys.length === 1 ? quota : chatResult)]);
      return { status: keys.length === 1 ? 429 : 200, headers: { 'content-type': 'application/json' }, body: prior };
    } });
    cleanups.push(() => shutdownChatServer(server));
    const base = await listen(server);
    const response = await fetch(base + routes[0], { method: 'POST', headers: { authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(chatBody) });
    expect(await response.json()).toEqual(chatResult);
    expect(keys).toEqual([`Bearer ${PROVIDER_KEY}`, `Bearer ${SECOND_KEY}`]);
    expect(prior!.destroyed).toBe(true);
  });
});

describe('quota-only switching boundary', () => {
  for (const [status, type, code] of [
    [429, 'rate_limit_error', 'rate_limit_exceeded'],
    [429, 'insufficient_quota', 'rate_limit_exceeded'],
    [429, 'insufficient_quota', 'quota'],
    [429, 'insufficient_quota', ''],
    [429, 'rate_limit_error', undefined],
    [401, 'insufficient_quota', 'insufficient_quota'],
    [403, 'insufficient_quota', 'insufficient_quota'],
    [500, 'insufficient_quota', 'insufficient_quota'],
    [503, 'insufficient_quota', 'insufficient_quota'],
  ] as const) {
    it(`does not switch for HTTP ${status}, type=${type}, code=${String(code)}`, async () => {
      const app = await setup((_req, res) => json(res, { error: { message: 'native failure', type, code } }, status));
      const response = await app.send(routes[0]!, chatBody);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { message: 'native failure', type, code: code ?? null } });
      expect(app.calls).toBe(1);
    });
  }

  it('stops at a non-quota error on the next key without trying the remaining key', async () => {
    const app = await setup((req, res) => json(res, req.headers.authorization === `Bearer ${PROVIDER_KEY}`
      ? quota
      : { error: { message: 'Too many requests.', type: 'insufficient_quota', code: 'rate_limit_exceeded' } }, 429));
    const response = await app.send(routes[0]!, chatBody);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } });
    expect(app.captured.map(call => call.headers.authorization)).toEqual([`Bearer ${PROVIDER_KEY}`, `Bearer ${SECOND_KEY}`]);
  });

  it('does not switch for malformed, non-JSON, encoded or oversized quota errors, or a network failure', async () => {
    const handlers: FixtureHandler[] = [
      (_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{'); },
      (_req, res) => json(res, { error: { code: 'insufficient_quota' } }, 429),
      (_req, res) => { res.writeHead(429, { 'content-type': 'text/html' }); res.end('insufficient_quota'); },
      (_req, res) => { res.setHeader('content-encoding', 'gzip'); json(res, quota, 429); },
      (_req, res) => json(res, { error: { ...quota.error, message: 'x'.repeat(2000) } }, 429),
      (_req, res) => res.destroy(),
    ];
    for (const handler of handlers) {
      const app = await setup(handler, { limits: { responseBytes: 1000 } });
      const response = await app.send(routes[0]!, chatBody);
      expect(response.status).toBe(502);
      await response.arrayBuffer();
      expect(app.calls).toBe(1);
    }
  });

  for (const route of routes) {
    it(`never retries a native quota terminal event in ${route} SSE`, async () => {
      const terminal = route.endsWith('/responses')
        ? `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { ...responseResult, status: 'failed', error: quota.error } })}\n\n`
        : `data: ${JSON.stringify(quota)}\n\n`;
      const app = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(terminal); });
      const response = await app.send(route, input(route, true));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(terminal);
      expect(app.calls).toBe(1);
    });
  }

  it('never retries after SSE headers, even with no content, or after partial content', async () => {
    for (const partial of ['', 'data: partial\n\n']) {
      const app = await setup(async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        if (partial) res.write(partial);
        await delay(20);
        res.destroy();
      });
      const response = await app.send(routes[0]!, { ...chatBody, stream: true });
      expect(response.status).toBe(200);
      expect(await broken(response)).toEqual({ interrupted: true, text: partial });
      expect(app.calls).toBe(1);
    }
  });
});

describe('all-key redaction and shared request budgets', () => {
  it('redacts even untried provider keys and their encoded variants from errors and allowed headers', async () => {
    const encodedKey = 'untried-provider-secret-1234567890/+=\\"';
    const keys = [...upstreamKeys, encodedKey];
    const secrets = [CHAT_KEY, ...keys];
    const leaks = secrets.flatMap(key => [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), JSON.stringify(key).slice(1, -1)]).join(' ');
    const app = await setup((_req, res) => {
      res.setHeader('x-request-id', THIRD_KEY);
      res.setHeader('request-id', SECOND_KEY);
      json(res, { error: { message: leaks, type: SECOND_KEY, param: THIRD_KEY, code: 'rate_limit_exceeded' } }, 429);
    }, { upstreamKeys: keys });
    const response = await app.send(routes[0]!, chatBody);
    const text = await response.text();
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(Buffer.from(secret).toString('base64'));
      expect(text).not.toContain(encodeURIComponent(secret));
      expect(JSON.parse(text).error.message).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(JSON.parse(text)).toMatchObject({ error: { type: '[redacted]', param: '[redacted]', code: 'rate_limit_exceeded' } });
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('request-id')).toBeNull();
    expect(app.calls).toBe(1);
  });

  it('redacts untried keys in native failed JSON, SSE nested errors and model ownership', async () => {
    const failure = { ...responseResult, status: 'failed', output: [], error: { code: 'insufficient_quota', message: upstreamKeys.join(' ') } };
    const app = await setup((req, res) => {
      if (req.url?.endsWith('/models')) {
        json(res, { object: 'list', data: [{ id: MODEL, object: 'model', created: 10, owned_by: THIRD_KEY }] });
      } else if (app.calls === 1) json(res, failure);
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: failure })}\n\n`);
      }
    });
    for (const stream of [false, true]) {
      const response = await app.send('/v1/responses', input('/v1/responses', stream));
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('insufficient_quota');
      for (const key of upstreamKeys) expect(text).not.toContain(key);
    }
    expect(await (await app.send('/v1/models')).json()).toMatchObject({ data: [{ owned_by: '[redacted]' }] });
    expect(app.calls).toBe(3);
    expect(app.captured.every(call => call.headers.authorization === `Bearer ${PROVIDER_KEY}`)).toBe(true);
  });

  it('keeps one total deadline across attempts and releases the concurrency slot', async () => {
    const closed = deferred();
    const app = await setup(async (req, res) => {
      if (app.calls > 2) { json(res, chatResult); return; }
      if (req.headers.authorization === `Bearer ${PROVIDER_KEY}`) {
        await delay(100);
        json(res, quota, 429);
      } else {
        res.on('close', () => closed.resolve());
        await delay(100);
        if (!res.destroyed) json(res, chatResult);
      }
    }, { limits: { deadlineMs: 160, concurrency: 1 } });
    const response = await app.send(routes[0]!, chatBody);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 'deadline_exceeded' } });
    await closed.promise;
    expect(app.calls).toBe(2);
    expect((await app.send(routes[0]!, chatBody)).status).toBe(200);
    expect(app.calls).toBe(3);
  });

  it('does not reset the concurrency or admission budget when advancing to the next key', async () => {
    const second = deferred();
    const release = deferred();
    const app = await setup(async (req, res) => {
      if (req.headers.authorization === `Bearer ${PROVIDER_KEY}`) json(res, quota, 429);
      else {
        second.resolve();
        await release.promise;
        json(res, chatResult);
      }
    }, { limits: { concurrency: 1, requestsPerMinute: 1 } });
    const pending = app.send(routes[0]!, chatBody);
    try {
      await second.promise;
      const limited = await app.send(routes[0]!, chatBody);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } });
      expect(app.calls).toBe(2);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(chatResult);
      const next = await app.send(routes[0]!, chatBody);
      expect(next.status).toBe(429);
      await next.arrayBuffer();
      expect(app.calls).toBe(2);
    } finally { release.resolve(); }
  });
});
