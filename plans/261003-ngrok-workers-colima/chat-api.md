# Tính năng độc lập: OpenAI-compatible Chat API

Ngày: 2026-10-03  
Trạng thái: Đã implement standalone chat API và runtime tooling; local process/fixture/SDK checks đã chạy. Chưa hoàn tất live-provider/ngrok/LaunchAgent rollout acceptance (xem evidence cuối file).
Runtime/public tunnel: [plan.md](plan.md).

## 1. Mục tiêu và ranh giới

Thêm `POST /v1/chat/completions` và `POST /v1/responses` để client trên máy khác gửi inference request bằng HTTP Bearer API key. Cả JSON response và SSE streaming phải hoạt động. Không dùng MCP initialize, `tools/call`, workspace hoặc agent lease trong giao thức client này.

Bổ sung theo yêu cầu tham khảo skill 9Router: `GET /v1/models` và interoperability với OpenAI SDK là acceptance bắt buộc. “Tương thích” nghĩa là client chỉ đổi `baseURL`, `apiKey` và model ID, không cần custom parser/MCP adapter.

App mới chạy song song với code cũ trong repository nhưng độc lập về process, port, credentials và runtime. Không phải rewrite/cutover của harness. MCP không cần chạy để chat hoạt động.

### Giữ nguyên

- `apps/api` và `/mcp`, `/mcp-gateway`, `/mcp-api-key`, dashboard/Access auth.
- `apps/runner`, workspace/executor, database và managed API keys.
- `apps/model-gateway` với lease, agent identity, budget, control socket và mạng nội bộ hiện có.
- Cloudflare Workers/Compose/deploy scripts và client URLs hiện hữu; không xóa, disable hoặc deploy chúng trong công việc này.

### Không thuộc phạm vi

Full 9Router parity, multi-provider failover, account/OAuth rotation, model alias/combo, billing, key-management UI, chat UI, MCP bridge và chạy tool trên máy chủ. Tool-call definitions/results trong payload chat được proxy như dữ liệu; app không thực thi chúng. Không tạo API retrieve/delete/cancel Responses hoặc WebSocket. `/v1/messages` là Anthropic format và `/v1/models/info` là extension trong skill 9Router, không thuộc OpenAI contract được yêu cầu; không thêm trong plan này.

## 2. Thiết kế tối thiểu

### Composition root riêng

Thêm npm workspace `apps/chat-api`, dùng TypeScript và tooling đã có. Root thêm `build:chat` và `start:chat`; command chỉ cần package chat và dependency thực sự sử dụng, không build/start runner hay agent để chạy inference.

Owners dự kiến, chưa phải file đã tồn tại:

- `apps/chat-api/src/index.ts`: load config, bind loopback, shutdown.
- `apps/chat-api/src/app.ts`: routes, Bearer auth và error envelope.
- `apps/chat-api/src/config.ts`: config/schema riêng, không mở rộng auth mode MCP.
- `apps/chat-api/src/proxy.ts`: request upstream, streaming, timeout/cancellation.
- Tests colocated theo convention repo; chỉ tách thêm module khi trách nhiệm thực tế cần.

Ưu tiên `node:http`, `node:crypto`, stream/fetch và dependency đã có. Không thêm provider SDK/router framework chỉ để chuyển tiếp hai HTTP API. Không import app gateway cũ như một public server hay tạo fake lease để gọi nó.

### Upstream và model

- Một upstream OpenAI-compatible được operator cấu hình bằng HTTPS base URL kết thúc ở `/v1`; không nhận URL/credential từ client.
- `CHAT_ALLOWED_MODELS` là allowlist nonempty các model ID chính xác; forward model không đổi. Không âm thầm chọn model/provider khác.
- `/v1/chat/completions` chuyển tới `<base>/chat/completions`; `/v1/responses` chuyển tới `<base>/responses`. Ghép path không làm mất prefix hoặc lặp `/v1`.
- Upstream và ít nhất một model được chọn phải hỗ trợ native cả hai API. Nếu provider chỉ có Chat Completions, báo rõ không đáp ứng acceptance; **không giả lập Responses bằng bọc JSON chat hoặc nuốt trường không hiểu**.
- Native pass-through giữ các trường provider hỗ trợ: message/input, system/developer instructions, tool calls, structured output, usage, token limits, stream options và metadata. Kiểm tra envelope chung; không tự strip trường chưa biết hoặc diễn giải hai protocol thành một schema.
- Các trường stateful của Responses như `previous_response_id`/`store` theo upstream contract; không lưu conversation/response trong harness và không quảng bá CRUD response chưa implement. Data retention phía provider phải được nêu rõ trong hướng dẫn vận hành.

