import { afterEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import { CHAT_KEY, MODEL, chatBody, chatResult, responseResult, outputItems, fixture, json, deferred } from './fixture.js';
import type { FixtureHandler, FixtureOptions } from './fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
async function setup(handler: FixtureHandler, options?: FixtureOptions) {
  const app = await fixture(handler, options);
  cleanups.push(app.close);
  return app;
}
export const chatEvents = [
  { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } }, { index: 1, id: 'call_2', type: 'function', function: { name: 'other', arguments: '' } }] }, finish_reason: null }] },
  { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [{ index: 0, delta: { content: 'héllo', tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }, { index: 0, function: { arguments: '{"a":1}' } }] }, finish_reason: null }] },
  { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { id: 'chat_fixture', object: 'chat.completion.chunk', created: 10, model: MODEL, choices: [], usage: chatResult.usage },
];
export const chatWire = chatEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
export const responseEvents = [
  { type: 'response.created', sequence_number: 0, response: { ...responseResult, status: 'in_progress', output: [], usage: null } },
  { type: 'response.output_item.added', sequence_number: 1, output_index: 1, item: { ...outputItems[1], arguments: '' } },
  { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: 'function_1', output_index: 1, delta: '{"key":' },
  { type: 'response.function_call_arguments.delta', sequence_number: 3, item_id: 'function_1', output_index: 1, delta: '"value"}' },
  { type: 'response.output_text.delta', sequence_number: 4, item_id: 'message_1', output_index: 2, content_index: 0, delta: 'héllo' },
  ...outputItems.map((item, output_index) => ({ type: 'response.output_item.done', sequence_number: output_index + 5, output_index, item })),
  { type: 'response.completed', sequence_number: 8, response: responseResult },
];
export const responseWire = responseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

async function fragmentedWrite(res: ServerResponse, text: string) {
  const bytes = Buffer.from(text);
  for (let index = 0; index < bytes.length; index++) {
    res.write(bytes.subarray(index, index + 1));
    if (index % 37 === 0) await delay(1);
  }
  res.end();
}

