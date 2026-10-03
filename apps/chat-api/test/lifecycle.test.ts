import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { shutdownChatServer } from '../src/app.js';
import { CHAT_KEY, PROVIDER_KEY, MODEL, chatBody, chatResult, fixture, json, deferred } from './fixture.js';
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
