import { afterEach, describe, expect, it } from 'vitest';
import { request, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { shutdownChatServer } from '../src/app.js';
import { CHAT_KEY, PROVIDER_KEY, MODEL, chatBody, chatResult, fixture, json, deferred, readBody, rawRequest } from './fixture.js';
import type { FixtureHandler, FixtureOptions } from './fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
async function setup(handler: FixtureHandler, options?: FixtureOptions) {
  const app = await fixture(handler, options);
  cleanups.push(app.close);
  return app;
}

async function collectBroken(response: Response) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
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

describe('bounded lifecycle, admission and no non-quota retry', () => {
  it('deadline before headers returns504, aborts upstream and releases concurrency for next call', async () => {
    const disconnected = deferred();
    let count = 0;
    const app = await setup((_req, res) => {
      if (++count === 1) res.on('close', () => disconnected.resolve());
      else json(res, chatResult);
    }, { limits: { deadlineMs: 80, concurrency: 1 }, upstreamKeys: [PROVIDER_KEY, 'second-provider-secret-12345678901234567890'] });
    const response = await app.send('/v1/chat/completions', chatBody);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 'deadline_exceeded' } });
    await disconnected.promise;
    expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(200);
    expect(app.calls).toBe(2);
  });

  it('stream interruption never forges Chat DONE or Responses completed and releases slot', async () => {
    for (const route of ['/v1/chat/completions', '/v1/responses']) {
      const released = deferred();
      let count = 0;
      const app = await setup(async (_req, res) => {
        if (++count > 1) { json(res, chatResult); return; }
        res.on('close', () => released.resolve());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(route.endsWith('/responses') ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n' : 'data: {"partial":true}\n\n');
        await delay(20);
        res.destroy();
      }, { limits: { concurrency: 1 }, upstreamKeys: [PROVIDER_KEY, 'second-provider-secret-12345678901234567890'] });
      const response = await app.send(route, { ...chatBody, input: 'fixture', stream: true });
      expect(response.status).toBe(200);
      const result = await collectBroken(response);
      expect(result.interrupted).toBe(true);
      expect(result.text).not.toMatch(/\[DONE\]|response\.completed|"error"/);
      await released.promise;
      expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(200);
      expect(app.calls).toBe(2);
    }
  });

  it('treats clean upstream EOF without native terminal as interrupted, not success', async () => {
    for (const route of ['/v1/chat/completions', '/v1/responses']) {
      const app = await setup(async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(route.endsWith('/responses') ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n' : 'data: {"id":"partial","object":"chat.completion.chunk","choices":[{"delta":{"content":"partial"}}]}\n\n');
        await delay(15);
        res.end();
      }, { upstreamKeys: [PROVIDER_KEY, 'second-provider-secret-12345678901234567890'] });
      const broken = await collectBroken(await app.send(route, { ...chatBody, input: 'fixture', stream: true }));
      expect(broken.interrupted).toBe(true);
      expect(broken.text).not.toMatch(/\[DONE\]|response\.completed/);
      expect(app.calls).toBe(1);
    }
  });

  it('native failed and incomplete terminal events are forwarded, never rewritten as success', async () => {
    for (const terminal of ['response.failed', 'response.incomplete']) {
      const wire = `event: ${terminal}\ndata: ${JSON.stringify({ type: terminal, sequence_number: 1, response: { id: 'resp_fixture', object: 'response', model: MODEL, status: terminal.split('.')[1], output: [], error: terminal.endsWith('failed') ? { code: 'server_error', message: 'fixture failure' } : null, incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`;
      const app = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); });
      const response = await app.send('/v1/responses', { model: MODEL, input: 'fixture', stream: true });
      expect(await response.text()).toBe(wire);
      expect(app.calls).toBe(1);
    }
  });

  it('enforces JSON/SSE response bytes from actual chunks, including discovery, then releases resources', async () => {
    for (const route of ['/v1/models', '/v1/chat/completions', '/v1/responses']) {
      let count = 0;
      const disconnected = deferred();
      const app = await setup((_req, res) => {
        if (++count > 1) { json(res, chatResult); return; }
        res.on('close', () => disconnected.resolve());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"oversized":"');
        res.end('x'.repeat(1500) + '"}');
      }, { limits: { responseBytes: 1000, concurrency: 1 } });
      const response = await app.send(route, route === '/v1/models' ? undefined : { ...chatBody, input: 'fixture' });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: 'upstream_response_too_large' } });
      await disconnected.promise;
      expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(200);
      expect(app.calls).toBe(2);
    }
    const app = await setup(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n');
      await delay(15);
      res.end('data: ' + 'x'.repeat(1500) + '\n\n');
    }, { limits: { responseBytes: 1000 } });
    const broken = await collectBroken(await app.send('/v1/chat/completions', { ...chatBody, stream: true }));
    expect(broken.interrupted).toBe(true);
    expect(broken.text).not.toContain('[DONE]');
    expect(app.calls).toBe(1);
  });

  it('rejects over-concurrency immediately, aborts disconnected upstream, and admits after release', async () => {
    const upstreamClosed = deferred();
    let count = 0;
    const app = await setup((_req, res) => {
      if (++count > 1) { json(res, chatResult); return; }
      res.on('close', () => upstreamClosed.resolve());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
    }, { limits: { concurrency: 1 } });
    const controller = new AbortController();
    const first = await fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...chatBody, stream: true }), signal: controller.signal });
    await first.body!.getReader().read();
    expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(429);
    expect(app.calls).toBe(1);
    controller.abort();
    await upstreamClosed.promise;
    expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(200);
    expect(app.calls).toBe(2);
  });

  it('applies deadline during streaming and a genuinely paused socket reader without unbounded queue', async () => {
    const closed = deferred();
    let wroteAll = false;
    const app = await setup(async (_req, res) => {
      res.on('close', () => closed.resolve());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let index = 0; index < 1024; index++) {
        if (res.destroyed) return;
        if (!res.write(chunk)) {
          try { await once(res, 'drain', { signal: AbortSignal.timeout(1500) }); } catch { return; }
        }
      }
      wroteAll = true;
      res.end();
    }, { limits: { responseBytes: 128 * 1024 * 1024, deadlineMs: 250, concurrency: 1 } });
    const incoming = deferred();
    const req = request(app.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json' } }, response => {
      response.pause();
      incoming.resolve();
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ ...chatBody, stream: true }));
    try {
      await incoming.promise;
      expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(429);
      await closed.promise;
      expect((await app.send('/v1/chat/completions', { ...chatBody, stream: true })).status).toBe(200);
      expect(wroteAll).toBe(false);
      expect(app.calls).toBe(2);
    } finally { req.destroy(); }
  });

  it('rate window resets only at boundary; admission429 and network errors never retry', async () => {
    let now = 0;
    const app = await setup((_req, res) => json(res, chatResult), { now: () => now, limits: { requestsPerMinute: 1 } });
    expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(200);
    expect((await app.send('/v1/models')).status).toBe(429);
    now = 59999;
    expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(429);
    expect(app.calls).toBe(1);
    now = 60000;
    expect((await app.send('/v1/chat/completions', chatBody)).status).toBe(200);
    const network = await setup((_req, res) => res.destroy(), { upstreamKeys: [PROVIDER_KEY, 'second-provider-secret-12345678901234567890'] });
    expect((await network.send('/v1/chat/completions', chatBody)).status).toBe(502);
    expect(network.calls).toBe(1);
  });

  it('shutdown aborts active stream and closes listener without replay', async () => {
    const closed = deferred();
    const app = await setup((_req, res) => {
      res.on('close', () => closed.resolve());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n');
    });
    const response = await app.send('/v1/chat/completions', { ...chatBody, stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    await shutdownChatServer(app.server);
    await closed.promise;
    await expect(reader.read()).rejects.toThrow();
    await expect(fetch(app.base + '/healthz')).rejects.toThrow();
    expect(app.calls).toBe(1);
  });
});

