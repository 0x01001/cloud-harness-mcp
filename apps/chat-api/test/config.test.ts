import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateChatKey, loadChatConfig } from '../src/config.js';
import { CHAT_KEY, PROVIDER_KEY, MODEL } from './fixture.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function files() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'chat-config-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const chat = join(directory, 'chat.key');
  const path = join(directory, 'chat.env');
  await writeFile(chat, CHAT_KEY + '\n', { mode: 0o600 });
  await writeFile(path, '', { mode: 0o600 });
  const env = { CHAT_CONFIG_FILE: path, CHAT_API_KEY_FILE: chat, CHAT_UPSTREAM_API_KEY: PROVIDER_KEY, CHAT_UPSTREAM_BASE_URL: 'https://provider.example.com/prefix/v1', CHAT_ALLOWED_MODELS: MODEL };
  return { directory, chat, path, env };
}
const dotenv = (env: NodeJS.ProcessEnv) => Object.entries(env).filter(([name, value]) => name !== 'CHAT_CONFIG_FILE' && value !== undefined).map(([name, value]) => `${name}=${value}`).join('\n');

// Copy only public source into an isolated checkout, never the developer's .env.
async function relocatedLoader() {
  const fixture = await files();
  const root = join(fixture.directory, 'checkout');
  const app = join(root, 'apps/chat-api');
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(app, 'dist'));
  await chmod(app, 0o755);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const configSource = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const egress = stripTypeScriptTypes(await readFile(new URL('../src/egress.ts', import.meta.url), 'utf8'));
  await writeFile(join(app, 'src/config.ts'), configSource);
  await writeFile(join(app, 'src/egress.js'), egress);
  await writeFile(join(app, 'dist/config.js'), stripTypeScriptTypes(configSource));
  await writeFile(join(app, 'dist/egress.js'), egress);
  const generator = stripTypeScriptTypes(await readFile(new URL('../src/generate-key.ts', import.meta.url), 'utf8'));
  await writeFile(join(app, 'dist/generate-key.js'), generator);
  const configPath = join(app, '.env');
  await writeFile(configPath, dotenv(fixture.env), { mode: 0o600 });
  const cwd = join(fixture.directory, 'other-cwd');
  await mkdir(cwd);
  await writeFile(join(cwd, '.env'), 'CHAT_UPSTREAM_API_KEY_FILE=must-not-be-loaded');
  return { ...fixture, root, app, configPath, cwd };
}

