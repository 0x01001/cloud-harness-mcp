import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNgrokHelp, resolveExecutable } from './chat-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = path.join(root, '.local-runtime');
const bin = path.join(prefix, 'node_modules', '.bin');
const node = path.join(bin, 'node');
const npm = path.join(bin, 'npm');
const npmCli = path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const NODE_VERSION = '24.21.0';
const NPM_VERSION = '11.21.0';
const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };

function probe(command, args) {
  return spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function run(command, args, failure, capture = false) {
  // Child output is not forwarded: setup needs no credentials or config contents.
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore' });
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout ?? '';
}

async function setup() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Bootstrap requires an existing Node.js >=22 and npm on PATH. Node 24 will be installed only in this checkout.');
  }

  console.log('[setup] Checking ngrok prerequisite (no config or credentials read).');
  let ngrok;
  try { ngrok = await resolveExecutable('ngrok'); } catch {
    if (process.platform !== 'darwin') throw new Error('Install ngrok for your platform, put it on PATH, then rerun make setup.');
    let brew;
    try { brew = await resolveExecutable('brew'); } catch {
      throw new Error('ngrok is missing. Install Homebrew separately (https://brew.sh), then rerun make setup, or install ngrok (https://ngrok.com/download/mac-os) and put it on PATH.');
    }
    console.log('[setup] Installing ngrok with existing Homebrew.');
    // Official macOS command: https://ngrok.com/download/mac-os
    run(brew, ['install', 'ngrok'], 'ngrok installation failed. Check Homebrew/network access and rerun make setup.');
    try { ngrok = await resolveExecutable('ngrok'); } catch {
      throw new Error('Homebrew finished but ngrok is not on PATH. Add the existing Homebrew bin directory to PATH and rerun make setup.');
    }
  }
  const ngrokVersion = run(ngrok, ['--version'], 'ngrok --version failed. Repair the existing ngrok installation and rerun make setup.', true).trim();
  if (!/^ngrok version \d+\.\d+/.test(ngrokVersion)) throw new Error('ngrok returned an unrecognized version. Install a current ngrok CLI and rerun make setup.');
  checkNgrokHelp(run(ngrok, ['http', '--help'], 'ngrok http --help failed. Repair ngrok and rerun make setup.', true));

  const installedNode = probe(node, ['--version']);
  const installedNpm = probe(npm, ['--version']);
  if (installedNode.status !== 0 || installedNode.stdout.trim() !== `v${NODE_VERSION}` || installedNpm.status !== 0 || installedNpm.stdout.trim() !== NPM_VERSION) {
    const bootstrapNpm = process.env.npm_execpath;
    if (!bootstrapNpm || !path.isAbsolute(bootstrapNpm)) {
      throw new Error('Run setup through make setup or npm run chat:setup using the existing Node.js/npm installation.');
    }
    console.log(`[setup] Installing project-only Node ${NODE_VERSION} and npm ${NPM_VERSION}.`);
    await mkdir(prefix, { recursive: true });
    run(process.execPath, [bootstrapNpm, 'install', '--prefix', prefix, '--global=false', '--no-save', '--no-package-lock', '--workspaces=false', `node@${NODE_VERSION}`, `npm@${NPM_VERSION}`], 'Project runtime installation failed. Check npm registry/network access and checkout permissions, then rerun make setup.');
  } else {
    console.log(`[setup] Reusing project-only Node ${NODE_VERSION} and npm ${NPM_VERSION}.`);
  }
  if (run(node, ['--version'], 'Project Node is not executable. Rerun make setup.', true).trim() !== `v${NODE_VERSION}` || run(npm, ['--version'], 'Project npm is not executable. Rerun make setup.', true).trim() !== NPM_VERSION) {
    throw new Error('Project runtime versions do not match the pinned versions. Remove only .local-runtime and rerun make setup.');
  }

  console.log('[setup] Installing locked project dependencies with project Node/npm.');
  run(node, [npmCli, 'ci', '--global=false', '--include=dev'], 'npm ci failed. Check package-lock.json, npm registry/network access and checkout permissions, then rerun make setup.');
  console.log('[setup] Building chat API with project Node/npm.');
  run(node, [npmCli, 'run', 'build:chat'], 'build:chat failed. Run PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" npm run build:chat for diagnostics.');
  console.log('[setup] Complete. make commands now use the project runtime; global Node/npm are unchanged. No credentials, services or tunnels were configured or started.');
}

setup().catch((error) => {
  console.error(`[setup] ${error.message}`);
  process.exitCode = 1;
});
