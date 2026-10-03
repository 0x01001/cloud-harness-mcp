import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv, promisify, TextDecoder } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const launchctl = '/bin/launchctl';
const ps = '/bin/ps';
const lsof = '/usr/sbin/lsof';
const MAX_LOG_BYTES = 256 * 1024;
const LOG_COPIES = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_LIMIT = 5;
const CONFIG_KEYS = new Set(['CHAT_API_PORT', 'CHAT_API_KEY_FILE', 'CHAT_UPSTREAM_BASE_URL', 'CHAT_UPSTREAM_API_KEY', 'CHAT_ALLOWED_MODELS', 'CHAT_PUBLIC_HOST', 'CHAT_NGROK_CONFIG_FILE', 'CHAT_MAX_REQUEST_BYTES', 'CHAT_MAX_RESPONSE_BYTES', 'CHAT_MAX_CONCURRENT_REQUESTS', 'CHAT_REQUESTS_PER_MINUTE', 'CHAT_REQUEST_DEADLINE_MS']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

export function assertRuntime(platform = process.platform, version = process.versions.node) {
  if (platform !== 'darwin') throw new Error('Chat LaunchAgents require macOS. Use start:chat for foreground operation elsewhere.');
  if (Number(version.split('.')[0]) < 24) throw new Error('Node.js >=24 is required; select it before running the chat commands.');
}

/**
 * @typedef {object} RuntimeManifest
 * @property {string} root
 * @property {string} home
 * @property {string} config
 * @property {string} state
 * @property {string} manifest
 * @property {{app: string, tunnel: string}} labels
 * @property {string} agents
 * @property {string} node
 * @property {string} script
 * @property {string} ngrok
 * @property {string} ngrokConfig
 * @property {string} entry
 */

export function runtimePaths(env = process.env, home = homedir(), root = repo) {
  const base = path.join(home, 'Library', 'Application Support', 'cloudharness-chat');
  if (env.CHAT_CONFIG_FILE && !path.isAbsolute(env.CHAT_CONFIG_FILE)) throw new Error('CHAT_CONFIG_FILE must be absolute.');
  const config = env.CHAT_CONFIG_FILE ? path.resolve(env.CHAT_CONFIG_FILE) : path.resolve(root, 'apps', 'chat-api', '.env');
  const id = createHash('sha256').update(config).digest('hex').slice(0, 16);
  const state = path.join(base, 'runtime', id);
  const prefix = `com.cloudharness.chat.${id}`;
  return { root, home, config, state, manifest: path.join(state, 'runtime.json'), labels: { app: `${prefix}.app`, tunnel: `${prefix}.tunnel` }, agents: path.join(home, 'Library', 'LaunchAgents') };
}

function outsideRepo(filename, root) {
  const relative = path.relative(root, filename);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Chat private files must be outside the checkout.');
}

export async function privateFile(filename, root) {
  if (!path.isAbsolute(filename)) throw new Error('Private file paths must be absolute.');
  if ((await lstat(filename)).isSymbolicLink() || (await lstat(path.dirname(filename))).isSymbolicLink()) throw new Error('Private files and immediate directories must not be symlinks.');
  const resolved = await realpath(filename);
  outsideRepo(resolved, await realpath(root));
  const info = await stat(resolved);
  const parent = await stat(path.dirname(resolved));
  if (!info.isFile() || (info.mode & 0o7777) !== 0o600 || (parent.mode & 0o7777) !== 0o700 || info.uid !== process.getuid() || parent.uid !== process.getuid()) {
    throw new Error('Private files require owner-only 0600 files and 0700 parent directories.');
  }
  return resolved;
}

export async function ngrokConfigFile(paths) {
  const env = await readConfigEnv(paths.config, paths.root, {});
  if (!env.CHAT_NGROK_CONFIG_FILE || !path.isAbsolute(env.CHAT_NGROK_CONFIG_FILE)) {
    throw new Error('Set CHAT_NGROK_CONFIG_FILE to the absolute path of your dedicated ngrok-translate config in the private chat config. No default ngrok config is used.');
  }
  let filename;
  try { filename = await privateFile(env.CHAT_NGROK_CONFIG_FILE, paths.root); }
  catch { throw new Error('CHAT_NGROK_CONFIG_FILE must select a private ngrok-translate config outside this checkout: a 0600 file with a 0700 parent directory, without symlinks. No default ngrok config is used.'); }
  if (paths.ngrokConfig !== undefined && paths.ngrokConfig !== filename) {
    throw new Error('Chat runtime ngrok config differs from CHAT_NGROK_CONFIG_FILE. Run chat:install again; chat:stop and chat:uninstall remain available.');
  }
  return filename;
}

async function configFile(filename, root) {
  if (filename !== path.resolve(root, 'apps', 'chat-api', '.env')) return privateFile(filename, root);
  if ((await lstat(filename)).isSymbolicLink() || (await lstat(path.dirname(filename))).isSymbolicLink()) throw new Error('Chat config files and immediate directories must not be symlinks.');
  const resolved = await realpath(filename);
  if (resolved !== path.join(await realpath(root), 'apps', 'chat-api', '.env')) throw new Error('Chat config must be the exact app-local .env.');
  const info = await stat(resolved);
  const parent = await stat(path.dirname(resolved));
  if (!info.isFile() || (info.mode & 0o7777) !== 0o600 || info.uid !== process.getuid() || !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0) {
    throw new Error('App-local chat config requires an owner-owned 0600 file and a non-group/world-writable owner-owned directory.');
  }
  return resolved;
}

export async function readConfigEnv(filename, root, env = process.env) {
  const resolved = await configFile(filename, root);
  const info = await stat(resolved);
  if (info.size > 64 * 1024) throw new Error('Chat config file is too large.');
  const parsed = parseEnv(await readFile(resolved, 'utf8'));
  // No shell expansion, sourcing, or arbitrary environment injection.
  if (Object.keys(parsed).some((key) => !CONFIG_KEYS.has(key))) throw new Error('Unknown private chat configuration setting.');
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CHAT_') || CONFIG_KEYS.has(key)));
  return { ...parsed, ...inherited, CHAT_CONFIG_FILE: resolved };
}

export async function resolveExecutable(name, searchPath = process.env.PATH ?? '') {
  const candidates = path.isAbsolute(name) ? [name] : searchPath.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch { /* Try the next explicit PATH entry. */ }
  }
  throw new Error(`Missing executable: ${path.basename(name)}. Install it separately and select it in PATH.`);
}

