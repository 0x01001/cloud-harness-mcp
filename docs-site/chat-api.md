---
title: Independent Chat API
description: Run a separate inference-only OpenAI-compatible API on loopback, optionally exposed through ngrok.
---

# Independent Chat API

`apps/chat-api` is a separate Node.js process, not MCP, the dashboard API-key gateway, or the internal leased Model Gateway. It needs no MCP server, runner, database, Docker/Colima, Cloudflare deployment, workspace, or agent lease. It forwards inference to one operator-selected upstream; it does not run a local model.

> **Rollout status:** no live-provider capability evidence or public ngrok endpoint proof is recorded for this implementation. Installing services, opening a tunnel, or making billed requests requires a separate operator-authorized rollout; the commands below are instructions, not evidence that those operations ran.

## Contract and limits

| Route | Authentication | Result |
| --- | --- | --- |
| `GET /v1/models` | Chat Bearer key | Upstream catalog filtered to the configured allowlist |
| `POST /v1/chat/completions` | Chat Bearer key | Native Chat Completions JSON or SSE |
| `POST /v1/responses` | Chat Bearer key | Native Responses JSON or SSE |
| `GET /healthz`, `GET /readyz` | None | Minimal local status only |

Other routes return `404`; wrong methods return `405`. There is no proxy wildcard, Responses retrieve/delete/cancel API, WebSocket, Anthropic Messages API, admin UI, or browser/CORS support. Use server-side SDKs or command-line clients. Readiness only means local configuration loaded and the process is serving; it does not prove provider authentication, quota, DNS reachability, or model capabilities.

Choose a public HTTPS upstream with **native support for both APIs and `/models`**, and at least one exact model ID that works with both. A Chat-only provider is not sufficient: the app does not translate Chat into Responses, silently drop unknown fields, choose another model, or fall back to another provider. Model IDs, including `/`, are opaque and forwarded unchanged. Discovery is not a capability certification.

Native request fields and successful JSON/SSE payloads pass through after envelope/content-type checks and byte limits. Tools, tool choices/results, structured output, content arrays, token controls, reasoning items, usage, and metadata work only to the extent the upstream supports them. **Tool definitions and calls are data; this server executes no tools, files, shell commands, or workspace operations.** Chat streams preserve upstream chunks and `[DONE]`; Responses preserve native event names/order/terminal events, without inserting Chat markers. SSE is forwarded with backpressure, not rebuilt into fake completions. An interrupted/oversized/timed-out stream closes; the app does not fabricate success or replay it.

Errors before streaming use OpenAI-style `{ "error": { "message": "...", "type": "...", "param": null, "code": "..." } }`. Missing/malformed/duplicate/wrong Bearer credentials return `401`; invalid JSON/envelope or forbidden models `400`; oversized requests `413`; unsupported media types/content encoding `415`; admission rejection `429`; network/invalid upstream responses `502`; deadline expiry before headers `504`. After SSE headers are sent, the status cannot change: failures close the stream instead of adding ordinary JSON. Native upstream JSON errors preserve status and sanitized error fields; redirects/HTML are not accepted as success. Only safe request IDs and `Retry-After` are forwarded alongside app-controlled content types.

### Quota-only provider-key failover

`CHAT_UPSTREAM_API_KEY` keeps its existing name and accepts either one key or an **ordered comma-separated list of nonempty unique keys, without spaces**, for example `<first-provider-api-key>,<second-provider-api-key>`. Each entry must satisfy the existing key validation: 32–4096 ASCII characters, no whitespace/control characters, and no placeholder values. A single key continues to work.

Every request starts with the first key; each key is attempted at most once. `/v1/models`, `/v1/chat/completions`, and `/v1/responses` advance to the next key **only before the downstream response starts** and only for an HTTP `429` with a valid native JSON error whose `code` equals `insufficient_quota`, or whose `type` equals `insufficient_quota` when `code` is absent/null. A different code takes precedence over type, so a rate-limit code is not quota exhaustion. All attempts use the same endpoint, model, request body, HTTPS policy, admission/concurrency slot, and **one total request deadline**, not a new deadline per key. The prior response body is disposed before the next attempt. If all keys exhaust quota, the last sanitized `429` error is returned.

