import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createChatServer, shutdownChatServer } from '../src/app.js';
import type { ChatConfig } from '../src/config.js';
import type { ProxyTransport, ProxyResponse } from '../src/proxy.js';

export type FixtureHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
export type FixtureOptions = { limits?: Partial<ChatConfig['limits']>; now?: () => number; log?: (event: string) => void; apiKeys?: readonly string[]; upstreamKeys?: readonly string[] };
export const CHAT_KEY = 'chat-test-key-not-a-provider-key-1234567890';
export const PROVIDER_KEY = 'provider-test-secret-12345678901234567890';
export const MODEL = 'openai/native-model';
export const config = (limits: Partial<ChatConfig['limits']> = {}, apiKeys: readonly string[] = [CHAT_KEY], upstreamKeys: readonly string[] = [PROVIDER_KEY]): ChatConfig => ({
  port: 0,
  publicHost: 'chat.example.test',
  upstreamBaseUrl: 'https://provider.example.test/prefix/v1',
  apiKeyDigests: apiKeys.map(key => createHash('sha256').update(key).digest()),
  upstreamApiKeys: upstreamKeys,
  allowedModels: new Set([MODEL]),
  limits: { requestBytes: 4096, responseBytes: 65536, concurrency: 4, requestsPerMinute: 60, deadlineMs: 2000, ...limits },
});
export const chatBody = { model: MODEL, messages: [{ role: 'user', content: 'fixture' }] };
export const chatResult = {
  id: 'chat_fixture', object: 'chat.completion', created: 10, model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"value"}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } },
};
export const outputItems = [
  { id: 'reason_1', type: 'reasoning', summary: [], encrypted_content: 'opaque-encrypted-reasoning' },
  { id: 'function_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"key":"value"}', status: 'completed' },
  { id: 'message_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'héllo', annotations: [] }] },
];
export const responseResult = {
  id: 'resp_fixture', object: 'response', created_at: 10, model: MODEL, status: 'completed', output: outputItems,
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } },
};
export const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
export const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
export const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}`;
};

export async function fixture(handler: FixtureHandler, options: FixtureOptions = {}) {
  let calls = 0;
  const captured: { path: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
  const upstream = createServer(async (req, res) => {
    calls++;
    const body = await readBody(req);
    captured.push({ path: req.url ?? '', headers: req.headers, body });
    try { await handler(req, res); } catch { res.destroy(); }
  });
  const upstreamUrl = await listen(upstream);
  // This explicit injected transport is the only HTTP bypass. Production env
  // remains HTTPS-only and still resolves/pins public addresses on every dial.
  const transport: ProxyTransport = ({ url, method, headers, body, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<ProxyResponse>();
    const req = request(`${upstreamUrl}${url.pathname}`, { method, headers, signal }, res => {
      resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res });
    });
    req.on('error', reject);
    req.end(body);
    return promise;
  };
  const server = createChatServer(config(options.limits, options.apiKeys, options.upstreamKeys), { transport, now: options.now, log: options.log });
  const base = await listen(server);
  return {
    server, upstream, base, captured,
    get calls() { return calls; },
    send: (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${CHAT_KEY}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    close: async () => {
      await shutdownChatServer(server);
      upstream.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      upstream.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

export async function rawRequest(base: string, path: string, headers: string[], body = '', method = 'POST') {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: IncomingMessage['headers']; body: string }>();
  const req = request(`${base}${path}`, { method, headers: [...headers, 'Connection', 'close', 'Content-Length', String(Buffer.byteLength(body))] }, async res => {
    try { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: (await readBody(res)).toString() }); } catch (error) { reject(error); }
  });
  req.on('error', reject);
  req.end(body);
  return promise;
}
export const deferred = () => Promise.withResolvers<void>();
