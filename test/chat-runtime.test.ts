import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appReady, assertRuntime, bootstrap, bootout, checkNgrokHelp, consumeAppLog, flushLifecycleLogs, healthReady, jobOwned, lifecycleLog, listenerOwned, ngrokArgs, ngrokConfigFile, plist, privateFile, readConfigEnv, resolveExecutable, restartAllowed, runtimePaths, viewLogs } from '../scripts/chat-runtime.mjs';
import type { RuntimeManifest } from '../scripts/chat-runtime.mjs';

const exec = promisify(execFile);
const directories: string[] = [];
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'chat-runtime-')));
  directories.push(directory);
  const root = path.join(directory, 'checkout');
  const home = path.join(directory, 'home');
  const secrets = path.join(directory, 'private');
  await Promise.all([mkdir(root), mkdir(home), mkdir(secrets, { mode: 0o700 })]);
  const config = path.join(secrets, 'chat.env');
  const ngrokConfig = path.join(directory, 'existing-ngrok', 'ngrok-translate.yml');
  await writeFile(config, `CHAT_API_PORT=3211\nCHAT_PUBLIC_HOST=chat.example.ngrok.app\nCHAT_NGROK_CONFIG_FILE="${ngrokConfig}"\n`, { mode: 0o600 });
  const paths = runtimePaths({ CHAT_CONFIG_FILE: config }, home, root);
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  await mkdir(paths.agents, { recursive: true });
  const manifest = { ...paths, node: process.execPath, script: path.join(root, 'scripts/chat-runtime.mjs'), ngrok: '/absolute/ngrok', ngrokConfig, entry: path.join(root, 'apps/chat-api/dist/index.js') };
  return { directory, root, home, secrets, config, paths, manifest };
}