This is not generic retry or model/provider fallback: ordinary rate-limit `429`, `401`, `5xx`, network failures, timeouts, and malformed/non-JSON errors do not advance keys. There is no sticky/global rotation, and no replay after SSE headers/content or on SSE errors. Sanitized errors redact **all configured client and provider keys**, including provider keys not yet attempted. Keep all secrets out of logs and public examples.

**Multiple keys may share the same provider project quota**, so adding keys does not necessarily add capacity. Stateful Responses continuations using `previous_response_id` can depend on the originating project and are **not portable across projects**; failover to a different project's key can reject the continuation. The app does not migrate state between projects.


## Prepare project-local prerequisites

From the repository root, run:

```bash
make setup
```

Setup requires an existing working `node` and `npm` on `PATH` to bootstrap the isolated tools, plus network access. It installs pinned **Node.js 24.21.0** and **npm 11.21.0** under ignored `.local-runtime/`, runs `npm ci` with the lockfile, and builds chat with `npm run build:chat`. Matching pinned tools are reused on subsequent runs. Your global Node/npm versions and shell profiles are not changed.

Setup also checks ngrok's version and required CLI flags (`--url`, `--inspect`, `--config`, and `--log` in `ngrok http --help`). If ngrok is absent, setup runs the official macOS command `brew install ngrok` through an **existing Homebrew installation**; it does not install Homebrew. Without that prerequisite, install ngrok yourself and rerun setup. Existing ngrok is checked rather than replaced. Ngrok credentials and an assigned domain remain manual prerequisites for tunnel installation.

**Setup is not `make install`:** it does not read or write chat credentials/configuration, generate keys, register/start/stop services, open a tunnel, or call the inference provider. Prepare private configuration and keys separately below before any authorized lifecycle rollout.

After setup, every `make` command prepends this checkout's `.local-runtime/node_modules/.bin` to its child processes' `PATH`, including npm lifecycle scripts. Direct `node` and `npm` commands still select your global runtime unless you explicitly prefix `PATH`; for example:

```bash
PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" node --version
PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" npm --version
```

Use that prefix for direct npm examples below. It affects only that command and does not alter your shell profile.

## Configuration and private files

The chat runtime requires Node.js **>=24**; `make setup` prepares the project-local version and installs dependencies using the repository lockfile. The executable authorities, not the examples here, define exact names, defaults, validation, and commands:

- [Server configuration](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/apps/chat-api/src/config.ts), [routes](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/apps/chat-api/src/app.ts), and [pinned HTTPS transport](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/apps/chat-api/src/proxy.ts).
- [Root npm scripts](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/package.json), [macOS runtime](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/scripts/chat-runtime.mjs), and [SDK smoke client](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/scripts/smoke-chat.mjs).

By default, both `npm run start:chat` and the macOS lifecycle load this checkout's `apps/chat-api/.env`. The path is derived from the source/compiled module or repository location, **never the current working directory**. `CHAT_CONFIG_FILE` remains an explicit absolute-path override to a private config outside the checkout. The dotenv file is parsed with Node's `parseEnv`, **never sourced/evaluated as shell**: use literal absolute paths, not `$HOME`, `~`, command substitution, or shell expansion inside it. Foreground app environment values override file values, but lifecycle `CHAT_NGROK_CONFIG_FILE` is read only from the selected file. Installed LaunchAgents load their configured file, not your interactive shell environment. Unknown `CHAT_` variables, non-Chat names in that file, or recursive `CHAT_CONFIG_FILE` entries fail startup. Smoke-client-only variables do not belong in the server config/environment.