### Reuse mà không làm yếu code cũ

Đọc lại implementation và references trước khi tái sử dụng helper. Những module gắn agent lease/budget không phù hợp làm public auth. Chỉ reuse helper độc lập nếu contract/error semantics đúng cho chat; không tạo abstraction mới hoặc chuyển module cũ chỉ vì trùng vài dòng. Nếu cần thay exported helper, kiểm tra callsites và giữ regression boundary cũ. Kế hoạch mặc định không sửa logic internal gateway.

## 3. Public contract

| Route | Xác thực | Hành vi |
|---|---|---|
| `POST /v1/chat/completions` | Chat API key | OpenAI-compatible Chat Completions JSON/SSE |
| `POST /v1/responses` | Chat API key | OpenAI-compatible Responses JSON/SSE |
| `GET /v1/models` | Chat API key | OpenAI model list, chỉ model có trong allowlist và upstream catalog |
| `GET /healthz` | Không | Trạng thái liveness tối thiểu, không config/model/secret |
| `GET /readyz` | Không | Local config/key/upstream config đã load; không tự gọi model tốn tiền |
| Bất kỳ route khác | Không cấp capability | `404`, không proxy wildcard |

Readiness không chứng minh credential provider còn hiệu lực hoặc model có quota; phải có inference smoke thật trước rollout. Discovery phải hoạt động qua `client.models.list()`, không yêu cầu `jq` hoặc extension riêng của 9Router.

### Request

- `Authorization: Bearer <chat-api-key>`, JSON content type; không chấp nhận key qua query/cookie.
- Validate auth trước khi gọi upstream; duplicate/malformed Authorization bị từ chối. So sánh digest fixed-length bằng constant-time primitive.
- Body phải là JSON object; `model` là chuỗi trong allowlist, `stream` nếu có là boolean. Chat cần `messages` array, Responses theo native input/continuation contract; không ép hai API cùng shape hoặc hạn chế sai request hợp lệ.
- Envelope sai trả `400`, media type sai `415`, body quá lớn `413`, thiếu/sai key `401`, model ngoài allowlist `400` với code rõ, không gọi upstream.
- Method sai trên route có thật trả `405`. Không bật permissive CORS; browser frontend không nằm trong scope, curl/SDK server-side không cần CORS.

### Response và SSE

- JSON thành công giữ response shape/ID/model/usage của upstream, không bọc MCP result envelope.
- Chat stream giữ `data:` chunks và `[DONE]`; Responses stream giữ event names, response/item IDs, thứ tự events và completion/error terminal events do upstream phát.
- Không parse/rebuild chunk thành fake completion; không buffer toàn bộ stream. Tôn trọng backpressure và hủy request upstream khi downstream disconnect.
- Không forge terminal success khi upstream ngắt giữa stream. Sau khi headers đã gửi, không đổi HTTP status hoặc chèn JSON thường vào SSE; đóng stream bất thường/forward native error event đã có.
- Ngrok không được làm stream thành HTML browser warning; public smoke dùng content type và events thật để phát hiện.

### OpenAI wire format và model discovery

