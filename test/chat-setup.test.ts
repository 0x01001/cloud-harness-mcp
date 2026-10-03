import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));

it('reuses pinned project tools, keeps make gen stdout clean, and fails without claiming setup completed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-setup-'));
  try {
    const bin = path.join(root, '.local-runtime/node_modules/.bin');
    const npmDir = path.join(root, '.local-runtime/node_modules/npm/bin');
    const system = path.join(root, 'bootstrap-bin');
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(npmDir, { recursive: true }), mkdir(system), mkdir(path.join(root, 'scripts'))]);
    await Promise.all(['setup-chat.mjs', 'chat-runtime.mjs'].map((file) => copyFile(path.join(repo, 'scripts', file), path.join(root, 'scripts', file))));
    await copyFile(path.join(repo, 'Makefile'), path.join(root, 'Makefile'));
    await writeFile(path.join(bin, 'node'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.21.0; else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi\n`, { mode: 0o755 });
    await writeFile(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.21.0; else exec node "$(dirname "$0")/../npm/bin/npm-cli.js" "$@"; fi\n', { mode: 0o755 });
    await writeFile(path.join(system, 'npm'), '#!/bin/sh\necho "global npm must not run" >&2\nexit 77\n', { mode: 0o755 });
    await writeFile(path.join(system, 'ngrok'), '#!/bin/sh\ncase "$1" in\n--version) echo "ngrok version 3.37.1" ;;\nhttp) echo "--url --inspect --config --log" ;;\n*) exit 78 ;;\nesac\n', { mode: 0o755 });
    await writeFile(path.join(npmDir, 'npm-cli.js'), `
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.SETUP_TRACE, JSON.stringify({ args }) + '\\n');
if (args.includes('chat:gen')) console.log('synthetic-client-key');
else if (args[0] === 'ci') process.exit(0);
else if (args.join(' ') === 'run build:chat') process.exit(23);
else process.exit(79);
`);
    const trace = path.join(root, 'trace.jsonl');
    const env = { ...process.env, PATH: `${system}${path.delimiter}${process.env.PATH}`, SETUP_TRACE: trace };
    const gen = await exec('make', ['gen'], { cwd: root, env });
    expect(gen.stdout).toBe('synthetic-client-key\n');
    const result = await exec(process.execPath, [path.join(root, 'scripts/setup-chat.mjs')], { cwd: root, env }).then(
      () => { throw new Error('setup unexpectedly succeeded'); },
      (error: { code: number; stdout: string; stderr: string }) => error
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Reusing project-only Node 24.21.0 and npm 11.21.0');
    expect(result.stdout).not.toContain('[setup] Complete.');
    expect(result.stderr).toContain('build:chat failed');
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args)).toEqual([['--silent', 'run', 'chat:gen'], ['ci', '--global=false', '--include=dev'], ['run', 'build:chat']]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