The **exact repository `apps/chat-api/.env` is the only checkout exception**: it must be an owner-owned regular file at **exact `0600`**. Its immediate parent must be owner-owned and not group/world writable; ordinary **`0755` is allowed**. Both the leaf and immediate parent must not be symlinks. Every other private file—including the primary `CHAT_API_KEY_FILE`, generated client keys, ngrok config, and an explicit external config override—must resolve outside the checkout, with an owner-owned regular file at **exact `0600`** and owner-owned containing directory at **exact `0700`**. The optional generated-key directory `${CHAT_API_KEY_FILE}.d` also requires owner ownership and exact `0700`. Leaf/immediate-parent symlinks are rejected; this is not a blanket ban on every ancestor symlink. The config is capped at 64 KiB. Each key is 32–4096 printable non-whitespace ASCII characters (a client key file may end with one newline); placeholders are rejected. Every client key must differ from the provider credential; never reuse MCP or ngrok credentials. Missing/invalid settings, unsafe key files/directories, or invalid generated-key entries fail before listening.

| Setting | Meaning / default |
| --- | --- |
| `CHAT_API_KEY_FILE` | Required absolute private primary chat-client key file; optional sibling `${CHAT_API_KEY_FILE}.d` contains additive `*.key` files |
| `CHAT_UPSTREAM_API_KEY` | Required inline provider key, or ordered nonempty unique comma-separated keys without spaces; no provider-key file |
| `CHAT_UPSTREAM_BASE_URL` | Required public HTTPS base ending in `/v1`; a prefix before `/v1` is preserved |
| `CHAT_ALLOWED_MODELS` | Required nonempty comma-separated unique exact model IDs; no whitespace inside an ID |
| `CHAT_API_PORT` | Loopback port, `3211`; listener is always `127.0.0.1` |
| `CHAT_PUBLIC_HOST` | Optional exact lowercase public hostname for foreground local-only use; required by tunnel lifecycle, without scheme/path/port |
| `CHAT_NGROK_CONFIG_FILE` | Required for lifecycle install/start/status: literal absolute path in the selected Chat `.env` to the separate private ngrok config; no default/shared-config fallback or ambient shell override |
| `CHAT_MAX_REQUEST_BYTES` | `4194304` (4 MiB), maximum `67108864` |
| `CHAT_MAX_RESPONSE_BYTES` | `16777216` (16 MiB), maximum `268435456`, including SSE |
| `CHAT_MAX_CONCURRENT_REQUESTS` | `4`, maximum `128` |
| `CHAT_REQUESTS_PER_MINUTE` | `60`, maximum `60000`, per-instance fixed window |
| `CHAT_REQUEST_DEADLINE_MS` | `300000`, maximum `3600000`, total request through downstream completion |

Numeric settings are positive integers (port maximum `65535`). Discovery shares admission/deadline/response bounds. Admission is in memory, rejects rather than queues, and resets on restart; even authenticated requests subsequently rejected by body validation consume an admission count. These are **not spend caps**: set provider account/key quotas, budgets, alerts, and model/token policies before sharing a key. Cancellation can still incur charges.

Copy the maintained [chat-only `.env.example`](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/apps/chat-api/.env.example) to ignored `apps/chat-api/.env` using a private editor/credential workflow, preserving any existing configuration rather than overwriting it. Set its exact mode to `0600` before putting the provider key inline. Do not use the root MCP template or combine its variables with this file. Replace every operator placeholder; the template is intentionally not a valid runnable provider configuration. Minimal example:

```dotenv
CHAT_API_PORT=3211
CHAT_API_KEY_FILE=/absolute/private/chat.key
CHAT_UPSTREAM_API_KEY=<provider-api-key>
CHAT_UPSTREAM_BASE_URL=https://<public-provider-host>/v1
CHAT_ALLOWED_MODELS=<exact-native-model-id>
CHAT_PUBLIC_HOST=<assigned-ngrok-host>
CHAT_NGROK_CONFIG_FILE=/absolute/private/ngrok-translate.yml
```