export function checkNgrokHelp(help) {
  if (!['--url', '--inspect', '--config', '--log'].every((flag) => help.includes(flag))) {
    throw new Error('Installed ngrok lacks required --url/--inspect/--config/--log flags; update ngrok separately.');
  }
}

export function plist(manifest, kind) {
  const args = [manifest.node, manifest.script, `--${kind}`, manifest.manifest];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(manifest.labels[kind])}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(manifest.root)}</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(manifest.home)}</string><key>CHAT_CONFIG_FILE</key><string>${xml(manifest.config)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>ExitTimeOut</key><integer>15</integer>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n`;
}

async function atomicPrivate(filename, contents) {
  const temp = `${filename}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
  try { await rename(temp, filename); } finally { await rm(temp, { force: true }); }
  await chmod(filename, 0o600);
}

export async function lifecycleLog(state, event) {
  // Only callers' fixed lifecycle vocabulary reaches disk; never child output.
  if (!/^[a-z0-9 _=:-]+$/i.test(event) || event.length > 160) throw new Error('Unsafe lifecycle log event.');
  const scope = event.startsWith('app ') ? 'app' : event.startsWith('tunnel ') ? 'tunnel' : 'runtime';
  const filename = path.join(state, `${scope}.log`);
  const line = `${new Date().toISOString()} ${event}\n`;
  let size = 0;
  try { size = (await stat(filename)).size; } catch { /* First event. */ }
  if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    await rm(`${filename}.${LOG_COPIES}`, { force: true });
    for (let index = LOG_COPIES - 1; index >= 0; index--) {
      try { await rename(index ? `${filename}.${index}` : filename, `${filename}.${index + 1}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await writeFile(filename, line, { flag: 'a', mode: 0o600 });
  await chmod(filename, 0o600);
}

async function command(binary, args) {
  try { return (await exec(binary, args, { timeout: 15_000, maxBuffer: 128 * 1024 })).stdout; }
  catch { throw new Error(`Runtime prerequisite/command failed: ${path.basename(binary)} ${args[0] ?? ''}.`); }
}

export function jobOwned(output, manifest, kind) {
  const expected = path.join(manifest.agents, `${manifest.labels[kind]}.plist`);
  const lines = output.split('\n').map((line) => line.trim());
  return lines.includes(`path = ${expected}`) && lines.includes(`program = ${manifest.node}`) &&
    [manifest.script, `--${kind}`, manifest.manifest].every((arg) => lines.includes(arg));
}

async function assertPlistOwned(manifest, kind) {
  const filename = path.join(manifest.agents, `${manifest.labels[kind]}.plist`);
  if ((await lstat(filename)).isSymbolicLink() || await readFile(filename, 'utf8') !== plist(manifest, kind)) throw new Error('Refusing to change an unowned LaunchAgent registration.');
}

export async function loaded(manifest, kind, run = command) {
  let output;
  try { output = await run(launchctl, ['print', `gui/${process.getuid()}/${manifest.labels[kind]}`]); } catch { return undefined; }
  if (!jobOwned(output, manifest, kind)) throw new Error('Refusing to change an unowned launchd job.');
  return output;
}

export async function bootstrap(manifest, kind, run = command) {
  await assertPlistOwned(manifest, kind);
  const output = await loaded(manifest, kind, run);
  if (!output) await run(launchctl, ['bootstrap', `gui/${process.getuid()}`, path.join(manifest.agents, `${manifest.labels[kind]}.plist`)]);
  else if (!/\bpid = \d+/.test(output)) await run(launchctl, ['kickstart', `gui/${process.getuid()}/${manifest.labels[kind]}`]);
}

export async function bootout(manifest, kind, run = command) {
  await assertPlistOwned(manifest, kind);
  if (await loaded(manifest, kind, run)) await run(launchctl, ['bootout', `gui/${process.getuid()}/${manifest.labels[kind]}`]);
}

async function configFor(manifest) {
  await ngrokConfigFile(manifest);
  await access(manifest.entry, constants.R_OK);
  const env = await readConfigEnv(manifest.config, manifest.root, { HOME: manifest.home, PATH: path.dirname(manifest.node) });
  let config;
  try {
    const { loadChatConfig } = await import(pathToFileURL(path.join(manifest.root, 'apps/chat-api/dist/config.js')).href);
    config = await loadChatConfig(env);
  } catch { throw new Error('Chat configuration invalid or chat build missing. Check private files and run build:chat.'); }
  if (!config.publicHost) throw new Error('CHAT_PUBLIC_HOST is required for tunnel operation.');
  return { config, env };
}

async function readManifest(paths, allowMoved = false) {
  try {
    await privateFile(paths.manifest, paths.root);
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
    if (manifest.config !== paths.config || manifest.home !== paths.home || manifest.state !== paths.state || manifest.agents !== paths.agents || manifest.manifest !== paths.manifest || JSON.stringify(manifest.labels) !== JSON.stringify(paths.labels) ||
      ![manifest.node, manifest.ngrok, manifest.ngrokConfig, manifest.root].every((value) => typeof value === 'string' && path.isAbsolute(value)) ||
      manifest.script !== path.join(manifest.root, 'scripts', 'chat-runtime.mjs') || manifest.entry !== path.join(manifest.root, 'apps', 'chat-api', 'dist', 'index.js') ||
      (!allowMoved && (manifest.root !== paths.root || manifest.script !== script))) throw new Error('mismatch');
    return manifest;
  } catch { throw new Error('Chat runtime not installed for this checkout/config path. Run chat:install.'); }
}

async function record(manifest, kind) {
  try { return JSON.parse(await readFile(path.join(manifest.state, `${kind}.json`), 'utf8')); } catch { return undefined; }
}

async function processMatches(pid, binary, args, parent) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const output = await command(ps, ['-p', String(pid), '-o', 'ppid=', '-o', 'command=']);
    const match = output.trim().match(/^(\d+)\s+(.+)$/);
    return Boolean(match && (parent === undefined || Number(match[1]) === parent) && match[2] === [binary, ...args].join(' '));
  } catch { return false; }
}

export function listenerOwned(output, pid, port) {
  const rows = output.trim().split('\n');
  let currentPid;
  let found = false;
  for (const row of rows) {
    if (row.startsWith('p')) currentPid = Number(row.slice(1));
    if (row.startsWith('n')) {
      if (currentPid !== pid || row !== `n127.0.0.1:${port}`) return false;
      found = true;
    }
  }
  return found;
}

async function ownsApp(manifest, port) {
  const owned = await record(manifest, 'app');
  const job = await loaded(manifest, 'app');
  if (!owned || !job || Number(job.match(/\bpid = (\d+)/)?.[1]) !== owned.launcher || !(await processMatches(owned.launcher, manifest.node, [manifest.script, '--app', manifest.manifest])) || !(await processMatches(owned.pid, manifest.node, [manifest.entry], owned.launcher))) return false;
  try {
    const listeners = await command(lsof, ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpnt']);
    return listenerOwned(listeners, owned.pid, port);
  } catch { return false; }
}

export async function healthReady(port, fetcher = fetch) {
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/readyz`, { redirect: 'error', signal: globalThis.AbortSignal.timeout(1500) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    let body = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      if (body.length > 128) { await reader.cancel(); return false; }
    }
    body += decoder.decode();
    return JSON.stringify(JSON.parse(body)) === '{"status":"ok"}';
  } catch { return false; }
}

export async function appReady(manifest, port, owned = ownsApp, ready = healthReady) {
  return await owned(manifest, port) && await ready(port) && await owned(manifest, port);
}

async function waitReady(manifest, port, timeout = 30_000, signal) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error('Runtime stopped while waiting for readiness.');
    if (await appReady(manifest, port)) return;
    await delay(500);
  }
  throw new Error('Owned chat process did not become ready; no tunnel was started.');
}

