import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_KEY, PROVIDER_KEY, MODEL, chatResult, responseResult, outputItems, fixture, json } from './fixture.js';

it('runs the actual official SDK smoke CLI against isolated HTTP fixtures without printing content or keys', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'chat-sdk-smoke-'));
  const keyFile = join(directory, 'key');
  await writeFile(keyFile, CHAT_KEY, { mode: 0o600 });
  const visible = 'private-fixture-completion-never-log';
  const chat = { ...chatResult, choices: [{ index: 0, message: { role: 'assistant', content: visible }, finish_reason: 'stop' }] };
  const output = [{ ...outputItems[2], content: [{ type: 'output_text', text: visible, annotations: [] }] }];
  const response = { ...responseResult, output };
  const app = await fixture((req, res) => {
    if (req.url?.endsWith('/models')) { json(res, { object: 'list', data: [{ id: MODEL, object: 'model', created: 10, owned_by: 'provider' }] }); return; }
    const request = JSON.parse(app.captured.at(-1)!.body.toString());
    const isResponses = req.url?.endsWith('/responses');
    if (!request.stream) { json(res, isResponses ? response : chat); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (isResponses) {
      for (const event of [
        { type: 'response.output_text.delta', sequence_number: 0, output_index: 0, content_index: 0, item_id: 'message_1', delta: visible },
        { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: output[0] },
        { type: 'response.completed', sequence_number: 2, response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else {
      for (const chunk of [
        { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: visible }, finish_reason: null }] },
        { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [], usage: chat.usage },
      ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  });
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/smoke-chat.mjs', import.meta.url))], {
      env: { ...process.env, CHAT_BASE_URL: app.base + '/v1', CHAT_API_KEY_FILE: keyFile, CHAT_MODEL: MODEL, CHAT_SMOKE_TIMEOUT_MS: '2000', CHAT_SMOKE_ADMISSION_REQUESTS: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exit = Promise.withResolvers<number | null>();
    child.once('error', exit.reject);
    child.once('close', exit.resolve);
    expect(await exit.promise, stderr).toBe(0);
    expect(stderr).toBe('');
    const evidence = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(evidence.map(entry => entry.check)).toEqual(['models', 'wrong-key', 'chat-json', 'chat-sse', 'responses-json', 'responses-sse', 'admission']);
    expect(evidence.at(-1)).toMatchObject({ skipped: true });
    expect(stdout).not.toContain(visible);
    expect(stdout).not.toContain(CHAT_KEY);
    expect(stdout).not.toContain(PROVIDER_KEY);
    expect(stdout).not.toContain('Reply with');
    expect(app.calls).toBe(5);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