`CHAT_API_KEY_FILE` is **not** an OpenAI/provider credential. It names the external primary client-key file. At startup the server accepts that primary key plus keys in the optional sibling `${CHAT_API_KEY_FILE}.d` directory. Every accepted key has the same full inference access and shares the same per-instance admission limits and provider quota: these are not per-user accounts, separate budgets, or admin credentials. **Every primary/generated client key, including newly generated keys, must differ from every configured provider key.** The server validates incoming Bearer auth against these client keys, then independently selects a key from inline `CHAT_UPSTREAM_API_KEY` for outgoing provider Authorization. The removed `CHAT_UPSTREAM_API_KEY_FILE` setting is rejected; there is no backwards alias and no `provider.key` to create.

### Create a client key without replacing existing keys

After `make setup`, prepare the required private `apps/chat-api/.env`, including a literal absolute `CHAT_API_KEY_FILE` outside the checkout. Preserve an existing config and its primary key path. Then, from the repository root:

```bash
make gen
# Equivalent with key-only stdout:
# PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" npm --silent run chat:gen
```

`make gen` / `npm run chat:gen` builds the chat workspace, then creates a cryptographically random key with `crypto.randomBytes(32).toString('hex')` (64 hex characters); a separate `build:chat` step is not required for generation. If the primary file is absent, the first run creates it exclusively. If it already exists, its bytes remain unchanged and each subsequent run exclusively creates a new `${CHAT_API_KEY_FILE}.d/<random-UUID>.key`. Existing primary and generated keys keep working; generation is additive, not rotation. The sibling directory supports up to 1024 generated keys. There is no extra environment setting or database for it.

The generator creates missing private directories at `0700` and key files at `0600`; it rejects unsafe existing paths rather than overwriting keys or weakening permissions. Existing private directories must already have exact `0700`; for an owner-owned, non-symlink directory, correct its mode with a private filesystem workflow before retrying. `make gen` and `npm --silent run chat:gen` print **only the freshly generated 64-hex key followed by a newline** on stdout; build diagnostics go to stderr. Existing client keys and the provider key are not printed. Plain `npm run chat:gen` additionally prints npm script banners. The key file remains persisted internally for server authentication. Generation does not install, start, stop, or restart services, open tunnels, or make provider requests. For an external config, use the same absolute `CHAT_CONFIG_FILE` override as your server/lifecycle commands.

Copy the printed key directly into `Authorization: Bearer <chat-key>`, **never the file path or provider credential**. Securely distribute it to the intended authorized client using your encrypted credential-sharing workflow; a recipient stores it in its own private file/credential store. **Terminal output is now sensitive: avoid CI runs and shared or captured logs when generating keys.** Keep actual secrets out of the example template, argv, URLs, shell history, plist, commits, and logs. The app-local `.env` is ignored by Git, but that is not encryption or protection from local-user processes: never force-add it. An external `CHAT_CONFIG_FILE` config contains the same inline provider value and follows the stricter `0600`/`0700` rules.

**Adding, removing, or changing any client or provider key takes effect only after the server restarts.** For an already-installed macOS runtime, use `make stop` then `make start` (or `npm run chat:stop` then `npm run chat:start`), retaining the same config-path override. `make start` alone does not restart a running app. For foreground operation, stop the process and run `npm run start:chat` again. Neither key generation nor file edits trigger automatic reload or service manipulation; restarts abort active calls rather than replaying them.

## Foreground first

From the checkout after `make setup` has installed dependencies and built chat, and after preparing `apps/chat-api/.env` and the external client-key file:

```bash
PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" npm run start:chat
```