export function ngrokArgs(manifest, config) {
  return ['http', `http://127.0.0.1:${config.port}`, '--url', `https://${config.publicHost}`, '--inspect=false', '--log=false', '--config', manifest.ngrokConfig];
}

export function restartAllowed(history, now = Date.now()) {
  return history.filter((time) => now - time < RESTART_WINDOW_MS).length < RESTART_LIMIT;
}

async function foreground(manifest, kind) {
  await ngrokConfigFile(manifest);
  const registration = await loaded(manifest, kind);
  if (!registration || Number(registration.match(/\bpid = (\d+)/)?.[1]) !== process.pid) throw new Error('Foreground entry modes may only run as the registered LaunchAgent.');
  const history = [];
  let stopping = false;
  let child;
  let monitor;
  let forceTimer;
  const shutdown = new globalThis.AbortController();
  const terminate = () => {
    stopping = true;
    shutdown.abort();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child?.kill('SIGKILL'), 10_000);
      forceTimer.unref();
    }
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  try {
    while (!stopping && restartAllowed(history)) {
      history.push(Date.now());
      try {
        const { config, env } = await configFor(manifest);
        if (kind === 'tunnel') await waitReady(manifest, config.port, 30_000, shutdown.signal);
        if (stopping) break;
        child = spawn(kind === 'app' ? manifest.node : manifest.ngrok, kind === 'app' ? [manifest.entry] : ngrokArgs(manifest, config), {
          cwd: manifest.root, env, stdio: 'ignore'
        });
        const done = new Promise((resolve) => { child.once('error', () => resolve()); child.once('exit', resolve); });
        if (child.pid) await atomicPrivate(path.join(manifest.state, `${kind}.json`), JSON.stringify({ launcher: process.pid, pid: child.pid }));
        await lifecycleLog(manifest.state, `${kind} started`);
        if (kind === 'tunnel') {
          const current = child;
          let active = true;
          let checking = false;
          done.then(() => { active = false; });
          const stopCurrent = () => {
            if (!active || stopping || current.exitCode !== null || current.signalCode !== null) return;
            current.kill('SIGTERM');
            forceTimer ??= setTimeout(() => current.kill('SIGKILL'), 10_000);
            forceTimer.unref();
          };
          monitor = setInterval(async () => {
            if (!active || checking || stopping) return;
            checking = true;
            try { if (!(await appReady(manifest, config.port))) stopCurrent(); }
            catch { stopCurrent(); }
            finally { checking = false; }
          }, 2000);
        }
        await done;
        await lifecycleLog(manifest.state, `${kind} exited`);
      } catch { await lifecycleLog(manifest.state, `${kind} prerequisite-or-process-failure`); }
      finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        clearInterval(monitor);
        clearTimeout(forceTimer);
        forceTimer = undefined;
        await rm(path.join(manifest.state, `${kind}.json`), { force: true });
      }
      if (!stopping) await new Promise((resolve) => {
        const timer = setTimeout(finish, 30_000);
        function finish() { clearTimeout(timer); shutdown.signal.removeEventListener('abort', finish); resolve(); }
        shutdown.signal.addEventListener('abort', finish, { once: true });
        if (shutdown.signal.aborted) finish();
      });
    }
    await lifecycleLog(manifest.state, `${kind} ${stopping ? 'stopped' : 'restart-limit-reached'}`);
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
  }
}

