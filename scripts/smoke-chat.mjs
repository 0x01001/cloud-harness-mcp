#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';

// This script makes billed inference calls only when explicitly invoked by an operator.
// Never log requests, completions, credentials, or upstream error messages.
const positiveInteger = (name, fallback, maximum) => {
  const value = process.env[name] ?? String(fallback);
  assert(/^[1-9]\d*$/.test(value), `${name} must be a positive integer`);
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number <= maximum, `${name} exceeds its bound`);
  return number;
};
const evidence = (check, metadata) => console.log(JSON.stringify({ check, ...metadata }));
const requireUsage = (usage, input, output) => {
  assert(usage && Number.isInteger(usage[input]) && Number.isInteger(usage[output]));
  assert(Number.isInteger(usage.total_tokens));
  assert(usage[input] >= 0 && usage[output] >= 0 && usage.total_tokens >= 0);
};
const responseShape = response => {
  assert.equal(response.object, 'response');
  assert.equal(typeof response.id, 'string');
  assert.equal(typeof response.created_at, 'number');
  assert.equal(response.status, 'completed');
  assert(Array.isArray(response.output) && response.output.length > 0);
  assert(response.output.some(item => item.type === 'message' && item.content.some(content => content.type === 'output_text' && typeof content.text === 'string')));
  requireUsage(response.usage, 'input_tokens', 'output_tokens');
};

async function main() {
  const url = new URL(process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:3211/v1');
  assert(url.pathname === '/v1' && !url.search && !url.hash && !url.username && !url.password);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  const keyFile = process.env.CHAT_API_KEY_FILE;
  assert(keyFile, 'CHAT_API_KEY_FILE is required');
  const info = await stat(keyFile);
  assert(info.isFile() && (info.mode & 0o077) === 0, 'Chat key file must be private');
  const key = (await readFile(keyFile, 'utf8')).trim();
  assert(key && !/\s/.test(key));
  const model = process.env.CHAT_MODEL;
  assert(model, 'CHAT_MODEL is required');
  const timeout = positiveInteger('CHAT_SMOKE_TIMEOUT_MS', 330000, 600000);
  const client = new OpenAI({ baseURL: url.href.replace(/\/$/, ''), apiKey: key, maxRetries: 0, timeout });
  const prompt = 'Reply with exactly hello.';

  const models = await client.models.list().withResponse();
  assert.equal(models.response.status, 200);
  assert.equal(models.data.object, 'list');
  assert(models.data.data.some(item => item.id === model && item.object === 'model' && Number.isInteger(item.created) && typeof item.owned_by === 'string'));
  evidence('models', { status: models.response.status, count: models.data.data.length });

  const wrongClient = new OpenAI({ baseURL: url.href.replace(/\/$/, ''), apiKey: randomBytes(32).toString('hex'), maxRetries: 0, timeout });
  await assert.rejects(wrongClient.models.list(), error => error instanceof OpenAI.APIError && error.status === 401 && typeof error.error?.message === 'string');
  evidence('wrong-key', { status: 401 });

  const chat = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: 64 }).withResponse();
  assert.equal(chat.response.status, 200);
  assert.equal(chat.data.object, 'chat.completion');
  assert.equal(typeof chat.data.id, 'string');
  assert.equal(chat.data.model, model);
  assert.equal(typeof chat.data.created, 'number');
  assert(chat.data.choices.length > 0 && chat.data.choices.every(choice => choice.message.role === 'assistant' && choice.finish_reason !== null));
  requireUsage(chat.data.usage, 'prompt_tokens', 'completion_tokens');
  evidence('chat-json', { status: chat.response.status, finish: chat.data.choices[0].finish_reason, usage: true });

  const chatStream = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: 64, stream: true, stream_options: { include_usage: true } }).withResponse();
  assert.match(chatStream.response.headers.get('content-type') ?? '', /^text\/event-stream\b/i);
  const chatWire = chatStream.response.clone().text();
  let chatChunks = 0;
  let finish = false;
  let usage = false;
  for await (const chunk of chatStream.data) {
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.model, model);
    assert(Array.isArray(chunk.choices));
    chatChunks++;
    finish ||= chunk.choices.some(choice => choice.finish_reason !== null);
    if (chunk.usage) {
      requireUsage(chunk.usage, 'prompt_tokens', 'completion_tokens');
      usage = true;
    }
  }
  assert(chatChunks > 0 && finish && usage);
  assert.match(await chatWire, /(?:^|\n)data:\s*\[DONE\]\r?\n/);
  evidence('chat-sse', { status: chatStream.response.status, chunks: chatChunks, finish, usage });

  const response = await client.responses.create({ model, input: prompt, max_output_tokens: 64, store: false }).withResponse();
  assert.equal(response.response.status, 200);
  assert.equal(response.data.model, model);
  responseShape(response.data);
  evidence('responses-json', { status: response.response.status, terminal: response.data.status, usage: true });

  const responseStream = await client.responses.create({ model, input: prompt, max_output_tokens: 64, store: false, stream: true }).withResponse();
  assert.match(responseStream.response.headers.get('content-type') ?? '', /^text\/event-stream\b/i);
  const responseWire = responseStream.response.clone().text();
  const doneItems = [];
  let completed;
  let events = 0;
  for await (const event of responseStream.data) {
    assert.equal(typeof event.type, 'string');
    events++;
    if (event.type === 'response.output_item.done') doneItems[event.output_index] = event.item;
    if (event.type === 'response.completed') {
      assert(!completed);
      completed = event.response;
    }
    assert(!['response.failed', 'response.incomplete', 'error'].includes(event.type));
  }
  assert(completed && events > 0);
  responseShape(completed);
  assert.deepEqual(completed.output, doneItems);
  const terminalWire = await responseWire;
  assert.match(terminalWire, /response\.completed/);
  assert(!terminalWire.includes('[DONE]'));
  evidence('responses-sse', { status: responseStream.response.status, events, terminal: completed.status, usage: true });

  // Opt-in only: these requests can incur charges. Configure the server's admission
  // cap below this bounded burst; every accepted call is aborted once 429 is seen.
  if (process.env.CHAT_SMOKE_ADMISSION_REQUESTS !== undefined) {
    const count = positiveInteger('CHAT_SMOKE_ADMISSION_REQUESTS', 0, 32);
    assert(count >= 2, 'Admission burst needs at least two requests');
    const controllers = Array.from({ length: count }, () => new globalThis.AbortController());
    let rejected = 0;
    const statuses = await Promise.all(controllers.map(async (controller, index) => {
      try {
        const stream = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], stream: true, max_completion_tokens: 64 }, { signal: controller.signal });
        stream.controller.abort();
        return 200;
      } catch (error) {
        if (error instanceof OpenAI.APIError && error.status === 429) {
          assert(typeof error.error?.message === 'string');
          rejected++;
          controllers.forEach((other, otherIndex) => { if (otherIndex !== index) other.abort(); });
          return 429;
        }
        if (controller.signal.aborted) return 'aborted';
        throw error;
      }
    }));
    assert(rejected > 0, 'Configure admission below the burst before running');
    evidence('admission', { requests: count, rejected, accepted: statuses.filter(status => status === 200).length });
  } else {
    evidence('admission', { skipped: true, reason: 'explicit bounded charge opt-in required' });
  }
}

main().catch(error => {
  // Error.message and assertion operands can contain upstream bodies or secrets.
  console.error(JSON.stringify({ check: 'smoke', failed: true, kind: error instanceof OpenAI.APIError ? 'api_error' : 'validation_error', ...(Number.isInteger(error.status) ? { status: error.status } : {}) }));
  process.exitCode = 1;
});