`build:chat` only builds the chat workspace; `start:chat` starts its compiled entry point, not MCP/runner, and loads the app-local `.env` by default. To keep an external config instead, use `PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" CHAT_CONFIG_FILE="$HOME/Library/Application Support/cloudharness-chat/chat.env" npm run start:chat` (the shell expands `$HOME`; paths inside the dotenv file do not expand). Check local status separately:

```bash
curl --fail http://127.0.0.1:3211/healthz
curl --fail http://127.0.0.1:3211/readyz
```

All inference and discovery requests, including loopback, need exactly one `Authorization: Bearer <chat-key>` header. **Use the contents of the primary or a generated client-key file, not its path and never the provider key**, including for remote requests through ngrok. Query/cookie keys and spoofed Access/forwarding headers do not authenticate. POSTs require `application/json` (optional UTF-8 charset), with no content encoding. Chat needs an object with allowlisted `model`, `messages` array, and optional boolean `stream`; Responses keeps native `input`/continuation semantics (`input`, when present, is string/array/null; `previous_response_id`, when present, is string/null).

For curl, keep the Bearer header in a separate private client config (outside the repo, `0600` in a `0700` directory), so the key is not exposed in process arguments/history. Example `client.curl` template: `header = "Authorization: Bearer <chat-key>"`. Do not copy a real key into this guide. Then, replacing the model ID in the JSON with your chosen exact ID:

```bash
curl --config "$HOME/Library/Application Support/cloudharness-chat/client.curl" \
  --silent --show-error --fail-with-body http://127.0.0.1:3211/v1/models
curl --config "$HOME/Library/Application Support/cloudharness-chat/client.curl" \
  --silent --show-error --fail-with-body http://127.0.0.1:3211/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"<exact-native-model-id>","messages":[{"role":"user","content":"Hello"}],"stream":false}'
curl --config "$HOME/Library/Application Support/cloudharness-chat/client.curl" \
  --silent --show-error --fail-with-body http://127.0.0.1:3211/v1/responses \
  -H 'Content-Type: application/json' \
  --data '{"model":"<exact-native-model-id>","input":"Hello","store":false,"stream":false}'
```

For SSE, change `stream` to `true` and add `--no-buffer`; Chat uses `[DONE]`, while Responses uses native terminal events. For remote calls, replace the origin with the assigned HTTPS ngrok origin, retaining `/v1` once. Avoid prompts/secrets in saved output or shell history; use a JSON serializer for arbitrary model IDs and content.

## SDK client and smoke

Clients set `baseURL` to `http://127.0.0.1:3211/v1` locally or `https://<assigned-ngrok-host>/v1` remotely, use the **chat** key, and send an exact allowed model ID. The official `openai` SDK is pinned to **7.27.0** in this repository for acceptance, with **`maxRetries: 0`** to expose errors and avoid duplicate charges. A client can use it directly; no MCP adapter/custom parser is required:

```js
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.CHAT_BASE_URL,
  apiKey: (await readFile(process.env.CHAT_API_KEY_FILE, 'utf8')).trim(),
  maxRetries: 0,
});
const model = process.env.CHAT_MODEL;
await client.models.list();
await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Hello' }] });
await client.responses.create({ model, input: 'Hello', store: false });
```

After explicit authorization to spend provider quota, run the maintained smoke client with the key in a private file, not argv:

```bash
PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" \
CHAT_BASE_URL=http://127.0.0.1:3211/v1 \
CHAT_API_KEY_FILE="$HOME/Library/Application Support/cloudharness-chat/chat.key" \
CHAT_MODEL='<exact-native-model-id>' npm run chat:smoke
```

It checks authenticated `models.list()`, wrong-key `401`/SDK error parsing, and both APIs in JSON/SSE with usage and native completion semantics. It prints sanitized check/status metadata, not prompts, output, keys, or provider error bodies. `CHAT_SMOKE_TIMEOUT_MS` defaults to `330000`, maximum `600000`. Optional `CHAT_SMOKE_ADMISSION_REQUESTS=2..32` makes an additional **billed** bounded burst to assert `429`; first configure the server admission cap below the burst. Accepted/aborted requests may still bill. Do not set this option for a routine smoke unless that extra test is authorized.