async function install(paths) {
  // Preflight is operator-triggered only; no installation, credential printing, or mutation.
  await configFile(paths.config, paths.root);
  const node = await realpath(process.execPath);
  await Promise.all([launchctl, ps, lsof].map((binary) => access(binary, constants.X_OK)));
  await command(launchctl, ['print', `gui/${process.getuid()}`]);
  const ngrok = await resolveExecutable('ngrok');
  checkNgrokHelp(await command(ngrok, ['http', '--help']));
  const ngrokConfig = await ngrokConfigFile(paths);
  await command(ngrok, ['config', 'check', '--config', ngrokConfig]);
  const npm = process.env.npm_execpath;
  if (!npm || !path.isAbsolute(npm)) throw new Error('Run install through npm run chat:install (or make install).');
  await access(npm, constants.R_OK);
  try { await exec(node, [npm, 'run', 'build:chat'], { cwd: paths.root, env: { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ''}` }, timeout: 120_000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('build:chat failed; no LaunchAgents were installed.'); }
  const manifest = { ...paths, node, script, ngrok, ngrokConfig, entry: path.join(paths.root, 'apps', 'chat-api', 'dist', 'index.js') };
  const { config } = await configFor(manifest);
  for (const directory of [path.dirname(path.dirname(paths.state)), path.dirname(paths.state), paths.state]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('Runtime directories require owner-only 0700 non-symlink directories.');
  }
  await mkdir(paths.agents, { recursive: true });
  let previous;
  try { await access(paths.manifest); previous = await readManifest(paths, true); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const kind of ['app', 'tunnel']) {
    const filename = path.join(paths.agents, `${paths.labels[kind]}.plist`);
    try {
      await access(filename);
      if (!previous) throw new Error('Existing LaunchAgent not registered by this chat instance.');
      await assertPlistOwned(previous, kind);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Never replace a same-label job registered from another checkout.
    await loaded(previous ?? manifest, kind);
  }
  const changed = previous && JSON.stringify(previous) !== JSON.stringify(manifest);
  if (changed) {
    await bootout(previous, 'tunnel');
    await bootout(previous, 'app');
  }
  await atomicPrivate(paths.manifest, JSON.stringify(manifest));
  for (const kind of ['app', 'tunnel']) {
    const filename = path.join(paths.agents, `${paths.labels[kind]}.plist`);
    let exists = true;
    try { await access(filename); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (!exists || changed) await atomicPrivate(filename, plist(manifest, kind));
  }
  await lifecycleLog(paths.state, 'installed');
  await start(manifest, config);
}

async function start(manifest, config) {
  await ngrokConfigFile(manifest);
  await bootstrap(manifest, 'app');
  await waitReady(manifest, config.port);
  await bootstrap(manifest, 'tunnel');
  console.log('Chat app ready; scoped tunnel job started. Review ngrok account capture/retention before sharing the URL.');
}

export async function main(argv = process.argv.slice(2)) {
  assertRuntime();
  process.umask(0o077);
  const action = argv[0];
  if (!['install', 'start', 'status', 'logs', 'stop', 'uninstall', '--app', '--tunnel'].includes(action) || argv.length !== (action.startsWith('--') ? 2 : 1)) throw new Error('Usage: chat-runtime.mjs install|start|status|logs|stop|uninstall');
  const paths = runtimePaths();
  if (action === 'install') return install(paths);
  const manifest = await readManifest(paths);
  if (action.startsWith('--')) {
    if (path.resolve(argv[1]) !== paths.manifest) throw new Error('Unexpected runtime manifest path.');
    return foreground(manifest, action.slice(2));
  }
  if (action === 'stop' || action === 'uninstall') {
    await bootout(manifest, 'tunnel');
    await bootout(manifest, 'app');
    if (action === 'uninstall') {
      for (const kind of ['app', 'tunnel']) await rm(path.join(manifest.agents, `${manifest.labels[kind]}.plist`), { force: true });
      await rm(manifest.manifest, { force: true });
    }
    await lifecycleLog(manifest.state, action === 'stop' ? 'stopped' : 'uninstalled');
    console.log(`Chat ${action === 'stop' ? 'stopped' : 'uninstalled'}; private config and keys retained.`);
    return;
  }
  if (action === 'logs') {
    for (const scope of ['runtime', 'app', 'tunnel']) {
      for (let index = LOG_COPIES; index >= 0; index--) {
        try { process.stdout.write(await readFile(path.join(manifest.state, index ? `${scope}.log.${index}` : `${scope}.log`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return;
  }
  const { config } = await configFor(manifest);
  if (action === 'start') return start(manifest, config);
  const ready = await appReady(manifest, config.port);
  const tunnel = await record(manifest, 'tunnel');
  const tunnelJob = await loaded(manifest, 'tunnel');
  const active = tunnel && tunnelJob && Number(tunnelJob.match(/\bpid = (\d+)/)?.[1]) === tunnel.launcher && await processMatches(tunnel.launcher, manifest.node, [manifest.script, '--tunnel', manifest.manifest]) && await processMatches(tunnel.pid, manifest.ngrok, ngrokArgs(manifest, config), tunnel.launcher);
  console.log(`chat=${ready ? 'ready-owned' : 'not-ready'} tunnel=${active ? 'running-owned' : 'not-running'}`);
  if (!ready || !active) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main().catch(() => {
    // Do not print arbitrary exception messages (config/build/agent may echo secrets).
    console.error('Chat runtime command failed. Check Node >=24, macOS login session, private config permissions, build:chat and ngrok prerequisites. Set CHAT_NGROK_CONFIG_FILE in the private chat config to an absolute dedicated ngrok-translate config path (0600 file, 0700 parent directory); no default ngrok config is used. Run chat:install after changing this path; chat:stop and chat:uninstall remain available. Use chat:logs for sanitized lifecycle events.');
    process.exitCode = 1;
  });
}
