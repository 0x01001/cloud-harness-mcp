import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import type { ChatConfig } from './config.js';
import { createProxyTransport, type ProxyDependencies, type ProxyTransport } from './proxy.js';
const utf8 = new TextDecoder('utf-8', { fatal: true });

class ChatError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const routes: Record<string, 'GET' | 'POST'> = {
  '/healthz': 'GET', '/readyz': 'GET', '/v1/models': 'GET',
  '/v1/chat/completions': 'POST', '/v1/responses': 'POST'
};
const controllers = new WeakMap<Server, Set<AbortController>>();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawHeader(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values;
}

function sendError(response: ServerResponse, error: ChatError): void {
  if (response.destroyed || response.writableFinished) return;
  if (response.headersSent) { response.destroy(); return; }
  response.statusCode = error.status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Connection', 'close');
  if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
  if (error.status === 429) response.setHeader('Retry-After', '60');
  response.end(JSON.stringify({ error: { message: error.message, type: error.status === 401 ? 'authentication_error' : error.status === 429 ? 'rate_limit_error' : error.status >= 500 ? 'api_error' : 'invalid_request_error', param: null, code: error.code } }));
}

function readRequest(request: IncomingMessage, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const cleanup = () => {
    request.off('data', data); request.off('end', end); request.off('error', fail);
    request.off('aborted', aborted); signal.removeEventListener('abort', abort);
  };
  const fail = (error: Error) => { cleanup(); request.pause(); reject(error); };
  const data = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maximum) { fail(new ChatError(413, 'request_too_large', 'Request body exceeds the byte limit.')); return; }
    chunks.push(chunk);
  };
  const end = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
  const aborted = () => fail(new ChatError(400, 'request_aborted', 'Request was interrupted.'));
  const abort = () => fail(new ChatError(504, 'deadline_exceeded', 'Request deadline exceeded.'));
  if (signal.aborted) { abort(); return promise; }
  request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', aborted);
  signal.addEventListener('abort', abort, { once: true });
  return promise;
}

async function readResponse(body: Readable, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const abort = () => body.destroy(new Error('Request aborted'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Request aborted');
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      bytes += chunk.length;
      if (bytes > maximum) throw new ChatError(502, 'upstream_response_too_large', 'Upstream response exceeds the byte limit.');
      chunks.push(chunk);
    }
    if (signal.aborted) throw new Error('Request aborted');
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener('abort', abort);
    body.destroy();
  }
}

function sanitize(value: string, secrets: string[], upstream: URL): string {
  let result = value;
  for (const secret of secrets) {
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), JSON.stringify(secret).slice(1, -1)]) {
      if (variant) result = result.split(variant).join('[redacted]');
    }
  }
  result = result.split(upstream.hostname).join('[redacted]');
  // eslint-disable-next-line no-control-regex -- Strip untrusted control characters from native error strings.
  return result.replace(/https?:\/\/[^\s"<>]+/gi, '[redacted]').replace(/(?:\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9-]+\.(?:internal|localhost|local|lan|corp)\b)/gi, '[redacted]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 4096);
}
function redactNativeErrors(value: Record<string, unknown>, secrets: string[], upstream: URL): boolean {
  let changed = false;
  const redact = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      const clean = sanitize(entry, secrets, upstream);
      changed ||= clean !== entry;
      return clean;
    }
    if (Array.isArray(entry)) return entry.map(redact);
    if (object(entry)) return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, redact(child)]));
    return entry;
  };
  if (value.error !== undefined) value.error = redact(value.error);
  if (object(value.response) && value.response.error !== undefined) value.response.error = redact(value.response.error);
  if (value.type === 'error') {
    for (const key of ['message', 'code', 'param']) if (value[key] !== undefined) value[key] = redact(value[key]);
  }
  return changed;
}