Repeat the smoke from a **different machine**, with its private chat key file and `CHAT_BASE_URL=https://<assigned-ngrok-host>/v1`, after a local live-provider pass. Verify missing-key rejection and out-of-scope routes separately, and inspect real status/content type/native terminal signals, not HTML tunnel warning pages. A local fixture/process smoke, build, or healthy tunnel is not live-provider/public proof. Optional tool/structured-output/stateful capabilities need their own provider-specific evidence; none is claimed here.

## macOS lifecycle and ngrok

The root `Makefile` wraps npm key-generation/lifecycle commands; `package.json` is command authority and `scripts/chat-runtime.mjs` owns lifecycle semantics. Default config path is this checkout's `apps/chat-api/.env`, the same module/repo-derived path used by foreground startup. Set the same absolute external `CHAT_CONFIG_FILE` for generation and every lifecycle command when overriding it: **installed instance identity is derived from the config path**.

**Migration caution:** the former default was `~/Library/Application Support/cloudharness-chat/chat.env`. Changing the default does not migrate or stop jobs installed under that path. Before switching, use that old absolute path explicitly with `chat:stop`/`chat:uninstall`, then install the desired app-local default. Alternatively, keep the explicit external override consistently and update its provider setting to inline `CHAT_UPSTREAM_API_KEY`. Reinstall registration when changing config paths; do not leave an old instance listening while installing another identity.

| Make target | Equivalent npm script | Scope |
| --- | --- | --- |
| `make setup` | `npm run chat:setup` | Prepare project-local Node/npm, install lockfile dependencies, build chat, check/install ngrok; no services or credentials |
| `make gen` | `npm run chat:gen` | Build chat and create one private client key without replacing existing keys; no service manipulation |
| `make install` | `npm run chat:install` | Preflight, build chat, register two user LaunchAgents, start app then tunnel |
| `make start` | `npm run chat:start` | Start registered app, await owned readiness, start tunnel |
| `make status` | `npm run chat:status` | Check owned app/PID/listener and tunnel process; not public connectivity/model proof |
| `make log` / `make logs` | `npm run chat:logs` | Follow recent sanitized lifecycle and request/response metadata live; Ctrl-C exits the viewer only |
| `make stop` | `npm run chat:stop` | Stop this instance's tunnel then app |
| `make uninstall` | `npm run chat:uninstall` | Stop jobs/remove registrations; retain private config, keys, logs, and MCP data |

### Live request and response logs

Run `make log` to display the last 50 lines of each current scoped log and keep following new events, including after rotation. `make logs` is equivalent. To print recent records and exit, use `make log LOG_ARGS=--no-follow` or `npm run chat:logs -- --no-follow`. Keep the same `CHAT_CONFIG_FILE` override as your installed instance. Viewing logs never starts or restarts services; Ctrl-C stops only the viewer.

API requests get an arrival record with a generated correlation ID, method and fixed route label. The matching response record contains HTTP status, elapsed milliseconds and `finished` or `aborted`; an abort before headers has status `0`. Successful `GET /healthz` and `GET /readyz` checks are silent; failed or aborted checks emit both records on completion. The tunnel's readiness monitoring still runs; only successful probe logging is suppressed. An SSE response is recorded when it finishes or disconnects, not once per token. No prompt, completion, body, header, query string, model ID or credential is recorded. Unknown routes/methods use fixed labels rather than echoing input. Logs are bounded diagnostics, not an audit ledger: saturated queues or disk failures may drop records.

For an already-installed older runtime, run `PATH="$PWD/.local-runtime/node_modules/.bin:$PATH" npm run build:chat`, then `make stop` and `make start` with its existing config-path override before `make log`. This interrupts active calls and restarts its tunnel; choose an appropriate maintenance window. `make start` alone does not replace a running process. Foreground `npm run start:chat` prints the same safe metadata directly to its terminal after rebuild/restart.