- Chat JSON: `id`, `object: "chat.completion"`, `created`, `model`, `choices[]` với `index`, `message` và `finish_reason`; `usage` nếu upstream cung cấp giữ `prompt_tokens`, `completion_tokens`, `total_tokens` cùng token details. Không tự tạo token count.
- Giữ `message.tool_calls`, `tool_call_id`, assistant content có thể null và các finish reason hợp lệ như `tool_calls`, `length`, `content_filter`; không chỉ test câu trả lời text có `stop`.
- Chat SSE: content type `text/event-stream`, JSON chunks `object: "chat.completion.chunk"`, `choices[].delta` (role/content/tool_calls), finish reason và `[DONE]`. `stream_options.include_usage` có thể tạo chunk `choices: []`; không drop chunk này hoặc coi nó là lỗi.
- Responses JSON: `object: "response"`, `id`, `created_at`, `status`, `model`, `output[]` theo native typed items; output text là content item `type: "output_text"`. Giữ reasoning/function-call items, usage `input_tokens`/`output_tokens`/`total_tokens` và trạng thái incomplete/error. Không ép Responses thành `choices[]` hoặc bắt buộc wire response có top-level `output_text`; đó có thể là convenience do SDK tạo.
- Responses SSE giữ event type như `response.created`, `response.output_text.delta`, `response.completed`, `response.failed`, `response.incomplete`, cùng item/tool-call events native. Không thêm Chat `[DONE]` thay cho terminal events Responses.
- Chat hỗ trợ pass-through `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `max_tokens`/`max_completion_tokens` và content arrays theo khả năng upstream. Responses giữ format riêng như `instructions`, `input` items, `max_output_tokens`, `text.format` và `function_call_output`; không đổi tên field giữa API. Temperature/top_p/stop/seed và tham số khác được upstream validate, không strip hoặc bỏ qua âm thầm.
- `GET /v1/models` gọi fixed `<base>/models`, validate OpenAI list `{ "object": "list", "data": [...] }`, lọc theo `CHAT_ALLOWED_MODELS`, giữ `id`, `object: "model"`, `created`, `owned_by` của upstream. Không bịa metadata/context window hoặc trả model bị cấm. Không trả upstream URL, config hoặc key. Catalog thiếu/lỗi phải báo lỗi rõ, không giả catalog thành công; upstream `/models` là prerequisite của lựa chọn provider.
- ID có dấu `/` như ví dụ `openai/gpt-5` của 9Router là chuỗi opaque nếu upstream thực sự nhận ID đó. Không hardcode prefix `openai/` hoặc tự bỏ prefix. Discovery ID phải dùng được trong request; model không hỗ trợ một API phải trả lỗi native rõ thay vì route khác.
- Giới hạn response/deadline/auth áp cả discovery; không bật anonymous discovery như ví dụ curl ngắn trong skill. Metadata không bảo đảm provider hỗ trợ mọi optional feature; tài liệu phải ghi capability đã kiểm chứng thay vì tuyên bố full OpenAI API.


### Errors

- Lỗi app trước khi stream dùng `{ "error": { "message": "...", "type": "...", "param": null, "code": "..." } }`; không stack trace, hostname nội bộ hoặc secret.
- Lỗi upstream OpenAI-compatible giữ status/error code phù hợp, xử lý body có giới hạn và redact credential nếu bị upstream echo; chỉ chuyển tiếp response headers được phép như content type, Retry-After và safe request ID.
- Lỗi network trả `502`; deadline trước headers trả `504`. Upstream trả HTML/redirect không được coi là model response thành công; không theo redirect mang provider credential.
- Không tự retry request inference hoặc fallback provider, kể cả `429`, timeout, stream đứt; client quyết định để tránh tính phí trùng.

## 4. Bảo mật khi public

Chat key khác provider key, ngrok authtoken, MCP bearer, managed API keys và agent leases. Config thiếu/placeholder hoặc chat key trùng provider key thì fail startup. Shared chat key chỉ cấp inference; không cấp RCE hoặc quản trị harness. Nó vẫn có thể tiêu tốn quota provider nên chỉ chia sẻ cho máy/người tin cậy.

- Listener chỉ loopback; request Host chỉ chấp nhận loopback và exact `CHAT_PUBLIC_HOST`. Host/Origin/X-Forwarded-* không phải chứng cứ xác thực.
- Không đọc caller forwarding/Cloudflare headers để bypass key hoặc giả danh principal; không forward inbound Authorization, Cookie, Host hoặc arbitrary headers tới provider.
- Outbound credential được nạp từ private file; rebuild header allowlist. Base URL do operator kiểm soát, HTTPS, không userinfo/query/fragment, từ chối private/loopback/link-local/metadata destinations và redirect; reuse existing safe egress primitive nếu phù hợp để không bỏ DNS-rebinding boundary.
- Không ghi prompt, completion, request/response body hoặc secret vào app/launcher logs. Chỉ log metadata tối thiểu như status, duration và safe request ID. Tắt ngrok inspection theo runtime plan; ngrok/provider vẫn là trust boundaries bên ngoài.
- Giới hạn đề xuất phải được schema hóa và test tại implementation: request body 4 MiB, tổng response 16 MiB (kể cả SSE), 4 inference đồng thời, 60 inference requests/phút/instance, deadline tổng 300 giây. Đây là mặc định thiết kế, không claim hành vi repo hiện tại.
- Request vượt admission trả `429`, không queue vô hạn. Byte limits áp khi đọc stream, không chỉ tin Content-Length; giải phóng slot/timer/socket trên success, reject, timeout và disconnect.
- Giới hạn request/byte/concurrency không phải billing cap; operator đặt spend/quota tại provider. Restart app reset in-memory admission limits.
- Shutdown ngừng nhận request mới, abort request còn lại trong thời hạn hữu hạn, đóng listener và không replay request sau restart.

## 5. Work packages

### F1 — Standalone app và config/auth

- [x] Thêm chat workspace, config riêng và root scripts; không thay behavior/default của CLI MCP.
- [x] Config/key fail-closed, loopback binding, host policy, readiness và route allowlist.
- [x] Key riêng; rotate/revoke qua file + restart theo runtime plan (đã smoke foreground).
- [x] Không phụ thuộc database, Docker, runner, dashboard hoặc Cloudflare.

### F2 — Hai native inference endpoints

- [x] Chat Completions: envelope validation, allowlisted model, JSON + SSE.
- [x] Responses: envelope validation, native upstream route, JSON + SSE; không translation fake.
- [x] Model discovery `/v1/models`: catalog upstream có giới hạn, lọc allowlist, giữ OpenAI list/model shape và lỗi rõ khi upstream không đáp ứng.
- [x] Fixed upstream/header boundaries, timeout, size/concurrency/request limits, backpressure và cancellation.
- [x] Error contract trước/sau streaming headers; không retry/fallback tự động.

### F3 — Kiểm chứng và hướng dẫn

- [x] Tests cho lỗi consumer-visible và security boundaries dưới đây.
- [ ] Local real-provider smoke cho cả hai API, JSON/SSE, sau đó ngrok smoke từ máy khác.
- [ ] Thực hiện runtime/Makefile/LaunchAgent acceptance tại [plan.md](plan.md#5-trình-tự-và-acceptance-runtime).
- [x] Sau local process smoke, cập nhật internal docs và docs-site; không sửa skill/plugin MCP vì tool/schema/behavior không đổi.

## 6. Acceptance và verification

### Permanent checks cần thiết

Dùng suite/framework hiện có, upstream HTTP fixture cô lập cho hành vi lỗi/cancellation; fixture không thay thế live-provider proof.

- [x] Thiếu/sai/malformed key, forbidden model, invalid JSON/size: nhận đúng lỗi và upstream không nhận request.
- [x] Khóa MCP không tự có quyền chat; spoofed forwarded/Access headers không bypass chat auth; route isolation được kiểm tra local (public tunnel còn pending).
- [x] Credentials không bị forward sai, echo trong error/log hoặc gửi theo redirect; egress chặn private/metadata và DNS-rebinding theo boundary đã chọn.
- [x] JSON của hai API giữ đúng protocol, tool-call/usage/structured-output fields; model không bị đổi ngầm.
- [x] Model discovery không lộ model bị cấm hoặc metadata secret; model IDs gồm dấu `/` giữ nguyên. Tool-call round trip, content arrays, structured output và usage-only SSE chunk không bị biến dạng.
- [x] SSE chia chunk ở các ranh giới byte bất kỳ vẫn giữ nguyên dữ liệu/event order; client nhận chunk đầu trước khi upstream hoàn tất.
- [x] Client abort/slow reader, upstream timeout/stream đứt và response quá lớn giải phóng resources, không báo thành công giả hoặc retry.
- [x] Concurrent/rate limits và reset sau completion/abort có hiệu lực; không test chỉ dựa trên text source hoặc echo mock đơn thuần.
- [ ] Regression gate giữ nguyên auth và agent lease/budget của MCP/internal gateway nếu reuse thay shared code.

### Runtime proof bắt buộc trước khi hoàn tất feature

1. `build:chat`/`start:chat` chạy thật, không start MCP/runner/Docker.
2. Curl local nhận output model thật cho cả hai endpoint ở non-streaming và streaming; ghi status/content type/terminal signal đã sanitize, không lưu prompt/key nhạy cảm.
3. Curl ngrok từ máy khác cùng bốn trường hợp; thiếu key bị `401`, route ngoài scope không public được.
   OpenAI SDK thật phải chạy `models.list()`, `chat.completions.create()` và `responses.create()` ở JSON/SSE trên cả loopback lẫn ngrok. Test client cấu hình `maxRetries: 0` để không che lỗi/nhân đôi chi phí; SDK lỗi phải đọc được HTTP status và OpenAI error envelope, không cần custom transport.
4. Smoke rotate/restart/stop/uninstall; dữ liệu/code/deployment MCP không bị đụng.
5. Narrow suite trước rồi `npm run verify`; docs build và shell/plist check khi thay các file tương ứng. Không tự chạy production deploy/canary.

Không có provider credential/model native Responses hoặc ngrok account/máy thứ hai thì ghi rõ gate còn thiếu; không đánh dấu feature end-to-end hoàn tất chỉ bằng mock hoặc build pass.

## 7. Curl acceptance sau implementation

Những lệnh này dành cho endpoint mới **sau khi đã implement và start**. Operator nạp `CHAT_BASE_URL` (kết thúc ở `/v1`), `CHAT_API_KEY` và `CHAT_MODEL` vào môi trường client một cách an toàn; không ghi key thật vào history hoặc repo.

### Model discovery

```bash
curl --silent --show-error --fail-with-body \
  "$CHAT_BASE_URL/models" \
  -H "Authorization: Bearer $CHAT_API_KEY"
