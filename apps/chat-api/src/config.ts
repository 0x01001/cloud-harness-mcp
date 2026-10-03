import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { validateUpstreamUrl } from './egress.js';

export type ChatConfig = {
  port: number;
  publicHost?: string;
  upstreamBaseUrl: string;
  apiKeyDigests: readonly Buffer[];
  upstreamApiKeys: readonly string[];
  allowedModels: ReadonlySet<string>;
  limits: {
    requestBytes: number;
    responseBytes: number;
    concurrency: number;
    requestsPerMinute: number;
    deadlineMs: number;
  };
};

const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const defaultConfig = fileURLToPath(new URL('../.env', import.meta.url));
const names: Record<string, true> = {
  CHAT_CONFIG_FILE: true, CHAT_API_PORT: true, CHAT_PUBLIC_HOST: true, CHAT_NGROK_CONFIG_FILE: true,
  CHAT_API_KEY_FILE: true, CHAT_UPSTREAM_API_KEY: true,
  CHAT_UPSTREAM_BASE_URL: true, CHAT_ALLOWED_MODELS: true,
  CHAT_MAX_REQUEST_BYTES: true, CHAT_MAX_RESPONSE_BYTES: true,
  CHAT_MAX_CONCURRENT_REQUESTS: true, CHAT_REQUESTS_PER_MINUTE: true,
  CHAT_REQUEST_DEADLINE_MS: true
};

const maxGeneratedKeys = 1024;

async function outsideCheckout(path: string, name: string): Promise<void> {
  const canonical = await realpath(path);
  const root = await realpath(checkout);
  const inside = relative(root, canonical);
  const appConfig = name === 'CHAT_CONFIG_FILE' && path === defaultConfig && canonical === join(root, 'apps/chat-api/.env');
  if (!appConfig && (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)))) throw new Error(`Invalid private file for ${name}`);
}

async function privateDirectory(path: string, name: string): Promise<void> {
  try {
    if (!isAbsolute(path)) throw new Error();
    await outsideCheckout(path, name);
    const stat = await lstat(path);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) throw new Error();
  } catch {
    throw new Error(`Invalid private directory for ${name}`);
  }
}