async function runLoader(modulePath: string, env: NodeJS.ProcessEnv, cwd: string) {
  // The isolated source/build entry is runtime-selected to exercise module-relative defaults.
  const script = `const { loadChatConfig } = await import(process.argv[1]);
try { const config = await loadChatConfig(JSON.parse(process.argv[2])); console.log(JSON.stringify({ port: config.port, models: [...config.allowedModels] })); }
catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script, pathToFileURL(modulePath).href, JSON.stringify(env)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = Promise.withResolvers<number | null>();
  child.once('error', exit.reject);
  child.once('close', exit.resolve);
  return { code: await exit.promise, stdout, stderr };
}

describe('fail-closed standalone chat config', () => {
  it('loads a private client credential and inline upstream credential, opaque CSV models and documented limits', async () => {
    const { env } = await files();
    const config = await loadChatConfig({ ...env, CHAT_ALLOWED_MODELS: `${MODEL}, second-model` });
    expect(config.port).toBe(3211);
    expect(config.apiKeyDigests).toEqual([createHash('sha256').update(CHAT_KEY).digest()]);
    expect(config.upstreamApiKey).toBe(PROVIDER_KEY);
    expect([...config.allowedModels]).toEqual([MODEL, 'second-model']);
    expect(config.limits).toEqual({ requestBytes: 4 * 1024 * 1024, responseBytes: 16 * 1024 * 1024, concurrency: 4, requestsPerMinute: 60, deadlineMs: 300000 });
  });

  it('preserves old bytes and config while adding private, distinct credentials accepted at startup', async () => {
    const { env, chat, path } = await files();
    await writeFile(path, dotenv(env));
    await writeFile(chat, `${CHAT_KEY}\r\n`);
    const original = await readFile(chat);
    const configBytes = await readFile(path);
    const beforeGeneration = await loadChatConfig(env);
    const generated = await Promise.all([generateChatKey({ CHAT_CONFIG_FILE: path }), generateChatKey({ CHAT_CONFIG_FILE: path })]);
    expect(new Set(generated).size).toBe(2);
    expect(await readFile(chat)).toEqual(original);
    expect(await readFile(path)).toEqual(configBytes);
    expect((await lstat(`${chat}.d`)).mode & 0o7777).toBe(0o700);
    const keys = await Promise.all(generated.map(async file => {
      expect(file).toMatch(/\.d\/[0-9a-f-]{36}\.key$/);
      expect((await lstat(file)).mode & 0o7777).toBe(0o600);
      const value = await readFile(file, 'utf8');
      expect(value).toMatch(/^[0-9a-f]{64}\n$/);
      return value.trim();
    }));
    const config = await loadChatConfig({ CHAT_CONFIG_FILE: path });
    expect(config.apiKeyDigests).toHaveLength(3);
    for (const value of [CHAT_KEY, ...keys]) expect(config.apiKeyDigests).toContainEqual(createHash('sha256').update(value).digest());
    expect(beforeGeneration.apiKeyDigests).toEqual([createHash('sha256').update(CHAT_KEY).digest()]);
  });

  it('creates a missing primary exclusively under concurrent generation without losing keys', async () => {
    const { env, chat, directory } = await files();
    await rm(chat);
    const generated = await Promise.all(Array.from({ length: 8 }, () => generateChatKey(env)));
    expect(new Set(generated).size).toBe(8);
    expect(generated.filter(path => path === chat)).toHaveLength(1);
    expect((await lstat(chat)).mode & 0o7777).toBe(0o600);
    expect(await readdir(`${chat}.d`)).toHaveLength(7);
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
    const config = await loadChatConfig(env);
    expect(config.apiKeyDigests).toHaveLength(8);
    const keys = await Promise.all(generated.map(path => readFile(path, 'utf8')));
    expect(new Set(keys).size).toBe(8);
    for (const value of keys) expect(config.apiKeyDigests).toContainEqual(createHash('sha256').update(value.trim()).digest());
  });

  it('uses the same environment override precedence for generation as startup', async () => {
    const { env, chat, path, directory } = await files();
    await writeFile(path, dotenv(env));
    const override = join(directory, 'override.key');
    expect(await generateChatKey({ CHAT_CONFIG_FILE: path, CHAT_API_KEY_FILE: override })).toBe(override);
    expect(await readFile(chat, 'utf8')).toBe(`${CHAT_KEY}\n`);
    expect((await loadChatConfig({ CHAT_CONFIG_FILE: path, CHAT_API_KEY_FILE: override })).apiKeyDigests).toHaveLength(1);
    await expect(lstat(`${chat}.d`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['public-directory', 'symlink-directory', 'file-directory', 'symlink-key', 'nested-directory', 'unknown-entry', 'public-key', 'oversized-key', 'invalid-key', 'duplicate-key', 'upstream-key'])('fails closed for %s without changing existing credentials', async invalid => {
    const { env, chat, directory } = await files();
    const keyDirectory = `${chat}.d`;
    const entry = join(keyDirectory, 'additional.key');
    if (invalid === 'file-directory') {
      await writeFile(keyDirectory, '', { mode: 0o600 });
    } else if (invalid === 'symlink-directory') {
      const external = join(directory, 'external');
      await mkdir(external, { mode: 0o700 });
      await symlink(external, keyDirectory);
    } else {
      await mkdir(keyDirectory, { mode: 0o700 });
      if (invalid === 'public-directory') await chmod(keyDirectory, 0o755);
      else if (invalid === 'symlink-key') await symlink(chat, entry);
      else if (invalid === 'nested-directory') await mkdir(entry, { mode: 0o700 });
      else if (invalid === 'unknown-entry') await writeFile(join(keyDirectory, 'unexpected.txt'), 'c'.repeat(64), { mode: 0o600 });
      else await writeFile(entry, invalid === 'upstream-key' ? PROVIDER_KEY : invalid === 'duplicate-key' ? CHAT_KEY : invalid === 'oversized-key' ? 'c'.repeat(4099) : invalid === 'invalid-key' ? 'short' : 'c'.repeat(64), { mode: invalid === 'public-key' ? 0o644 : 0o600 });
    }
    const original = await readFile(chat);
    await expect(loadChatConfig(env)).rejects.toThrow();
    await expect(generateChatKey(env)).rejects.toThrow();
    expect(await readFile(chat)).toEqual(original);
  });

  it('bounds generated key directory loading', async () => {
    const { env, chat } = await files();
    await mkdir(`${chat}.d`, { mode: 0o700 });
    await Promise.all(Array.from({ length: 1025 }, (_, index) => writeFile(join(`${chat}.d`, `${index}.key`), `${'c'.repeat(64)}${index}`, { mode: 0o600 })));
    await expect(loadChatConfig(env)).rejects.toThrow('key directory');
    await expect(generateChatKey(env)).rejects.toThrow('key directory');
  });

  it('rejects unsafe generation targets and leaves config untouched', async () => {
    const { env, chat, path, directory } = await files();
    const original = await readFile(path);
    for (const value of [undefined, '', 'relative.key', join(directory, 'missing-parent/chat.key')]) await expect(generateChatKey({ ...env, CHAT_API_KEY_FILE: value })).rejects.toThrow('CHAT_API_KEY_FILE');
    const publicParent = join(directory, 'public');
    await mkdir(publicParent, { mode: 0o755 });
    await expect(generateChatKey({ ...env, CHAT_API_KEY_FILE: join(publicParent, 'new.key') })).rejects.toThrow('CHAT_API_KEY_FILE');
    await chmod(chat, 0o644);
    await expect(generateChatKey(env)).rejects.toThrow('CHAT_API_KEY_FILE');
    await rm(chat);
    await symlink(join(directory, 'nonexistent.key'), chat);
    await expect(generateChatKey(env)).rejects.toThrow('CHAT_API_KEY_FILE');
    expect(await readFile(path)).toEqual(original);
  });

  it('prints the newly persisted key for client use without exposing existing or provider keys', async () => {
    const { app, cwd, chat, env, root } = await relocatedLoader();
    const entry = join(app, 'dist/generate-key.js');
    const run = async (overrides: NodeJS.ProcessEnv = {}) => {
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CHAT_')));
      const child = spawn(process.execPath, [entry], { cwd, env: { ...childEnv, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      const exit = Promise.withResolvers<number | null>();
      child.once('error', exit.reject);
      child.once('close', exit.resolve);
      return { code: await exit.promise, stdout, stderr };
    };
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const generated = result.stdout.trim();
    expect(result.stdout).toBe(`${generated}\n`);
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    const [filename] = await readdir(`${chat}.d`);
    expect(await readFile(join(`${chat}.d`, filename!), 'utf8')).toBe(result.stdout);
    expect(await readFile(chat, 'utf8')).toBe(`${CHAT_KEY}\n`);
    for (const value of [CHAT_KEY, PROVIDER_KEY]) expect(result.stdout + result.stderr).not.toContain(value);
    const checkoutKey = join(root, 'new.key');
    const rejected = await run({ CHAT_API_KEY_FILE: checkoutKey });
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).toContain('CHAT_API_KEY_FILE');
    await expect(lstat(checkoutKey)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await loadChatConfig(env)).apiKeyDigests).toContainEqual(createHash('sha256').update(generated).digest());
  });

  it('rejects missing, placeholder, shared, symlinked, public or non-private-parent client keys', async () => {
    const { env, chat, directory, path } = await files();
    await expect(loadChatConfig({ ...env, CHAT_API_KEY_FILE: undefined })).rejects.toThrow('CHAT_API_KEY_FILE');
    await expect(loadChatConfig({ ...env, CHAT_API_KEY_FILE: 'relative.key' })).rejects.toThrow('CHAT_API_KEY_FILE');
    await writeFile(chat, 'replace-me-placeholder-12345678901234567890');
    await expect(loadChatConfig(env)).rejects.toThrow('CHAT_API_KEY_FILE');
    await writeFile(chat, PROVIDER_KEY);
    await expect(loadChatConfig(env)).rejects.toThrow('credentials must be distinct');
    await writeFile(chat, CHAT_KEY);
    const alias = join(directory, 'alias.key');
    await symlink(chat, alias);
    await expect(loadChatConfig({ ...env, CHAT_API_KEY_FILE: alias })).rejects.toThrow('CHAT_API_KEY_FILE');
    for (const mode of [0o644, 0o400, 0o4600]) {
      await chmod(chat, mode);
      await expect(loadChatConfig(env)).rejects.toThrow('CHAT_API_KEY_FILE');
    }
    await chmod(chat, 0o600);
    const keyDirectory = join(directory, 'keys');
    await mkdir(keyDirectory, { mode: 0o755 });
    const movedKey = join(keyDirectory, 'chat.key');
    await writeFile(movedKey, CHAT_KEY, { mode: 0o600 });
    await expect(loadChatConfig({ ...env, CHAT_API_KEY_FILE: movedKey })).rejects.toThrow('CHAT_API_KEY_FILE');
    await chmod(keyDirectory, 0o700);
    const parentAlias = join(directory, 'key-parent');
    await symlink(keyDirectory, parentAlias);
    await expect(loadChatConfig({ ...env, CHAT_API_KEY_FILE: join(parentAlias, 'chat.key') })).rejects.toThrow('CHAT_API_KEY_FILE');
    await rm(path);
    const separateConfig = join(keyDirectory, 'config.env');
    await writeFile(separateConfig, '', { mode: 0o600 });
    await chmod(directory, 0o755);
    await expect(loadChatConfig({ ...env, CHAT_CONFIG_FILE: separateConfig })).rejects.toThrow('CHAT_API_KEY_FILE');
  });

  it('validates inline key length, characters, placeholders and distinct values without echoing keys', async () => {
    const { env } = await files();
    for (const value of [undefined, '', 'short', 'x'.repeat(4097), 'replace-me-placeholder-12345678901234567890', 'test-key-123456789012345678901234567890', `${PROVIDER_KEY}\n`, ` ${PROVIDER_KEY}`, `${PROVIDER_KEY}\t`, `${PROVIDER_KEY}\u0000`, 'é'.repeat(32)]) {
      await expect(loadChatConfig({ ...env, CHAT_UPSTREAM_API_KEY: value })).rejects.toThrow('Invalid CHAT_UPSTREAM_API_KEY');
    }
    await expect(loadChatConfig({ ...env, CHAT_UPSTREAM_API_KEY: CHAT_KEY })).rejects.toThrow('credentials must be distinct');
    expect((await loadChatConfig({ ...env, CHAT_UPSTREAM_API_KEY: 'a'.repeat(32) })).upstreamApiKey).toBe('a'.repeat(32));
    expect((await loadChatConfig({ ...env, CHAT_UPSTREAM_API_KEY: 'a'.repeat(4096) })).upstreamApiKey).toHaveLength(4096);
  });

  it('rejects insecure upstream, ambiguous models, removed or unknown config and unbounded limits', async () => {
    const { env, path } = await files();
    for (const url of ['http://provider.example.com/v1', 'https://127.0.0.1/v1', 'https://provider.example.com/v1?key=secret', 'https://u:p@provider.example.com/v1', 'https://provider.example.com/v2']) await expect(loadChatConfig({ ...env, CHAT_UPSTREAM_BASE_URL: url })).rejects.toThrow();
    for (const models of ['', ',', `${MODEL},`, `${MODEL},${MODEL}`, 'model with space']) await expect(loadChatConfig({ ...env, CHAT_ALLOWED_MODELS: models })).rejects.toThrow();
    await expect(loadChatConfig({ ...env, CHAT_ALLOW_INSECURE_UPSTREAM: '1' })).rejects.toThrow('Unknown CHAT_ configuration');
    await expect(loadChatConfig({ ...env, CHAT_UPSTREAM_API_KEY_FILE: '/removed/provider.key' })).rejects.toThrow('Unknown CHAT_ configuration');
    for (const name of ['CHAT_API_PORT', 'CHAT_MAX_REQUEST_BYTES', 'CHAT_MAX_RESPONSE_BYTES', 'CHAT_MAX_CONCURRENT_REQUESTS', 'CHAT_REQUESTS_PER_MINUTE', 'CHAT_REQUEST_DEADLINE_MS']) for (const value of ['0', '-1', '1.5', 'Infinity', '999999999999999999']) await expect(loadChatConfig({ ...env, [name]: value })).rejects.toThrow();
    await writeFile(path, `${dotenv(env)}\nCHAT_UPSTREAM_API_KEY_FILE=/removed/provider.key`);
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: path })).rejects.toThrow('Invalid CHAT_CONFIG_FILE');
  });

  it('requires a private absolute config override and honors environment overrides without echoing secrets', async () => {
    const { env, path, directory } = await files();
    await writeFile(path, dotenv({ ...env, CHAT_API_PORT: '3212' }));
    expect((await loadChatConfig({ CHAT_CONFIG_FILE: path, CHAT_API_PORT: '3213' })).port).toBe(3213);
    expect((await loadChatConfig({ CHAT_CONFIG_FILE: path, CHAT_UPSTREAM_API_KEY: 'b'.repeat(32) })).upstreamApiKey).toBe('b'.repeat(32));
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: 'relative.env' })).rejects.toThrow('CHAT_CONFIG_FILE');
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: '' })).rejects.toThrow('CHAT_CONFIG_FILE');
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: join(directory, 'missing.env') })).rejects.toThrow('CHAT_CONFIG_FILE');
    const alias = join(directory, 'alias.env');
    await symlink(path, alias);
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: alias })).rejects.toThrow('CHAT_CONFIG_FILE');
    for (const mode of [0o644, 0o400, 0o4600]) {
      await chmod(path, mode);
      await expect(loadChatConfig({ CHAT_CONFIG_FILE: path })).rejects.toThrow('CHAT_CONFIG_FILE');
    }
    await chmod(path, 0o600);
    const configDirectory = join(directory, 'config');
    await mkdir(configDirectory, { mode: 0o755 });
    const configInPublicParent = join(configDirectory, 'chat.env');
    await writeFile(configInPublicParent, dotenv(env), { mode: 0o600 });
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: configInPublicParent })).rejects.toThrow('CHAT_CONFIG_FILE');
    await chmod(configDirectory, 0o700);
    const parentAlias = join(directory, 'config-parent');
    await symlink(configDirectory, parentAlias);
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: join(parentAlias, 'chat.env') })).rejects.toThrow('CHAT_CONFIG_FILE');
    await writeFile(path, `${dotenv(env)}\nCHAT_UPSTREAM_API_KEY=secret-should-not-appear`);
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: path })).rejects.toThrow('Invalid CHAT_UPSTREAM_API_KEY');
    await writeFile(path, `CHAT_CONFIG_FILE=${path}`);
    await expect(loadChatConfig({ CHAT_CONFIG_FILE: path })).rejects.toThrow('Invalid CHAT_CONFIG_FILE');
  });

  it.each(['src/config.ts', 'dist/config.js'])('uses the required app-local .env from %s independently of CWD', async entry => {
    const { app, configPath, cwd, env } = await relocatedLoader();
    const modulePath = join(app, entry);
    const result = await runLoader(modulePath, {}, cwd);
    expect(result).toEqual({ code: 0, stdout: JSON.stringify({ port: 3211, models: [MODEL] }) + '\n', stderr: '' });
    expect((await runLoader(modulePath, { CHAT_CONFIG_FILE: configPath, CHAT_API_PORT: '3213' }, cwd)).stdout).toContain('"port":3213');
    await rm(configPath);
    const envOnly: NodeJS.ProcessEnv = { ...env };
    delete envOnly.CHAT_CONFIG_FILE;
    const missing = await runLoader(modulePath, envOnly, cwd);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('Invalid private file for CHAT_CONFIG_FILE\n');
    const explicit = await runLoader(modulePath, env, cwd);
    expect(explicit.code).toBe(0);
  });

  it('keeps the checkout exception limited to the exact .env with private file and safe parent permissions', async () => {
    const { app, configPath, cwd, root, env, directory } = await relocatedLoader();
    const modulePath = join(app, 'dist/config.js');
    const rejected = async (overrides: NodeJS.ProcessEnv = {}) => {
      const result = await runLoader(modulePath, overrides, cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain(CHAT_KEY);
      expect(result.stderr).not.toContain(PROVIDER_KEY);
      return result.stderr;
    };
    for (const mode of [0o644, 0o400, 0o4600]) {
      await chmod(configPath, mode);
      expect(await rejected()).toContain('CHAT_CONFIG_FILE');
    }
    await chmod(configPath, 0o600);
    for (const mode of [0o775, 0o777]) {
      await chmod(app, mode);
      expect(await rejected()).toContain('CHAT_CONFIG_FILE');
    }
    await chmod(app, 0o755);
    const external = join(directory, 'outside.env');
    await writeFile(external, dotenv(env), { mode: 0o600 });
    await rm(configPath);
    await symlink(external, configPath);
    expect(await rejected()).toContain('CHAT_CONFIG_FILE');
    await rm(configPath);
    await writeFile(configPath, dotenv(env), { mode: 0o600 });
    const other = join(root, 'other.env');
    await writeFile(other, dotenv(env), { mode: 0o600 });
    expect(await rejected({ CHAT_CONFIG_FILE: other })).toContain('CHAT_CONFIG_FILE');
    const alias = join(directory, 'checkout.env');
    await symlink(configPath, alias);
    expect(await rejected({ CHAT_CONFIG_FILE: alias })).toContain('CHAT_CONFIG_FILE');
    const checkoutKey = join(app, 'client.key');
    await writeFile(checkoutKey, CHAT_KEY, { mode: 0o600 });
    expect(await rejected({ CHAT_API_KEY_FILE: checkoutKey })).toContain('CHAT_API_KEY_FILE');
    await rename(app, app + '-real');
    await symlink(app + '-real', app);
    expect(await rejected()).toContain('CHAT_CONFIG_FILE');
  }, 15000);
});