```

### Chat Completions

```bash
curl --silent --show-error --fail-with-body \
  "$CHAT_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CHAT_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"model\":\"$CHAT_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with hello\"}],\"stream\":false}"
```

### Responses

```bash
curl --silent --show-error --fail-with-body \
  "$CHAT_BASE_URL/responses" \
  -H "Authorization: Bearer $CHAT_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"model\":\"$CHAT_MODEL\",\"input\":\"Reply with hello\",\"stream\":false}"
```

Để smoke SSE, đổi `stream` thành `true` và thêm `--no-buffer`; không dùng parser MCP hoặc đòi cả hai API cùng `[DONE]`. Các ví dụ giả định model ID được operator chọn không có ký tự cần JSON escaping; client chương trình phải dùng JSON serializer. Trên máy nhiều user, dùng private curl config/header qua stdin thay vì để key trong process arguments.

## 8. Điều kiện external và quyết định không tự mở rộng

- Provider cụ thể, model ID, provider key và ngrok hostname là giá trị operator cung cấp khi chạy; không cần chúng để sửa plan hoặc implement boundary có tests.
- Chọn upstream hỗ trợ native cả hai API để giữ implementation nhỏ và đúng protocol. Không hỗ trợ native là blocker cho rollout provider đó, không lý do silently thu hẹp Responses.
- Không có bước migrate/retire code cũ. Sau khi chat chạy được, MCP vẫn có thể chạy riêng theo quy trình hiện hữu nếu chủ sở hữu muốn.
- Lần cập nhật này chỉ lưu plan; chưa cấp quyền deploy, mở tunnel hoặc dùng provider key thực hiện request tính phí.

## 9. OpenAI SDK acceptance client

Ví dụ chạy từ project client có official `openai` SDK; đây là smoke client, không phải dependency bắt buộc của server proxy. Pin SDK version dùng trong verification và ghi vào evidence. `CHAT_BASE_URL` gồm `/v1` đúng một lần.

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.CHAT_BASE_URL,
  apiKey: process.env.CHAT_API_KEY,
  maxRetries: 0,
});
const model = process.env.CHAT_MODEL;

console.log((await client.models.list()).data.map(item => item.id));

const chat = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Reply with hello' }],
});
console.log(chat.choices[0].message.content);

const chatStream = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Reply with hello' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of chatStream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}

const response = await client.responses.create({
  model,
  input: 'Reply with hello',
});
console.log(response.output_text);

const responseStream = await client.responses.create({
  model,
  input: 'Reply with hello',
  stream: true,
});
for await (const event of responseStream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
}
```