describe('privacy-safe request and response metadata', () => {
  it('silences successful health probes but retains paired metadata for a rejected probe', async () => {
    const events: string[] = [];
    const app = await setup((_req, res) => json(res, chatResult), { log: event => { events.push(event); } });
    for (const route of ['/healthz', '/readyz']) {
      const response = await fetch(app.base + route);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      expect(events).toHaveLength(0);
      expect(app.calls).toBe(0);
    }
    const response = await rawRequest(app.base, '/readyz', ['Host', 'invalid.example.test'], '', 'GET');
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'invalid_host' } });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^app request id=[0-9a-f-]{36} method=GET route=readyz$/);
    const id = events[0]!.split(' ')[2]!.slice(3);
    expect(events[1]).toMatch(new RegExp(`^app response id=${id} status=400 duration_ms=\\d+ outcome=finished$`));
    expect(app.calls).toBe(0);
  });

  it('logs arrival before body/response, pairs one completion, and uses fresh UUIDs across servers', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const events: string[] = [];
      const arrived = deferred();
      const completed = deferred();
      const prompt = 'private-prompt-sentinel';
      const completion = 'private-completion-sentinel';
      const app = await setup((_req, res) => json(res, { ...chatResult, choices: [{ message: { content: completion } }] }), { log: event => {
        events.push(event);
        if (event.startsWith('app request ')) arrived.resolve(); else completed.resolve();
      } });
      const incoming = Promise.withResolvers<IncomingMessage>();
      const req = request(app.base + '/v1/chat/completions', { method: 'POST', headers: {
        authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json', 'x-request-id': 'untrusted-request-id', 'x-private': 'private-header-sentinel',
      } }, incoming.resolve);
      req.on('error', incoming.reject);
      try {
        req.flushHeaders();
        await arrived.promise;
        expect(events).toHaveLength(1);
        expect(app.calls).toBe(0);
        expect(events[0]).toMatch(/^app request id=[0-9a-f-]{36} method=POST route=chat-completions$/);
        const id = events[0]!.split(' ')[2]!.slice(3);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        ids.push(id);
        req.end(JSON.stringify({ ...chatBody, messages: [{ role: 'user', content: prompt }] }));
        const response = await incoming.promise;
        expect(response.statusCode).toBe(200);
        expect((await readBody(response)).toString()).toContain(completion);
        await completed.promise;
        expect(events).toHaveLength(2);
        expect(events[1]).toMatch(new RegExp(`^app response id=${id} status=200 duration_ms=\\d+ outcome=finished$`));
        for (const secret of [prompt, completion, CHAT_KEY, PROVIDER_KEY, MODEL, 'untrusted-request-id', 'private-header-sentinel', app.base, '/v1/chat/completions']) {
          expect(events.join('\n')).not.toContain(secret);
        }
      } finally { req.destroy(); }
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('distinguishes a completed SSE stream from a disconnected stream exactly once', async () => {
    for (const outcome of ['finished', 'aborted']) {
      const events: string[] = [];
      const completed = deferred();
      const app = await setup((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"delta":"private-stream-sentinel"}\n\n');
        if (outcome === 'finished') res.end('data: [DONE]\n\n');
      }, { log: event => {
        events.push(event);
        if (event.startsWith('app response ')) completed.resolve();
      } });
      const controller = new AbortController();
      const response = await fetch(app.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...chatBody, stream: true }), signal: controller.signal });
      if (outcome === 'finished') expect(await response.text()).toContain('[DONE]');
      else {
        await response.body!.getReader().read();
        expect(events).toHaveLength(1);
        controller.abort();
      }
      await completed.promise;
      await app.close();
      expect(events).toHaveLength(2);
      const id = events[0]!.split(' ')[2]!.slice(3);
      expect(events[1]).toMatch(new RegExp(`^app response id=${id} status=200 duration_ms=\\d+ outcome=${outcome}$`));
      expect(events.join('\n')).not.toContain('private-stream-sentinel');
    }
  });

  it('reports status zero when the client aborts before any response headers', async () => {
    const events: string[] = [];
    const arrived = deferred();
    const completed = deferred();
    const app = await setup((_req, res) => json(res, chatResult), { log: event => {
      events.push(event);
      if (event.startsWith('app request ')) arrived.resolve(); else completed.resolve();
    } });
    const req = request(app.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${CHAT_KEY}`, 'content-type': 'application/json', 'content-length': '1000' } });
    req.on('error', () => {});
    req.flushHeaders();
    await arrived.promise;
    req.destroy();
    await completed.promise;
    expect(events).toHaveLength(2);
    const id = events[0]!.split(' ')[2]!.slice(3);
    expect(events[1]).toMatch(new RegExp(`^app response id=${id} status=0 duration_ms=\\d+ outcome=aborted$`));
    expect(app.calls).toBe(0);
  });

  it('uses only exact route and method labels and never logs untrusted URLs or methods', async () => {
    const events: string[] = [];
    const app = await setup((_req, res) => json(res, chatResult), { log: event => { events.push(event); } });
    for (const [path, route] of [['/healthz', 'healthz'], ['/readyz', 'readyz'], ['/v1/models', 'models'], ['/v1/chat/completions', 'chat-completions'], ['/v1/responses', 'responses'], ['/healthz?token=private-url-sentinel', 'unknown'], ['/private-path-sentinel', 'unknown']]) {
      const response = await fetch(app.base + path, { method: 'DELETE', headers: { authorization: `Bearer ${CHAT_KEY}` } });
      await response.text();
      expect(events.at(-2)).toMatch(new RegExp(`^app request id=[0-9a-f-]{36} method=DELETE route=${route}$`));
      expect(events.at(-1)).toMatch(/^app response id=[0-9a-f-]{36} status=(404|405) duration_ms=\d+ outcome=finished$/);
    }
    const incoming = Promise.withResolvers<IncomingMessage>();
    const req = request(app.base + '/healthz', { method: 'PROPFIND' }, incoming.resolve);
    req.on('error', incoming.reject);
    req.end();
    await readBody(await incoming.promise);
    expect(events.at(-2)).toMatch(/^app request id=[0-9a-f-]{36} method=OTHER route=healthz$/);
    expect(events.join('\n')).not.toMatch(/private-url-sentinel|private-path-sentinel|PROPFIND|Bearer|\/healthz|token=/);
  });

  it('continues handling requests when the metadata logger throws', async () => {
    let calls = 0;
    const app = await setup((_req, res) => json(res, chatResult), { log: () => { calls++; throw new Error('Logger unavailable'); } });
    const response = await app.send('/v1/chat/completions', chatBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(chatResult);
    expect(calls).toBe(2);
  });
});