async function privateFile(path: string | undefined, name: string, maxBytes: number): Promise<string> {
  const invalid = () => new Error(`Invalid private file for ${name}`);
  if (!path || !isAbsolute(path)) throw invalid();
  let handle;
  try {
    await outsideCheckout(path, name);
    const appConfig = name === 'CHAT_CONFIG_FILE' && path === defaultConfig;
    const parent = await lstat(dirname(path));
    const before = await lstat(path);
    const uid = process.getuid?.();
    if (!parent.isDirectory() || parent.isSymbolicLink() || (appConfig ? (parent.mode & 0o022) !== 0 : (parent.mode & 0o7777) !== 0o700) || (uid !== undefined && parent.uid !== uid)) throw invalid();
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o7777) !== 0o600 || (uid !== undefined && before.uid !== uid) || before.size > maxBytes) throw invalid();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino || !current.isFile() || (current.mode & 0o7777) !== 0o600 || (uid !== undefined && current.uid !== uid)) throw invalid();
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maxBytes) throw invalid();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    throw invalid();
  } finally {
    await handle?.close();
  }
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function key(value: string, name: string): string {
  if (value.length < 32 || value.length > 4096 || /[^\x21-\x7e]/.test(value) || /change.?me|placeholder|your[-_ ]?(?:api[-_ ]?)?key|replace.?me|example|^test[-_]|^dummy/i.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function upstreamKeys(value: string | undefined): string[] {
  const keys = (value ?? '').split(',').map(value => key(value, 'CHAT_UPSTREAM_API_KEY'));
  if (new Set(keys).size !== keys.length) throw new Error('Invalid CHAT_UPSTREAM_API_KEY');
  return keys;
}

async function configValues(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const file = await privateFile(env.CHAT_CONFIG_FILE ?? defaultConfig, 'CHAT_CONFIG_FILE', 64 * 1024);
  let parsed: NodeJS.ProcessEnv;
  try { parsed = parseEnv(file); } catch { throw new Error('Invalid CHAT_CONFIG_FILE'); }
  if (Object.keys(parsed).some(name => !Object.hasOwn(names, name) || name === 'CHAT_CONFIG_FILE')) throw new Error('Invalid CHAT_CONFIG_FILE');
  const values = { ...parsed, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
  if (Object.keys(values).some(name => name.startsWith('CHAT_') && !Object.hasOwn(names, name))) throw new Error('Unknown CHAT_ configuration');
  return values;
}

async function clientDigests(path: string | undefined, upstreamDigests: readonly Buffer[], allowMissingPrimary = false): Promise<Buffer[]> {
  if (!path || !isAbsolute(path)) throw new Error('Invalid private file for CHAT_API_KEY_FILE');
  const digests: Buffer[] = [];
  const add = async (file: string) => {
    const value = key((await privateFile(file, 'CHAT_API_KEY_FILE', 4098)).replace(/\r?\n$/, ''), 'CHAT_API_KEY_FILE');
    const digest = createHash('sha256').update(value).digest();
    if (upstreamDigests.some(existing => timingSafeEqual(existing, digest))) throw new Error('Chat and upstream credentials must be distinct');
    if (digests.some(existing => timingSafeEqual(existing, digest))) throw new Error('Chat credentials must be distinct');
    digests.push(digest);
  };
  let primaryExists = true;
  try { await lstat(path); } catch (error) {
    if (!allowMissingPrimary || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid private file for CHAT_API_KEY_FILE');
    primaryExists = false;
  }
  if (primaryExists) await add(path);
  const directory = `${path}.d`;
  try { await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return digests;
    throw new Error('Invalid private directory for CHAT_API_KEY_FILE');
  }
  await privateDirectory(directory, 'CHAT_API_KEY_FILE');
  const entries = await opendir(directory);
  let count = 0;
  for await (const entry of entries) {
    if (++count > maxGeneratedKeys || entry.name.startsWith('.') || !entry.name.endsWith('.key') || !entry.isFile()) throw new Error('Invalid CHAT_API_KEY_FILE key directory');
    await add(join(directory, entry.name));
  }
  return digests;
}

export async function generateChatKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const values = await configValues(env);
  const path = values.CHAT_API_KEY_FILE;
  if (!path || !isAbsolute(path)) throw new Error('Invalid private file for CHAT_API_KEY_FILE');
  await privateDirectory(dirname(path), 'CHAT_API_KEY_FILE');
  const upstreamDigests = upstreamKeys(values.CHAT_UPSTREAM_API_KEY).map(value => createHash('sha256').update(value).digest());
  const digests = await clientDigests(path, upstreamDigests, true);
  let value: string;
  let digest: Buffer;
  do {
    value = randomBytes(32).toString('hex');
    digest = createHash('sha256').update(value).digest();
  } while (upstreamDigests.some(existing => timingSafeEqual(existing, digest)) || digests.some(existing => timingSafeEqual(existing, digest)));
  // Publish a complete private file with an exclusive hard link: concurrent generators
  // never read a partly written primary or overwrite another invocation's key.
  const temporary = join(dirname(path), `.chat-key-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${value}\n`);
    await handle.close();
    try {
      await link(temporary, path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Unable to generate CHAT_API_KEY_FILE');
    }
    const directory = `${path}.d`;
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Unable to generate CHAT_API_KEY_FILE');
    }
    const current = await clientDigests(path, upstreamDigests);
    if (current.length > maxGeneratedKeys) throw new Error('CHAT_API_KEY_FILE key directory is full');
    if (current.some(existing => timingSafeEqual(existing, digest))) throw new Error('Chat credentials must be distinct');
    const destination = join(directory, `${randomUUID()}.key`);
    await link(temporary, destination);
    try {
      await clientDigests(path, upstreamDigests);
    } catch (error) {
      await unlink(destination);
      throw error;
    }
    return destination;
  } finally {
    await handle.close();
    await unlink(temporary);
  }
}

export async function loadChatConfig(env: NodeJS.ProcessEnv = process.env): Promise<ChatConfig> {
  const values = await configValues(env);
  const upstreamApiKeys = upstreamKeys(values.CHAT_UPSTREAM_API_KEY);
  const upstreamDigests = upstreamApiKeys.map(value => createHash('sha256').update(value).digest());
  const apiKeyDigests = await clientDigests(values.CHAT_API_KEY_FILE, upstreamDigests);
  const upstreamBaseUrl = validateUpstreamUrl(values.CHAT_UPSTREAM_BASE_URL ?? '').href;
  const models = (values.CHAT_ALLOWED_MODELS ?? '').split(',').map(value => value.trim());
  // eslint-disable-next-line no-control-regex -- Model IDs must never contain control characters.
  if (!models.length || models.some(value => !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) || new Set(models).size !== models.length) throw new Error('Invalid CHAT_ALLOWED_MODELS');
  const publicHost = values.CHAT_PUBLIC_HOST;
  if (publicHost !== undefined && (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(publicHost) || /(?:^|\.)(localhost|local|internal|invalid|test)$/.test(publicHost))) throw new Error('Invalid CHAT_PUBLIC_HOST');
  return {
    port: integer(values, 'CHAT_API_PORT', 3211, 65535),
    ...(publicHost === undefined ? {} : { publicHost }),
    upstreamBaseUrl,
    apiKeyDigests,
    upstreamApiKeys,
    allowedModels: new Set(models),
    limits: {
      requestBytes: integer(values, 'CHAT_MAX_REQUEST_BYTES', 4 * 1024 * 1024, 64 * 1024 * 1024),
      responseBytes: integer(values, 'CHAT_MAX_RESPONSE_BYTES', 16 * 1024 * 1024, 256 * 1024 * 1024),
      concurrency: integer(values, 'CHAT_MAX_CONCURRENT_REQUESTS', 4, 128),
      requestsPerMinute: integer(values, 'CHAT_REQUESTS_PER_MINUTE', 60, 60000),
      deadlineMs: integer(values, 'CHAT_REQUEST_DEADLINE_MS', 300000, 3600000)
    }
  };
}