The macOS **service lifecycle** commands require a logged-in user session, supported Node/npm, and ngrok in `PATH`; `make setup` prepares these tools as described above. Key generation needs Node/npm and the private config, not ngrok or installed services. Lifecycle commands themselves install no package manager/runtime, do not modify Docker/Colima/MCP, and do not rebuild on login. Install captures absolute executable/checkout paths, including the project-local Node executable when invoked through `make install` after setup: **do not remove `.local-runtime/` while its LaunchAgents are installed**. Reinstall registration after moving the checkout or changing selected executables. Repeated install does not rotate keys or create a second job for the same config path. Do not put credentials in a plist.

### Dedicated ngrok configuration

Set `CHAT_NGROK_CONFIG_FILE` in the selected private Chat `.env` to a **literal absolute path** to the dedicated ngrok config, for example `CHAT_NGROK_CONFIG_FILE=/absolute/private/ngrok-translate.yml`. Chat lifecycle reads only that file's setting, not an ambient shell override, and always passes explicit `--config`; there is **no default or shared-config fallback**. Direct loopback app startup and key generation do not require this setting. Lifecycle install/start/status do; stop/uninstall/logs remain available for the verified instance without reading it. The same ngrok executable can serve another application, but Chat needs a **separate configuration and its own authtoken**. Do not copy another application's secrets, modify its config, or stop its agent.

If the dedicated file is already configured, leave its existing authtoken untouched: **no `add-authtoken` command is needed**. Enforce owner-owned exact file `0600` and immediate directory `0700`; neither may be a symlink. Replace these placeholder paths with the dedicated file and its immediate directory before applying permission-only commands:

```sh
chmod 0700 /absolute/private
chmod 0600 /absolute/private/ngrok-translate.yml
```

These are operator instructions, not operations performed by setup, and do not alter the other application's `ngrok.yml` or its token. If creating a **new** dedicated config instead, create its private directory/file first under `umask 077`, enforce `chmod 0700`/`chmod 0600`, and select its absolute path in `CHAT_NGROK_CONFIG_FILE`. Use a **private editor** for the following [ngrok v3 configuration](https://ngrok.com/docs/gateway/agent/config/v3), replacing only the placeholder with a separately issued authtoken. Do not overwrite an existing configured token, paste real tokens into commands, this guide, tool output, shared logs, or the repository. Disable the local inspection web interface to avoid colliding with another agent's default port 4040:

```yaml
version: 3
agent:
  authtoken: <dedicated-ngrok-translate-authtoken>
  web_addr: false
```

**Never run bare `ngrok config add-authtoken`**: it can overwrite the default config used by another application. Only if a dedicated file still needs a token and you choose the CLI rather than the recommended private editor, the explicitly scoped form is `ngrok config add-authtoken <dedicated-ngrok-translate-authtoken> --config /absolute/private/ngrok-translate.yml`; replace the path with the exact selected config path. That placeholder is not a real token. Substituting a real token exposes it in process arguments and potentially shell history, so avoid that method in shared/recorded environments and retain the private permissions above.

Choose an account-assigned **different domain** from any other application's active tunnel and set `CHAT_PUBLIC_HOST` to that exact hostname. Separate configs/tokens do **not** bypass ngrok agent/session, endpoint, or account limits; arrange sufficient account capacity or a separately authorized account instead of disrupting another agent.

Install preflights `ngrok http --help` flags and `ngrok config check` with the dedicated `--config` path; it does not create credentials. Both install and start keep the scoped LaunchAgent labels/state and pass this explicit `--config` to ngrok. The tunnel forwards only `http://127.0.0.1:<CHAT_API_PORT>` with `--url https://<CHAT_PUBLIC_HOST>` and **`--inspect=false`**. It starts only after the expected chat PID/parent/exact listener is ready, and stops/restarts on lost ownership/readiness rather than forwarding to an unrelated process. Ngrok logging is disabled (`--log=false`) and raw child output is suppressed; separate runtime/app/tunnel lifecycle logs each rotate at 256 KiB with three retained copies.

