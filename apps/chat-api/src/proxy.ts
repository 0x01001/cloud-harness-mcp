import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { createPinnedLookup, resolvePublicAddresses, type Resolver } from './egress.js';

export type ProxyRequest = {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
};
export type ProxyResponse = { status: number; headers: IncomingHttpHeaders; body: Readable };
export type ProxyTransport = (request: ProxyRequest) => Promise<ProxyResponse>;
export type ProxyDependencies = { resolve?: Resolver; request?: typeof httpsRequest };

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new Error('Request aborted'));
  if (signal.aborted) { abort(); return promise; }
  signal.addEventListener('abort', abort, { once: true });
  void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  return promise;
}

export function createProxyTransport(dependencies: ProxyDependencies = {}): ProxyTransport {
  return async ({ url, method, headers, body, signal }) => {
    const addresses = await abortable(resolvePublicAddresses(url, dependencies.resolve), signal);
    if (signal.aborted) throw new Error('Request aborted');
    const { promise, resolve, reject } = Promise.withResolvers<ProxyResponse>();
    const request = (dependencies.request ?? httpsRequest)(url, {
      method,
      headers,
      agent: false,
      lookup: createPinnedLookup(addresses),
      family: addresses[0]!.family,
      signal,
      rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024
    }, response => {
      // No redirect is ever followed; the caller rejects all 3xx statuses.
      resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response });
    });
    request.once('error', reject);
    if (body) request.end(body); else request.end();
    return promise;
  };
}