Consumer-visible assertions trong smoke thực tế phải kiểm tra shape, finish/status và terminal events, không chỉ thấy có chữ in ra. Thêm negative call xác nhận SDK nhận `401` với key sai và `429` khi admission limit bị vượt. `maxRetries: 0` chỉ kiểm soát SDK của smoke; người dùng SDK khác vẫn có thể tự retry theo cấu hình riêng.

## 10. Đối chiếu nguồn và phần được bổ sung

- [Skill 9Router Chat do người dùng cung cấp](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-chat/SKILL.md): OpenAI Chat Completions, Bearer key, model discovery, SDK `baseURL`, JSON `choices`/`usage` và SSE delta + `[DONE]` là các contract được đưa vào acceptance.
- Skill này còn có Anthropic `/v1/messages`, `/v1/models/info` và combos auto-fallback. Đây không phải điều kiện OpenAI format; được ghi ngoài scope chứ không mô tả như đã hỗ trợ.
- Skill không mô tả `/v1/responses`; endpoint này vẫn bắt buộc theo yêu cầu người dùng, tham chiếu [official OpenAI Node SDK](https://github.com/openai/openai-node#usage) và [Responses streaming](https://github.com/openai/openai-node#streaming-responses). Không suy ra Responses tương thích chỉ từ Chat Completions pass.
- Những phần bổ sung so với bản plan đầu: `/v1/models`, explicit JSON/SSE shapes, usage-only chunks, tool-call/multimodal content preservation, SDK runtime proof và distinction giữa Responses typed events với Chat chunks.

### Tham chiếu bổ sung: checkout local `0router`

Đã đối chiếu `/Users/vnext/project/0router` theo yêu cầu người dùng. Đây là đường dẫn checkout tham khảo trên máy, không phải runtime dependency hoặc code cần copy vào app mới.

- `docs/ARCHITECTURE.md:93-105`: liệt kê route Responses và quy tắc rewrite `/v1/*` sang `/api/v1/*`. Phần API Reference của `README.md:1474-1499` chỉ có Chat Completions và model list; không phải hướng dẫn Responses đầy đủ.
- `src/app/api/v1/responses/route.js:23-29`: mô tả rõ `POST /v1/responses - OpenAI Responses API format`, khởi tạo translators rồi gọi shared `handleChat`.
- `open-sse/translator/request/openai-responses.js:22-90`: translator Responses → Chat xử lý `input`, `instructions`, content arrays và reasoning continuity. `open-sse/translator/response/openai-responses.js:50-85,339-365,437-475` chuyển Chat chunks thành Responses events, xử lý tool-call identity và terminal response output. Đây là bằng chứng có translation layer, không chỉ native pass-through.
- `tests/unit/openai-responses-multiturn.test.js:13-137`: có test giữ reasoning/encrypted_content qua nhiều lượt và round trip; chưa chạy suite này trong lần tham khảo.

Acceptance bổ sung rút ra từ implementation tham khảo:

- [x] `response.completed.response.output` chứa kết quả hoàn chỉnh đúng thứ tự của các `response.output_item.done`; SDK fixture checks xác nhận output cuối.
- [x] Giữ usage cuối stream, gồm cached/reasoning token details nếu upstream có; không mất usage-only trailer hoặc tự bịa số token.
- [x] Giữ `item_id`, `call_id`, `output_index`, argument deltas và sequence numbers; native bytes/items không được ghép lại.
- [x] Manual multi-turn giữ nguyên thứ tự message/reasoning/function-call items và `encrypted_content`; không coi reasoning là dữ liệu chỉ để hiển thị rồi bỏ đi.

Không copy workaround của translator vào native proxy: helper `open-sse/translator/formats/responsesApi.js` có hành vi thay input rỗng bằng `...` và xóa `store`/`reasoning` khi convert. Smoke trực tiếp helper với input text đã xác nhận `input`/`instructions` được đổi thành `messages` và `store` bị bỏ; đây chỉ là helper proof, không phải HTTP/provider end-to-end proof. Node phát cảnh báo module type khi chạy helper; không sửa repo tham khảo.

Quyết định hiện hành vẫn là native upstream cho hai API để giữ semantics và tránh translation loss. `0router` chứng minh có thể triển khai adapter Chat ↔ Responses, nhưng adapter đầy đủ là phạm vi khác: phải chốt supported fields, continuation/storage, reasoning, tool calls và terminal/error semantics trước khi hỗ trợ provider chỉ có Chat. Không lấy sự tồn tại của route hoặc translator làm bằng chứng full OpenAI Responses compatibility.

## 11. Implementation evidence

Đã implement `apps/chat-api/`, `scripts/chat-runtime.mjs`, `scripts/smoke-chat.mjs`, Makefile, root npm scripts/lockfile và hướng dẫn internal/docs-site. Không thay logic MCP, runner, internal model gateway, Compose hay deployment. Không sync plugin vì MCP surface không đổi; giữ nguyên các file người dùng đã xóa trong working tree.

### Đã chạy

- Runtime verification: Node **26.0.0** (đáp ứng >=24), official OpenAI SDK **7.27.0**, `maxRetries: 0`.
- `npm run build:chat`: pass; `npm run build`: pass, gồm Wrangler dry-run có sẵn, không deploy.
- Focused `npx vitest run apps/chat-api/test test/chat-runtime.test.ts --no-file-parallelism`: **6 files, 38 tests pass**. SDK models/Chat/Responses JSON+SSE, HTTP fixture, native tool/reasoning/usage/terminal preservation, auth/egress/limits/cancellation, CR-only terminal EOF và runtime ownership helpers được kiểm tra; fixture không phải provider proof.
- `npm run lint`, `npm run typecheck`, `npm run docs:build`: pass.
- `node --check` cho hai launcher/smoke `.mjs`: pass. `plutil -lint` cho cả hai plist được render vào temporary directory: pass; không đăng ký LaunchAgent.
- Real `npm run start:chat` process với external private temporary config/key files: `healthz`/`readyz` 200, loopback-only listener xác nhận bằng `lsof`, missing/wrong key 401, forbidden model 400 ở cả hai inference routes, `/mcp` và `/dashboard` 404. Rotate file + restart: key cũ 401, key mới qua auth rồi 400 cho forbidden model. SIGTERM đóng listener, logs không chứa key; **zero upstream requests**. Thiếu config: nonzero exit, không ready/listen.
- `ngrok version` và `ngrok http --help`: **3.39.1**, có flags yêu cầu; không đọc credential hoặc mở tunnel.

### Gate repository chưa xanh

- `npm run verify` dừng ở `plugin:check`: `.agents/skills/cloudharness` đã bị xóa trước task.
- Chạy các gate còn lại riêng: full `npm test` có **1609 pass, 7 fail** (168 files pass, 3 fail). Năm skill-contract failures do thư mục trên thiếu; một installer test do `bin/cloudharness` đã bị xóa trước task; một runner `toctou-script-tamper.test.ts` nhận `INVALID_INPUT` ở verified-script case. Không sửa/khôi phục các file ngoài scope hoặc hạ assertions để làm gate pass.
- Runner failure chưa xác định nguyên nhân: test gọi trực tiếp worker, không đi qua chat. Worker outer catch có thể map exception sang `INVALID_INPUT`; output hiện có không chứng minh lỗi PATH/runtime/permission, nên không gán nguyên nhân môi trường.

### External acceptance còn thiếu

- Chưa có operator-supplied chat/provider config trong shell (`CHAT_*` prerequisite variables đều unset); chưa có provider/model native hai API được xác nhận và chưa được phép gửi inference tính phí.
- Chưa resolve ngrok account/hostname/retention bằng owner credentials; chưa có second-machine public smoke. Không mở tunnel chỉ để vượt gate.
- Còn phải chạy local **real-provider** curl + official SDK cho discovery và cả hai API JSON/SSE, rồi lặp lại từ máy khác qua ngrok; xác nhận content type/native terminal, 401/429 và route isolation.
- Còn phải chạy live macOS install hai lần, login/sleep/wake, stop/uninstall và rotation qua LaunchAgents trên instance được owner cho phép. Foreground rotation và plist syntax không thay thế lifecycle này.

Vì vậy code/local checks đã thực hiện, nhưng **không đánh dấu feature public end-to-end hoàn tất**. Runbook: [`docs/chat-api.md`](../../docs/chat-api.md), [`docs-site/chat-api.md`](../../docs-site/chat-api.md).