**Existing registration migration:** install pins the selected ngrok config path in the instance manifest. A prior manifest selecting a shared config, or any change to `CHAT_NGROK_CONFIG_FILE`, requires reinstall before start; start will not silently use the old path. Stop/uninstall only that verified Chat instance's jobs, retaining its exact `CHAT_CONFIG_FILE` override if applicable, then `make install` the intended instance after selecting and securing its dedicated ngrok config. Changing configuration does not migrate old registrations. Stop/uninstall can clean up verified old jobs but must not target another application's ngrok process or configuration.

LaunchAgents run foreground supervisors after login, not system boot; availability before login/after logout is not promised. Restart loops are bounded (five starts per ten minutes, 30-second delay). Sleep, logout, lost network, provider outages, and tunnel disruption can end streams. Nothing replays inference after restart/reconnect. This is not HA: the host, ngrok, and provider must all remain available.

## Security, retention, and rotation

Authentication compares fixed-length SHA-256 key digests with a constant-time primitive. Host is restricted to loopback or the exact public hostname, but Host/Origin/forwarded headers are **not identity**. No permissive CORS is enabled; there is no browser client scope. Loopback still requires a key and is not a sandbox against compromised local-user processes.

Outbound URLs are fixed by operator config: HTTPS, no userinfo/query/fragment, no redirects. The egress policy rejects private, loopback, link-local/metadata and other non-public addresses. Each outbound request validates all DNS answers and pins the socket to approved public addresses, preserving TLS verification; clients cannot supply a URL or credential. Outbound headers are rebuilt using the provider key, not inbound Authorization/Cookie/Host/forwarding headers.

The app has **no local conversation/response store**, database, or body logging. Successful payloads are forwarded, not treated as safe log content. `store`, `previous_response_id`, retention, continuation validity, and any provider retrieval/deletion capability remain **upstream-owned**. `store: false` is passed through, not a guarantee of zero provider retention or training use. This app exposes no response CRUD; consult and configure provider privacy/retention separately. Ngrok terminates public TLS and sees prompts and Authorization; disabled local inspection does not prove account-level traffic capture/retention is off. Review ngrok policies and provider terms before sending sensitive data.

Treat every primary/generated chat key as full inference/spend authority for trusted machines only. All holders share one instance's admission limits and upstream quota; there are no per-user budgets, roles, or administration rights. To revoke **one generated key**, stop the tunnel/app (`make stop`), remove only its specific `${CHAT_API_KEY_FILE}.d/<UUID>.key` file in your private filesystem workflow, then `make start`. Leave the primary and other generated files unchanged; their keys remain accepted after restart. Removing a file while the app is running does not revoke its in-memory key, and `make start` alone does not reload it. A shared generated key's removal revokes every holder of that key, not just one recipient.

For primary-key rotation, stop tunnel/app, securely replace only the primary file while preserving permissions and distinctness, then start again; additive generated keys remain valid unless explicitly removed. After an operator-authorized restart, verify a revoked key gets `401` and retained/new keys work. Foreground operation requires stopping/restarting its process instead (Ctrl-C sends a shutdown signal; active calls are aborted, not drained or replayed). Keys/config are loaded at process start, not hot-reloaded. Rotate the provider credential independently at the provider, update inline `CHAT_UPSTREAM_API_KEY` in the private dotenv config, and restart; rotate/revoke the ngrok authtoken at ngrok independently. For compromise, stop the tunnel immediately, revoke all affected client files and rotate/revoke affected provider/ngrok credentials at their owners, and review provider spending and ngrok capture settings. Stop/uninstall is chat-only, retains private keys, and is not a rollback/migration of MCP.
