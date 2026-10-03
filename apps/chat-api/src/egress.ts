import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';

// Standalone mirror of the MCP URL policy: cross-app imports would couple runtimes.
export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const UNSAFE_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home',
  '.lan',
  '.corp',
  '.test',
  '.invalid',
  '.example',
  '.arpa'
];

function unsafeIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return true;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return true;
    const value = Number(part);
    if (value > 255) return true;
    octets.push(value);
  }
  const first = octets[0]!;
  const second = octets[1]!;
  const third = octets[2]!;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function parseIpv6Group(group: string): number[] | undefined {
  if (group.includes('.')) {
    const octets = parseIpv4(group);
    if (!octets) return undefined;
    return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
  }
  if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
  return [Number.parseInt(group, 16)];
}

/** Parses an IPv6 literal (including a compressed and/or IPv4-embedded form) into 8 words. */
function parseIpv6(input: string): number[] | undefined {
  let text = input.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !text.includes(':')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half === '') return [];
    const groups = half.split(':');
    const words: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      if (group === '') return undefined;
      const parsed = parseIpv6Group(group);
      if (!parsed) return undefined;
      if (group.includes('.') && index !== groups.length - 1) return undefined;
      words.push(...parsed);
    }
    return words;
  };
  const head = parseHalf(halves[0] ?? '');
  if (!head) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseHalf(halves[1] ?? '');
  if (!tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function unsafeIpv6(words: number[]): boolean {
  const mapped = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff;
  if (mapped) {
    const high = words[6]!;
    const low = words[7]!;
    return unsafeIpv4(`${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`);
  }
  if (words.every((word) => word === 0)) return true;
  if (words[7] === 1 && words.slice(0, 7).every((word) => word === 0)) return true;
  const first = words[0]!;
  // Refuse transition/tunneling and non-global IPv6 ranges, including NAT64.
  if ((first & 0xe000) !== 0x2000 || first === 0x2002 || first === 0x3fff) return true;
  if (first === 0x2001 && words[1]! < 0x0200) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && words[1] === 0x0db8) return true;
  if (first === 0x2001 && words[1] === 0x0002 && words[2] === 0x0000) return true;
  if (first === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;
  return false;
}

function stripZone(address: string): string {
  const zone = address.indexOf('%');
  return zone === -1 ? address : address.slice(0, zone);
}

/**
 * Classifies an address literal. Returns `true` for every private, loopback,
 * link-local, CGNAT, documentation, multicast, reserved, or otherwise
 * non-public address, and fails closed (`true`) for anything that is not a
 * valid IP literal.
 */
export function isUnsafeAddress(address: string): boolean {
  const normalized = stripZone(address.trim());
  const version = isIP(normalized);
  if (version === 4) return unsafeIpv4(normalized);
  if (version === 6) {
    const words = parseIpv6(normalized);
    return words === undefined ? true : unsafeIpv6(words);
  }
  return true;
}

export function validateUpstreamUrl(raw: string): URL {
  if (!raw || raw.length > 2048 || /[\\\s]|%2e|%2f|%5c/i.test(raw)) throw new Error('Invalid CHAT_UPSTREAM_BASE_URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid CHAT_UPSTREAM_BASE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1')) throw new Error('Invalid CHAT_UPSTREAM_BASE_URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isUnsafeAddress(hostname)) throw new Error('Invalid CHAT_UPSTREAM_BASE_URL');
  } else {
    const lower = hostname.toLowerCase().replace(/\.$/, '');
    if (!lower.includes('.') || lower === 'localhost' || UNSAFE_HOST_SUFFIXES.some(suffix => lower.endsWith(suffix))) throw new Error('Invalid CHAT_UPSTREAM_BASE_URL');
  }
  return url;
}

export async function resolvePublicAddresses(url: URL, resolve: Resolver = async hostname => {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map(entry => ({ address: entry.address, family: entry.family as 4 | 6 }));
}): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await resolve(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(entry => !entry || (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family || isUnsafeAddress(entry.address))) throw new Error('Upstream address refused');
  return addresses;
}

export type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
) => void;

/** Answers only with addresses approved before this HTTPS socket was created. */
export function createPinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return (_hostname, options, callback) => {
    if (pinned.length === 0) {
      callback(Object.assign(new Error('no validated address to pin'), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options !== null && typeof options === 'object' && options.all === true) {
      callback(null, pinned);
      return;
    }
    const first = pinned[0]!;
    callback(null, first.address, first.family);
  };
}