describe('native JSON and discovery contracts', () => {
  it('filters catalog, preserves slash IDs and rejects broken/duplicate catalog without fake metadata', async () => {
    const catalog = { object: 'list', data: [
      { id: MODEL, object: 'model', created: 10, owned_by: 'provider', secret_extension: 'not-public' },
      { id: 'forbidden', object: 'model', created: 20, owned_by: 'provider' },
    ] };
    const app = await setup((_req, res) => json(res, catalog));
    const result = await app.send('/v1/models');
    expect(await result.json()).toEqual({ object: 'list', data: [{ id: MODEL, object: 'model', created: 10, owned_by: 'provider' }] });
    expect(app.captured[0]!.path).toBe('/prefix/v1/models');
    for (const broken of [{ data: [] }, { object: 'list', data: [{ id: MODEL }] }, { object: 'list', data: [catalog.data[0], catalog.data[0]] }]) {
      const invalid = await setup((_req, res) => json(res, broken));
      expect((await invalid.send('/v1/models')).status).toBe(502);
    }
  });

  it('keeps tool roundtrips, multimodal/structured fields and native reasoning/continuation unchanged', async () => {
    const app = await setup((req, res) => json(res, req.url?.endsWith('/responses') ? responseResult : chatResult));
    const chat = {
      ...chatBody,
      messages: [
        { role: 'developer', content: 'instruction' },
        { role: 'user', content: [{ type: 'text', text: 'text' }, { type: 'image_url', image_url: { url: 'https://public.example/image' } }] },
        chatResult.choices[0]!.message,
        { role: 'tool', tool_call_id: 'call_1', content: 'tool-result' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto', parallel_tool_calls: true,
      response_format: { type: 'json_schema', json_schema: { name: 'fixture', strict: true, schema: { type: 'object', properties: {} } } },
      max_tokens: 100, max_completion_tokens: 100, temperature: 0.2, top_p: 0.9, stop: ['end'], seed: 3, metadata: { opaque: 'value' }, unknown_native_field: { preserve: true },
    };
    expect(await (await app.send('/v1/chat/completions', chat)).json()).toEqual(chatResult);
    expect(JSON.parse(app.captured[0]!.body.toString())).toEqual(chat);
    expect(app.captured[0]!.path).toBe('/prefix/v1/chat/completions');
    const responses = {
      model: MODEL, instructions: 'native instruction', input: [...outputItems, { type: 'function_call_output', call_id: 'call_1', output: 'tool-result' }],
      previous_response_id: 'resp_previous', store: false, reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'],
      text: { format: { type: 'json_schema', name: 'fixture', strict: true, schema: { type: 'object', properties: {} } } },
      max_output_tokens: 100, metadata: { opaque: 'value' }, parallel_tool_calls: true,
    };
    expect(await (await app.send('/v1/responses', responses)).json()).toEqual(responseResult);
    expect(JSON.parse(app.captured[1]!.body.toString())).toEqual(responses);
    expect(app.captured[1]!.path).toBe('/prefix/v1/responses');
    expect((await app.send('/v1/responses', { model: MODEL, previous_response_id: 'resp_previous', store: false })).status).toBe(200);
    expect(JSON.parse(app.captured[2]!.body.toString())).toEqual({ model: MODEL, previous_response_id: 'resp_previous', store: false });
    const nullable = { model: MODEL, input: null, previous_response_id: null, instructions: 'native instruction', store: false };
    expect((await app.send('/v1/responses', nullable)).status).toBe(200);
    expect(JSON.parse(app.captured[3]!.body.toString())).toEqual(nullable);
  });
});

describe('transparent native SSE and official SDK interoperability', () => {
  it('preserves arbitrary byte splits, UTF8, event order and protocol-specific terminal data', async () => {
    const app = await setup(async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      await fragmentedWrite(res, req.url?.endsWith('/responses') ? responseWire : chatWire);
    });
    const chat = await app.send('/v1/chat/completions', { ...chatBody, stream: true, stream_options: { include_usage: true } });
    expect(chat.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(await chat.text()).toBe(chatWire);
    const response = await app.send('/v1/responses', { model: MODEL, input: 'fixture', stream: true });
    expect(await response.text()).toBe(responseWire);
  });

  it('recognizes CR-only native terminal delimiters split across bytes at clean HTTP EOF', async () => {
    const chatCR = chatWire.replaceAll('\n', '\r');
    const responsesCR = responseWire.replaceAll('\n', '\r');
    const app = await setup(async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // One-byte writes leave the terminal frame's final CR at the EOF boundary.
      await fragmentedWrite(res, req.url?.endsWith('/responses') ? responsesCR : chatCR);
    });
    expect(chatCR.endsWith('data: [DONE]\r\r')).toBe(true);
    const rawChat = await app.send('/v1/chat/completions', { ...chatBody, stream: true });
    expect(await rawChat.text()).toBe(chatCR);
    const rawResponse = await app.send('/v1/responses', { model: MODEL, input: 'fixture', stream: true });
    expect(await rawResponse.text()).toBe(responsesCR);
    const client = new OpenAI({ baseURL: app.base + '/v1', apiKey: CHAT_KEY, maxRetries: 0 });
    const chunks = [];
    for await (const chunk of await client.chat.completions.create({ ...chatBody, stream: true })) chunks.push(chunk);
    expect(chunks).toEqual(chatEvents);
    const events = [];
    for await (const event of await client.responses.create({ model: MODEL, input: 'fixture', stream: true })) events.push(event);
    expect(events).toEqual(responseEvents);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: outputItems, usage: responseResult.usage } });
    expect(app.calls).toBe(4);
  });

  it('delivers first chunk before upstream finishes, not a buffered fake stream', async () => {
    const release = deferred();
    const app = await setup(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      await release.promise;
      res.end('data: [DONE]\n\n');
    });
    try {
      const response = await app.send('/v1/chat/completions', { ...chatBody, stream: true });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
      expect(first.done).toBe(false);
      release.resolve();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: [DONE]\n\n');
      expect((await reader.read()).done).toBe(true);
    } finally { release.resolve(); }
  });

  it('official SDK lists models, reads both JSON/SSE shapes, terminal output and usage, and sees401/429', async () => {
    const app = await setup(async (req, res) => {
      if (req.url?.endsWith('/models')) { json(res, { object: 'list', data: [{ id: MODEL, object: 'model', created: 10, owned_by: 'provider' }] }); return; }
      const body = JSON.parse(app.captured.at(-1)!.body.toString());
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        await fragmentedWrite(res, req.url?.endsWith('/responses') ? responseWire : chatWire);
      } else json(res, req.url?.endsWith('/responses') ? responseResult : chatResult);
    }, { limits: { requestsPerMinute: 5 } });
    const client = new OpenAI({ baseURL: app.base + '/v1', apiKey: CHAT_KEY, maxRetries: 0 });
    expect((await client.models.list()).data[0]!.id).toBe(MODEL);
    expect(await client.chat.completions.create(chatBody)).toEqual(chatResult);
    const response = await client.responses.create({ model: MODEL, input: 'fixture' });
    expect(response.output).toEqual(outputItems);
    expect(response.output_text).toBe('héllo');
    const chunks = [];
    for await (const chunk of await client.chat.completions.create({ ...chatBody, stream: true, stream_options: { include_usage: true } })) chunks.push(chunk);
    expect(chunks).toEqual(chatEvents);
    const events = [];
    for await (const event of await client.responses.create({ model: MODEL, input: 'fixture', stream: true })) events.push(event);
    expect(events).toEqual(responseEvents);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: outputItems, usage: responseResult.usage } });
    const wrong = new OpenAI({ baseURL: app.base + '/v1', apiKey: 'wrong', maxRetries: 0 });
    await expect(wrong.models.list()).rejects.toMatchObject({ status: 401, error: { code: 'invalid_api_key' } });
    await expect(client.models.list()).rejects.toMatchObject({ status: 429, error: { code: 'rate_limit_exceeded' } });
    expect(app.calls).toBe(5);
  });
});