function safeHeaders(response: ServerResponse, headers: Record<string, string | string[] | undefined>, secrets: string[], upstream: URL): void {
  const retry = headers['retry-after'];
  if (typeof retry === 'string' && retry.length <= 128 && sanitize(retry, secrets, upstream) === retry && (/^\d+$/.test(retry) || /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry))) response.setHeader('Retry-After', retry);
  for (const name of ['x-request-id', 'request-id']) {
    const value = headers[name];
    if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && sanitize(value, secrets, upstream) === value) response.setHeader(name, value);
  }
}

export function createChatServer(config: ChatConfig, dependencies: ProxyDependencies & { transport?: ProxyTransport; now?: () => number } = {}): Server {
  const transport = dependencies.transport ?? createProxyTransport(dependencies);
  const now = dependencies.now ?? Date.now;
  const active = new Set<AbortController>();
  let windowStart = now();
  let admitted = 0;
  let stopping = false;
  const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, (request, response) => {
    void handle(request, response);
  });
  controllers.set(server, active);
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    stopping = true;
    for (const controller of active) controller.abort();
    return close(callback);
  }) as Server['close'];
  server.maxHeadersCount = 100;
  server.headersTimeout = Math.min(config.limits.deadlineMs, 30000);
  server.requestTimeout = 0; // Handler deadline includes the body and the downstream write.
  server.keepAliveTimeout = 5000;
  server.on('close', () => { stopping = true; for (const controller of active) controller.abort(); });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":{"message":"Malformed HTTP request.","type":"invalid_request_error","param":null,"code":"invalid_http_request"}}');
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let controller: AbortController | undefined;
    let timer: NodeJS.Timeout | undefined;
    let deadline = false;
    let upstreamBody: Readable | undefined;
    const finished = Promise.withResolvers<void>();
    response.once('finish', finished.resolve);
    response.once('close', finished.resolve);
    response.once('error', finished.resolve);
    const disconnect = () => { if (!response.writableFinished) controller?.abort(); };
    response.once('close', disconnect);
    try {
      const hosts = rawHeader(request, 'host');
      const bound = server.address();
      const port = typeof bound === 'object' && bound ? bound.port : config.port;
      if (hosts.length !== 1 || !(['localhost', '127.0.0.1', '[::1]'].some(host => hosts[0] === host || hosts[0] === `${host}:${port}`) || (config.publicHost !== undefined && hosts[0] === config.publicHost))) throw new ChatError(400, 'invalid_host', 'Request Host is not allowed.');
      const route = request.url ?? '';
      const method = Object.hasOwn(routes, route) ? routes[route] : undefined;
      if (!method) throw new ChatError(404, 'not_found', 'Route not found.');
      if (request.method !== method) {
        response.setHeader('Allow', method);
        throw new ChatError(405, 'method_not_allowed', 'Method not allowed.');
      }
      if (route === '/healthz' || route === '/readyz') {
        response.setHeader('Content-Type', 'application/json');
        response.statusCode = stopping ? 503 : 200;
        response.end(JSON.stringify({ status: stopping ? 'unavailable' : 'ok' }));
        return;
      }
      const authorization = rawHeader(request, 'authorization');
      const match = authorization.length === 1 ? /^Bearer ([\x21-\x7e]{1,4096})$/i.exec(authorization[0] ?? '') : null;
      const candidate = match?.[1] ?? '';
      const digest = createHash('sha256').update(candidate).digest();
      let authenticated = 0;
      for (const apiKeyDigest of config.apiKeyDigests) authenticated |= Number(timingSafeEqual(digest, apiKeyDigest));
      if (!match || authenticated === 0) throw new ChatError(401, 'invalid_api_key', 'Invalid API key.');
      if (stopping) throw new ChatError(503, 'shutting_down', 'Service is shutting down.');
      const current = now();
      if (current < windowStart || current - windowStart >= 60000) { windowStart = current; admitted = 0; }
      if (active.size >= config.limits.concurrency || admitted >= config.limits.requestsPerMinute) throw new ChatError(429, 'rate_limit_exceeded', 'Request admission limit exceeded.');
      admitted += 1;
      controller = new AbortController();
      active.add(controller);
      const signal = controller.signal;
      timer = setTimeout(() => { deadline = true; controller?.abort(); }, config.limits.deadlineMs);
      timer.unref();
      const abortUpstream = () => upstreamBody?.destroy(new Error('Request aborted'));
      signal.addEventListener('abort', abortUpstream, { once: true });
      let body: Buffer | undefined;
      let stream = false;
      if (method === 'POST') {
        const media = rawHeader(request, 'content-type');
        if (media.length !== 1 || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(media[0] ?? '') || request.headers['content-encoding'] !== undefined) throw new ChatError(415, 'unsupported_media_type', 'Use application/json without content encoding.');
        if (request.headers['content-length'] && Number(request.headers['content-length']) > config.limits.requestBytes) throw new ChatError(413, 'request_too_large', 'Request body exceeds the byte limit.');
        body = await readRequest(request, config.limits.requestBytes, signal);
        let envelope: unknown;
        try { envelope = JSON.parse(utf8.decode(body)); } catch { throw new ChatError(400, 'invalid_json', 'Request body must be valid JSON.'); }
        if (!object(envelope)) throw new ChatError(400, 'invalid_request', 'Request body must be a JSON object.');
        if (typeof envelope.model !== 'string' || !config.allowedModels.has(envelope.model)) throw new ChatError(400, 'model_not_allowed', 'Model is not allowed.');
        if (envelope.stream !== undefined && typeof envelope.stream !== 'boolean') throw new ChatError(400, 'invalid_request', 'stream must be a boolean.');
        if (route === '/v1/chat/completions' && !Array.isArray(envelope.messages)) throw new ChatError(400, 'invalid_request', 'messages must be an array.');
        if (route === '/v1/responses' && envelope.input !== undefined && envelope.input !== null && typeof envelope.input !== 'string' && !Array.isArray(envelope.input)) throw new ChatError(400, 'invalid_request', 'input must be a string, array or null.');
        if (route === '/v1/responses' && envelope.previous_response_id !== undefined && envelope.previous_response_id !== null && typeof envelope.previous_response_id !== 'string') throw new ChatError(400, 'invalid_request', 'previous_response_id must be a string or null.');
        stream = envelope.stream === true;
      } else if (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) !== 0) {
        throw new ChatError(400, 'invalid_request', 'Discovery does not accept a body.');
      }
      const upstream = new URL(config.upstreamBaseUrl);
      upstream.pathname += route.slice('/v1'.length);
      const secrets = [candidate, config.upstreamApiKey];
      const headers: Record<string, string> = { authorization: `Bearer ${config.upstreamApiKey}`, accept: stream ? 'text/event-stream' : 'application/json', 'accept-encoding': 'identity' };
      if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
      const result = await transport({ url: upstream, method, headers, ...(body === undefined ? {} : { body }), signal });
      result.body.on('error', () => { /* The reader reports failures; avoid an unhandled abort before reading. */ });
      upstreamBody = result.body;
      if (signal.aborted) throw new Error('Request aborted');
      if (result.status >= 300 && result.status < 400) throw new ChatError(502, 'upstream_redirect_refused', 'Upstream redirect refused.');
      if (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') throw new ChatError(502, 'invalid_upstream_response', 'Unsupported upstream content encoding.');
      const contentType = result.headers['content-type'];
      const json = typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/i.test(contentType);
      const sse = typeof contentType === 'string' && /^text\/event-stream(?:\s*;|\s*$)/i.test(contentType);
      if (result.status >= 400) {
        if (!json || result.status > 599) throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned an invalid error response.');
        const bytes = await readResponse(result.body, config.limits.responseBytes, signal);
        let parsed: unknown;
        try { parsed = JSON.parse(utf8.decode(bytes)); } catch { throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned an invalid error response.'); }
        if (!object(parsed) || !object(parsed.error) || typeof parsed.error.message !== 'string') throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned an invalid error response.');
        const error = parsed.error;
        const clean = (value: unknown): string | null => typeof value === 'string' ? sanitize(value, secrets, upstream) : null;
        response.statusCode = result.status;
        response.setHeader('Content-Type', 'application/json');
        safeHeaders(response, result.headers, secrets, upstream);
        response.end(JSON.stringify({ error: { message: clean(error.message), type: clean(error.type) ?? 'api_error', param: clean(error.param), code: clean(error.code) } }));
      } else if (result.status < 200 || result.status >= 300) {
        throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned an invalid status.');
      } else if (stream) {
        if (!sse) throw new ChatError(502, 'invalid_upstream_response', 'Upstream did not return an event stream.');
        response.statusCode = result.status;
        response.setHeader('Content-Type', 'text/event-stream');
        safeHeaders(response, result.headers, secrets, upstream);
        response.flushHeaders();
        let total = 0;
        // Buffer one bounded event, not the stream; successful events retain exact bytes.
        let pending = Buffer.alloc(0);
        let pendingLength = 0;
        let scan = 0;
        let lineStart = 0;
        let terminal = false;
        let written = 0;
        const iterator = result.body[Symbol.asyncIterator]();
        while (true) {
          const next = await iterator.next();
          const chunk = next.done ? Buffer.alloc(0) : Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
          total += chunk.length;
          if (total > config.limits.responseBytes) throw new ChatError(502, 'upstream_response_too_large', 'Upstream response exceeds the byte limit.');
          if (signal.aborted) throw new Error('Request aborted');
          if (pendingLength + chunk.length > pending.length) {
            const grown = Buffer.allocUnsafe(Math.min(config.limits.responseBytes, Math.max(pendingLength + chunk.length, pending.length * 2, 4096)));
            pending.copy(grown, 0, 0, pendingLength);
            pending = grown;
          }
          chunk.copy(pending, pendingLength);
          pendingLength += chunk.length;
          let frameStart = 0;
          while (scan < pendingLength) {
            const byte = pending[scan];
            if (byte !== 10 && byte !== 13) { scan += 1; continue; }
            if (byte === 13 && scan + 1 === pendingLength && !next.done) break;
            const after = scan + (byte === 13 && pending[scan + 1] === 10 ? 2 : 1);
            const blank = scan === lineStart;
            scan = after;
            lineStart = after;
            if (!blank) continue;
            const frame = Buffer.from(pending.subarray(frameStart, after));
            const lines = utf8.decode(frame).split(/\r\n|\r|\n/);
            let event = '';
            const data: string[] = [];
            for (const line of lines) {
              if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
              if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            const payload = data.join('\n');
            let output: Buffer = frame;
            let parsed: unknown;
            if (payload && payload !== '[DONE]') {
              try { parsed = JSON.parse(payload); } catch { /* Native non-JSON event data is retained. */ }
            }
            if (object(parsed) && redactNativeErrors(parsed, secrets, upstream)) {
              const firstData = lines.findIndex(line => line.startsWith('data:'));
              output = Buffer.from(lines.filter((line, index) => !line.startsWith('data:') || index === firstData).map(line => line.startsWith('data:') ? `data: ${JSON.stringify(parsed)}` : line).join('\n'));
            }
            if (route === '/v1/chat/completions') terminal ||= payload === '[DONE]' || (object(parsed) && object(parsed.error));
            else terminal ||= data.length > 0 && (/^(?:response\.(?:completed|failed|incomplete)|error)$/.test(event) || (object(parsed) && typeof parsed.type === 'string' && /^(?:response\.(?:completed|failed|incomplete)|error)$/.test(parsed.type)));
            written += output.length;
            if (written > config.limits.responseBytes) throw new ChatError(502, 'upstream_response_too_large', 'Upstream response exceeds the byte limit.');
            if (!response.write(output)) await once(response, 'drain', { signal });
            frameStart = after;
          }
          if (frameStart > 0) {
            pending.copy(pending, 0, frameStart, pendingLength);
            pendingLength -= frameStart;
            scan -= frameStart;
            lineStart -= frameStart;
          }
          if (next.done) break;
        }
        if (signal.aborted) throw new Error('Request aborted');
        if (!terminal) throw new ChatError(502, 'upstream_stream_interrupted', 'Upstream stream ended without a terminal event.');
        response.end();
      } else {
        if (!json) throw new ChatError(502, 'invalid_upstream_response', 'Upstream did not return JSON.');
        const bytes = await readResponse(result.body, config.limits.responseBytes, signal);
        let parsed: unknown;
        try { parsed = JSON.parse(utf8.decode(bytes)); } catch { throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned invalid JSON.'); }
        if (!object(parsed)) throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned an invalid response object.');
        let output = bytes;
        if (route === '/v1/models') {
          if (parsed.object !== 'list' || !Array.isArray(parsed.data)) throw new ChatError(502, 'invalid_upstream_catalog', 'Upstream model catalog is invalid.');
          const data: Record<string, unknown>[] = [];
          const seen = new Set<string>();
          for (const model of parsed.data) {
            if (!object(model) || typeof model.id !== 'string' || model.object !== 'model' || !Number.isSafeInteger(model.created) || (model.created as number) < 0 || typeof model.owned_by !== 'string') throw new ChatError(502, 'invalid_upstream_catalog', 'Upstream model catalog is invalid.');
            if (seen.has(model.id)) throw new ChatError(502, 'invalid_upstream_catalog', 'Upstream model catalog contains duplicate IDs.');
            seen.add(model.id);
            if (config.allowedModels.has(model.id)) data.push({ id: model.id, object: 'model', created: model.created, owned_by: sanitize(model.owned_by, secrets, upstream) });
          }
          output = Buffer.from(JSON.stringify({ object: 'list', data }));
        } else if ((route === '/v1/chat/completions' && (parsed.object !== 'chat.completion' || typeof parsed.id !== 'string' || typeof parsed.model !== 'string' || !Array.isArray(parsed.choices))) || (route === '/v1/responses' && (parsed.object !== 'response' || typeof parsed.id !== 'string' || typeof parsed.model !== 'string' || !Array.isArray(parsed.output)))) {
          throw new ChatError(502, 'invalid_upstream_response', 'Upstream returned an invalid native response.');
        }
        if (route !== '/v1/models' && redactNativeErrors(parsed, secrets, upstream)) output = Buffer.from(JSON.stringify(parsed));
        if (output.length > config.limits.responseBytes) throw new ChatError(502, 'upstream_response_too_large', 'Upstream response exceeds the byte limit.');
        response.statusCode = result.status;
        response.setHeader('Content-Type', 'application/json');
        safeHeaders(response, result.headers, secrets, upstream);
        response.end(output);
      }
      // A slow downstream remains inside the total deadline and concurrency slot.
      const abortWait = () => finished.resolve();
      signal.addEventListener('abort', abortWait, { once: true });
      if (!signal.aborted) await finished.promise;
      signal.removeEventListener('abort', abortWait);
      if (signal.aborted) throw new Error('Request aborted');
    } catch (error) {
      sendError(response, deadline ? new ChatError(504, 'deadline_exceeded', 'Request deadline exceeded.') : error instanceof ChatError ? error : new ChatError(502, 'upstream_unavailable', 'Upstream request failed.'));
    } finally {
      clearTimeout(timer);
      controller?.abort();
      if (controller) active.delete(controller);
      upstreamBody?.destroy();
      response.off('close', disconnect);
      if (!request.complete) {
        request.pause();
        if (!response.writableFinished) response.once('finish', () => request.destroy()); else request.destroy();
      }
    }
  }
  return server;
}

export async function shutdownChatServer(server: Server): Promise<void> {
  for (const controller of controllers.get(server) ?? []) controller.abort();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  server.closeAllConnections();
  await promise;
}