function job(manifest: RuntimeManifest, kind: 'app' | 'tunnel' = 'app', pid = 123) {
  return `path = ${path.join(manifest.agents, `${manifest.labels[kind]}.plist`)}\nprogram = ${manifest.node}\narguments = {\n${manifest.node}\n${manifest.script}\n--${kind}\n${manifest.manifest}\n}\npid = ${pid}\n`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('isolated chat runtime', () => {
  it('rejects unsupported runtime and keeps runtime state scoped by config outside checkout', async () => {
    expect(() => assertRuntime('linux', '24.0.0')).toThrow('macOS');
    expect(() => assertRuntime('darwin', '22.0.0')).toThrow('>=24');
    expect(() => assertRuntime('darwin', '26.0.0')).not.toThrow();
    const { home, root, config, paths } = await fixture();
    const defaults = runtimePaths({}, home, root);
    expect(defaults.config).toBe(path.join(root, 'apps', 'chat-api', '.env'));
    expect(path.relative(root, defaults.state).startsWith(`..${path.sep}`)).toBe(true);
    expect(defaults.labels).toEqual(runtimePaths({ CHAT_CONFIG_FILE: defaults.config }, home, root).labels);
    expect(defaults.labels).not.toEqual(paths.labels);
    expect(runtimePaths({ CHAT_CONFIG_FILE: config }, home, root)).toEqual(paths);
    expect(runtimePaths({ CHAT_CONFIG_FILE: `${config}.other` }, home, root).labels).not.toEqual(paths.labels);
    expect(() => runtimePaths({ CHAT_CONFIG_FILE: 'relative.env' }, home, root)).toThrow('absolute');
  });

  it('derives the default config from the runtime module rather than the working directory', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/unrelated-working-directory');
    try {
      expect(runtimePaths({}).config).toBe(fileURLToPath(new URL('../apps/chat-api/.env', import.meta.url)));
    } finally { cwd.mockRestore(); }
  });

  it('parses private env as data, never shell code, and rejects env injection', async () => {
    const { config, root } = await fixture();
    await writeFile(config, 'CHAT_ALLOWED_MODELS="openai/model,other/model"\nCHAT_PUBLIC_HOST="$(touch /never-created)"\nCHAT_API_PORT=3211\nCHAT_UPSTREAM_API_KEY=synthetic-provider-secret\nCHAT_API_KEY_FILE=/private/client.key\n');
    const env = await readConfigEnv(config, root, { HOME: '/test', CHAT_API_PORT: '3212' });
    expect(env.CHAT_PUBLIC_HOST).toBe('$(touch /never-created)');
    expect(env.CHAT_ALLOWED_MODELS).toBe('openai/model,other/model');
    expect(env.CHAT_API_PORT).toBe('3212');
    expect(env.CHAT_UPSTREAM_API_KEY).toBe('synthetic-provider-secret');
    expect(env.CHAT_API_KEY_FILE).toBe('/private/client.key');
    expect(env.CHAT_CONFIG_FILE).toBe(config);
    await writeFile(config, 'CHAT_UPSTREAM_API_KEY_FILE=/private/provider.key\n');
    await expect(readConfigEnv(config, root, {})).rejects.toThrow('Unknown');
    await writeFile(config, 'NODE_OPTIONS=--import=evil.mjs\n');
    await expect(readConfigEnv(config, root, {})).rejects.toThrow('Unknown');
    await writeFile(config, 'CHAT_API_KEY=not-allowed\n');
    await expect(readConfigEnv(config, root, {})).rejects.toThrow('Unknown');
  });

  it('rejects public permissions, symlinks, and checkout private files', async () => {
    const { config, root, secrets } = await fixture();
    const accepted = await privateFile(config, root);
    expect(await readFile(accepted, 'utf8')).toContain('CHAT_API_PORT=3211');
    expect(path.relative(root, accepted).startsWith(`..${path.sep}`)).toBe(true);
    await chmod(config, 0o644);
    await expect(privateFile(config, root)).rejects.toThrow('0600');
    await expect(readConfigEnv(config, root, {})).rejects.toThrow('0600');
    await chmod(config, 0o600);
    await chmod(secrets, 0o755);
    await expect(privateFile(config, root)).rejects.toThrow('0700');
    await expect(readConfigEnv(config, root, {})).rejects.toThrow('0700');
    await chmod(secrets, 0o2700);
    await expect(readConfigEnv(config, root, {})).rejects.toThrow('0700');
    await chmod(secrets, 0o700);
    const linked = path.join(secrets, 'linked');
    await symlink(config, linked);
    await expect(privateFile(linked, root)).rejects.toThrow('symlinks');
    await expect(readConfigEnv(linked, root, {})).rejects.toThrow('symlinks');
    const local = path.join(root, 'key');
    await writeFile(local, 'not-a-real-key', { mode: 0o600 });
    await expect(privateFile(local, root)).rejects.toThrow('outside');
  });

  it('allows only the exact app-local dotenv with a non-writable owner-owned parent', async () => {
    const { root, home } = await fixture();
    const app = path.join(root, 'apps', 'chat-api');
    await mkdir(app, { recursive: true });
    await chmod(app, 0o755);
    const local = runtimePaths({}, home, root).config;
    await writeFile(local, 'CHAT_UPSTREAM_API_KEY=synthetic-provider-secret\n', { mode: 0o600 });
    expect((await readConfigEnv(local, root, {})).CHAT_UPSTREAM_API_KEY).toBe('synthetic-provider-secret');
    await expect(privateFile(local, root)).rejects.toThrow('outside');
    const sibling = path.join(app, 'other.env');
    await writeFile(sibling, 'CHAT_API_PORT=3211\n', { mode: 0o600 });
    await expect(readConfigEnv(sibling, root, {})).rejects.toThrow('outside');
    await chmod(local, 0o644);
    await expect(readConfigEnv(local, root, {})).rejects.toThrow('0600');
    await chmod(local, 0o4600);
    await expect(readConfigEnv(local, root, {})).rejects.toThrow('0600');
    await chmod(local, 0o600);
    for (const mode of [0o775, 0o757]) {
      await chmod(app, mode);
      await expect(readConfigEnv(local, root, {})).rejects.toThrow('non-group/world-writable');
    }
    await chmod(app, 0o755);
    const owner = (await stat(local)).uid;
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    try { await expect(readConfigEnv(local, root, {})).rejects.toThrow('owner-owned'); }
    finally { uid.mockRestore(); }
    await rm(local);
    await mkdir(local, { mode: 0o600 });
    await expect(readConfigEnv(local, root, {})).rejects.toThrow('0600');
  });

  it('rejects app-local dotenv leaf, parent and ancestor symlink redirections', async () => {
    const { root, home, config, secrets } = await fixture();
    const app = path.join(root, 'apps', 'chat-api');
    await mkdir(app, { recursive: true });
    const local = runtimePaths({}, home, root).config;
    await symlink(config, local);
    await expect(readConfigEnv(local, root, {})).rejects.toThrow('symlinks');
    await rm(app, { recursive: true });
    await writeFile(path.join(secrets, '.env'), 'CHAT_API_PORT=3211\n', { mode: 0o600 });
    await symlink(secrets, app);
    await expect(readConfigEnv(local, root, {})).rejects.toThrow('symlinks');
    await rm(app);
    await mkdir(app);
    await writeFile(local, 'CHAT_API_PORT=3211\n', { mode: 0o600 });
    const redirected = path.join(root, 'redirected-apps');
    await rename(path.join(root, 'apps'), redirected);
    await symlink(redirected, path.join(root, 'apps'));
    await expect(readConfigEnv(local, root, {})).rejects.toThrow('exact app-local');
  });

  it('resolves a fake executable and inspects help without opening any tunnel', async () => {
    const { directory } = await fixture();
    const binary = path.join(directory, 'ngrok');
    await writeFile(binary, '#!/bin/sh\nif [ "$1" = "http" ] && [ "$2" = "--help" ]; then printf "%s\\n" "--url --inspect --config --log"; else exit 99; fi\n', { mode: 0o700 });
    const executable = await resolveExecutable('ngrok', directory);
    const { stdout } = await exec(executable, ['http', '--help']);
    expect(() => checkNgrokHelp(stdout)).not.toThrow();
    expect(() => checkNgrokHelp('--url')).toThrow('required');
    await expect(resolveExecutable('missing', directory)).rejects.toThrow('Install it separately');
  });

  it('requires an explicit private ngrok config without defaults and forwards only its configured path', async () => {
    const { root, home, config, paths, manifest } = await fixture();
    const shared = [path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml'), path.join(home, '.config', 'ngrok', 'ngrok.yml'), path.join(home, 'Library', 'Application Support', 'ngrok-translate', 'ngrok.yml')];
    for (const filename of shared) {
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, 'version: "3"\n', { mode: 0o600 });
      await expect(privateFile(filename, root)).resolves.toBe(filename);
    }
    await writeFile(config, 'CHAT_API_PORT=3211\n');
    vi.stubEnv('CHAT_NGROK_CONFIG_FILE', shared[0]);
    try { await expect(ngrokConfigFile(paths)).rejects.toThrow('Set CHAT_NGROK_CONFIG_FILE'); }
    finally { vi.unstubAllEnvs(); }
    await writeFile(config, 'CHAT_NGROK_CONFIG_FILE=relative/ngrok-translate.yml\n');
    await expect(ngrokConfigFile(paths)).rejects.toThrow('absolute path');
    await writeFile(config, `CHAT_NGROK_CONFIG_FILE="${manifest.ngrokConfig}"\n`);
    await expect(ngrokConfigFile(paths)).rejects.toThrow('No default ngrok config is used');
    await mkdir(path.dirname(manifest.ngrokConfig), { recursive: true, mode: 0o700 });
    await writeFile(manifest.ngrokConfig, 'version: "3"\n', { mode: 0o600 });
    await expect(ngrokConfigFile(paths)).resolves.toBe(manifest.ngrokConfig);
    await expect(ngrokConfigFile(manifest)).resolves.toBe(manifest.ngrokConfig);
    const args = ngrokArgs(manifest, { port: 3211, publicHost: 'chat.example.ngrok.app' });
    expect(args.slice(-2)).toEqual(['--config', manifest.ngrokConfig]);
    for (const filename of shared) expect(args).not.toContain(filename);
    await chmod(manifest.ngrokConfig, 0o644);
    await expect(ngrokConfigFile(manifest)).rejects.toThrow('0600 file with a 0700 parent');
    await chmod(manifest.ngrokConfig, 0o600);
    await chmod(path.dirname(manifest.ngrokConfig), 0o755);
    await expect(ngrokConfigFile(manifest)).rejects.toThrow('0700 parent');
  });

  it('rejects stale manifest config paths but permits verified migration stop', async () => {
    const { home, paths, manifest } = await fixture();
    await mkdir(path.dirname(manifest.ngrokConfig), { recursive: true, mode: 0o700 });
    await writeFile(manifest.ngrokConfig, 'version: "3"\n', { mode: 0o600 });
    const legacy = { ...manifest, ngrokConfig: path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml') };
    await expect(ngrokConfigFile(legacy)).rejects.toThrow('Run chat:install again');
    const fallback = { ...manifest, ngrokConfig: path.join(home, '.config', 'ngrok', 'ngrok.yml') };
    await expect(ngrokConfigFile(fallback)).rejects.toThrow('differs from CHAT_NGROK_CONFIG_FILE');
    await writeFile(path.join(paths.agents, `${paths.labels.tunnel}.plist`), plist(legacy, 'tunnel'), { mode: 0o600 });
    const calls: string[][] = [];
    await bootout(legacy, 'tunnel', async (_binary: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'print' ? job(legacy, 'tunnel') : '';
    });
    expect(calls.map(([action]) => action)).toEqual(['print', 'bootout']);
    await expect(bootout(legacy, 'tunnel', async () => job(legacy, 'tunnel').replace(legacy.script, '/unrelated.js'))).rejects.toThrow('unowned');
  });

  it('renders absolute secret-free foreground LaunchAgents and disables inspection/raw logging', async () => {
    const { config, root, manifest } = await fixture();
    const providerKey = 'synthetic-provider-secret';
    await writeFile(config, `CHAT_UPSTREAM_API_KEY=${providerKey}\n`);
    const env = await readConfigEnv(config, root, {});
    expect(env.CHAT_UPSTREAM_API_KEY).toBe(providerKey);
    const content = plist(manifest, 'app');
    expect(content).not.toContain('CHAT_UPSTREAM_API_KEY');
    expect(content).not.toContain(providerKey);
    expect(content).toContain(`<string>${manifest.node}</string>`);
    expect(content).toContain('<string>--app</string>');
    expect(content).toContain('<key>CHAT_CONFIG_FILE</key>');
    expect(content).not.toContain('CHAT_API_KEY');
    expect(content).not.toContain('KeepAlive');
    expect(content).not.toContain('build:chat');
    expect(content).not.toContain('StandardOutPath');
    expect(plist({ ...manifest, config: '/private/a&b.env' }, 'tunnel')).toContain('/private/a&amp;b.env');
    expect(ngrokArgs(manifest, { port: 3211, publicHost: 'chat.example.ngrok.app' })).toEqual(['http', 'http://127.0.0.1:3211', '--url', 'https://chat.example.ngrok.app', '--inspect=false', '--log=false', '--config', manifest.ngrokConfig]);
  });

  it('checks job identity and makes start/stop idempotent without invoking launchctl', async () => {
    const { manifest } = await fixture();
    await writeFile(path.join(manifest.agents, `${manifest.labels.app}.plist`), plist(manifest, 'app'), { mode: 0o600 });
    let running = false;
    const calls: string[][] = [];
    const run = async (_binary: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'print') { if (!running) throw new Error('not loaded'); return job(manifest); }
      if (args[0] === 'bootstrap') running = true;
      if (args[0] === 'bootout') running = false;
      return '';
    };
    await bootstrap(manifest, 'app', run);
    await bootstrap(manifest, 'app', run);
    expect(calls.filter(([action]) => action === 'bootstrap')).toHaveLength(1);
    await bootout(manifest, 'app', run);
    await bootout(manifest, 'app', run);
    expect(calls.filter(([action]) => action === 'bootout')).toHaveLength(1);
    expect(jobOwned(job(manifest), manifest, 'app')).toBe(true);
    expect(jobOwned(job(manifest).replace(manifest.script, '/unrelated.js'), manifest, 'app')).toBe(false);
    const unowned = async () => job(manifest).replace(manifest.node, '/wrong/node');
    await expect(bootout(manifest, 'app', unowned)).rejects.toThrow('unowned');
    await writeFile(path.join(manifest.agents, `${manifest.labels.app}.plist`), '<unrelated/>');
    await expect(bootstrap(manifest, 'app', run)).rejects.toThrow('unowned');
  });

  it('rejects other listeners and wildcard sockets even if readiness says ok', async () => {
    expect(listenerOwned('p123\ntIPv4\nn127.0.0.1:3211\n', 123, 3211)).toBe(true);
    expect(listenerOwned('p456\nn127.0.0.1:3211\n', 123, 3211)).toBe(false);
    expect(listenerOwned('p123\nn*:3211\n', 123, 3211)).toBe(false);
    expect(listenerOwned('p123\nn127.0.0.1:3211\np456\nn127.0.0.1:3211\n', 123, 3211)).toBe(false);
    const respond = (body: string, type = 'application/json') => async () => new Response(body, { headers: { 'content-type': type } });
    expect(await healthReady(3211, respond('{"status":"ok"}'))).toBe(true);
    expect(await healthReady(3211, respond('{"status":"ok","key":"secret"}'))).toBe(false);
    expect(await healthReady(3211, respond('<html>warning</html>', 'text/html'))).toBe(false);
    expect(await healthReady(3211, respond('x'.repeat(129)))).toBe(false);
    const { manifest } = await fixture();
    let probes = 0;
    const ready = async () => { probes++; return true; };
    expect(await appReady(manifest, 3211, async () => false, ready)).toBe(false);
    expect(probes).toBe(0);
    let checks = 0;
    expect(await appReady(manifest, 3211, async () => ++checks === 1, ready)).toBe(false);
    expect(checks).toBe(2);
    expect(probes).toBe(1);
  });

  it('bounds restarts and finite private logs without forwarding arbitrary child output', async () => {
    const now = 1_000_000;
    expect(restartAllowed([now, now, now, now], now)).toBe(true);
    expect(restartAllowed([now, now, now, now, now], now)).toBe(false);
    expect(restartAllowed([now - 600_000, now, now, now, now], now)).toBe(true);
    const { paths, config, root } = await fixture();
    const providerKey = 'synthetic-provider-secret';
    await writeFile(config, `CHAT_UPSTREAM_API_KEY=${providerKey}\n`);
    expect((await readConfigEnv(config, root, {})).CHAT_UPSTREAM_API_KEY).toBe(providerKey);
    for (let index = 0; index < 6; index++) {
      await writeFile(path.join(paths.state, 'app.log'), 'x'.repeat(256 * 1024), { mode: 0o600 });
      await lifecycleLog(paths.state, 'app exited');
    }
    const files = (await readdir(paths.state)).filter((name) => name.startsWith('app.log'));
    expect(files.sort()).toEqual(['app.log', 'app.log.1', 'app.log.2', 'app.log.3']);
    expect((await stat(path.join(paths.state, 'app.log'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(paths.state, 'app.log'), 'utf8')).toContain('app exited');
    expect(await readFile(path.join(paths.state, 'app.log'), 'utf8')).not.toContain(providerKey);
    await expect(lifecycleLog(paths.state, 'raw request {"authorization":"secret"}')).rejects.toThrow('Unsafe');
  });

  it('accepts only anchored fixed request metadata and serializes bounded private writes', async () => {
    const { paths } = await fixture();
    const id = 'cba5322a-3c17-4b8e-8e0f-12ce8bc85a39';
    const request = `app request id=${id} method=POST route=chat-completions`;
    const response = `app response id=${id} status=200 duration_ms=7 outcome=finished`;
    const send = (event: string) => consumeAppLog(paths.state, { type: 'chat-request-log', event });
    for (const invalid of [
      `${request}\n`, `${request}\nsecret`, `secret ${request}`, `${request} body=secret`,
      request.replace('POST', 'SECRET'), request.replace('chat-completions', '/v1/chat/completions?secret'),
      request.replace(id, 'user-supplied-secret'), response.replace('status=200', 'status=999'),
      response.replace('duration_ms=7', 'duration_ms=-1'), response.replace('finished', 'secret'),
      `app raw secret`, 'secret'.repeat(1000)
    ]) send(invalid);
    consumeAppLog(paths.state, { type: 'other', event: request });
    consumeAppLog(paths.state, { type: 'chat-request-log', event: { secret: true } });
    consumeAppLog(paths.state, null);
    send(request);
    send(response);
    send(response.replace('status=200', 'status=0').replace('finished', 'aborted'));
    await flushLifecycleLogs(paths.state);
    const logged = await readFile(path.join(paths.state, 'app.log'), 'utf8');
    expect(logged.trim().split('\n').map((line) => line.slice(25))).toEqual([
      request, response, response.replace('status=200', 'status=0').replace('finished', 'aborted')
    ]);
    expect(logged).not.toContain('secret');
    expect((await stat(path.join(paths.state, 'app.log'))).mode & 0o777).toBe(0o600);
    await writeFile(path.join(paths.state, 'app.log'), '');
    for (let index = 0; index < 1100; index++) send(request);
    await flushLifecycleLogs(paths.state);
    expect((await readFile(path.join(paths.state, 'app.log'), 'utf8')).trim().split('\n')).toHaveLength(1024);
  });

  it('contains log IO failures and recovers on the next event', async () => {
    const { paths } = await fixture();
    const missing = path.join(paths.state, 'missing');
    await expect(lifecycleLog(missing, 'app started')).resolves.toBeUndefined();
    await mkdir(missing, { mode: 0o700 });
    await lifecycleLog(missing, 'app exited');
    expect(await readFile(path.join(missing, 'app.log'), 'utf8')).toContain('app exited');
  });

  it('prints only recent current scoped logs in finite mode and creates missing private files', async () => {
    const { paths } = await fixture();
    await writeFile(path.join(paths.state, 'app.log'), Array.from({ length: 70 }, (_, index) => `app event-${index}\n`).join(''), { mode: 0o600 });
    await writeFile(path.join(paths.state, 'app.log.1'), 'archived-secret\n');
    await writeFile(path.join(paths.state, 'other.log'), 'unscoped-secret\n');
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString(); });
    await viewLogs(paths.state, { follow: false, output });
    expect(text.trim().split('\n')).toHaveLength(50);
    expect(text).toContain('app event-20\n');
    expect(text).toContain('app event-69\n');
    expect(text).not.toContain('secret');
    for (const scope of ['runtime', 'app', 'tunnel']) expect((await stat(path.join(paths.state, `${scope}.log`))).mode & 0o777).toBe(0o600);
    output.destroy();
  });

  it('follows real appends and rotation without duplicating events and stops on abort', async () => {
    const { paths } = await fixture();
    await lifecycleLog(paths.state, 'app started');
    const output = new PassThrough();
    const controller = new AbortController();
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString(); });
    const following = viewLogs(paths.state, { signal: controller.signal, output });
    const seen = (event: string) => new Promise<void>((resolve) => {
      const check = () => {
        if (text.includes(event)) { output.off('data', check); resolve(); }
      };
      output.on('data', check);
      check();
    });
    try {
      await seen('app started');
      await lifecycleLog(paths.state, 'app ordinary-append');
      await seen('app ordinary-append');
      expect(text.match(/app started/g)).toHaveLength(1);
      expect(text.match(/app ordinary-append/g)).toHaveLength(1);
      await rename(path.join(paths.state, 'app.log'), path.join(paths.state, 'app.log.1'));
      await lifecycleLog(paths.state, 'app after-rotation');
      await seen('app after-rotation');
      expect(text.match(/app after-rotation/g)).toHaveLength(1);
    } finally {
      controller.abort();
      await following;
      output.destroy();
    }
    const stopped = text;
    await lifecycleLog(paths.state, 'app after-abort');
    expect(text).toBe(stopped);
  }, 20_000);
});
