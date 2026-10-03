# Local Chat API + ngrok + API key

Ngày cập nhật: 2026-10-03  
Trạng thái: Đã implement chat API và Makefile/LaunchAgent tooling; đã smoke foreground và validate plist. Chưa cài service, mở tunnel hoặc chạy inference bằng live provider.

## 1. Phạm vi mới thay thế plan cũ

Yêu cầu hiện hành: chạy một chat API độc lập trên máy local, public bằng ngrok để máy khác gọi bằng API key. Hai endpoint inference bắt buộc là `POST /v1/chat/completions` và `POST /v1/responses`; bổ sung `GET /v1/models` và OpenAI SDK compatibility theo skill 9Router do người dùng cung cấp.

Plan được tách thành hai phần:

- **File này:** runtime local, ngrok, cấu hình secret, Makefile/LaunchAgent và vận hành.
- **[chat-api.md](chat-api.md):** implementation tính năng chat, HTTP contract, upstream, bảo mật và acceptance riêng.

Giữ đường dẫn thư mục plan hiện tại để không làm mất tham chiếu; tên thư mục cũ không còn mô tả kiến trúc mới.

### Quyết định thay đổi

| Plan cũ | Plan hiện hành |
|---|---|
| Public MCP qua ngrok | Chỉ public chat API `/v1/*` được liệt kê trong feature plan |
| Dashboard deploy Cloudflare Workers, Access/OAuth | Không deploy Workers; không cần dashboard hoặc OAuth cho chat |
| Docker/Colima runner, executor và firewall | Chat chạy Node.js trực tiếp trên host; không phụ thuộc Docker/Colima |
| Managed key của dashboard, xác thực qua runner | Chat API key riêng, chỉ có quyền inference |
| Migration state, cutover domain và retire code/gateway cũ | Không migration/cutover; giữ nguyên code, dữ liệu và deployment MCP cũ |
| Makefile và tự chạy sau login macOS | Giữ mục tiêu này nhưng chỉ quản lý chat process và ngrok |

Không xóa hoặc thay thế `apps/api`, runner, dashboard, API-key Worker, MCP endpoints, model gateway nội bộ, Compose hay deployment hiện hữu. Không đổi client URL hoặc thu hồi key/domain của luồng MCP. Chúng chỉ không phải dependency của tính năng mới.

“Giống 9Router” trong phạm vi này là OpenAI format cho chat/Responses, JSON/SSE, model discovery và client SDK dùng trực tiếp; không bao gồm Anthropic `/v1/messages`, extension `/v1/models/info`, OAuth provider login, account rotation, fallback đa provider, UI quản trị, billing hoặc toàn bộ tính năng 9Router.

## 2. Runtime độc lập

- App mới dự kiến: `apps/chat-api`, Node.js >=24, cùng npm workspace hiện có.
- Listener mặc định: `127.0.0.1:3211`; không dùng cổng ingress MCP `3100` hoặc model gateway `3210`.
- ngrok chỉ forward tới listener chat này, không forward tới MCP ingress hay proxy toàn bộ stack.
- HTTPS public kết thúc tại ngrok; app vẫn bắt buộc kiểm tra chat API key ở mọi request inference, kể cả loopback.
- Không mount Docker socket, không đọc database/keyring/workspace của harness, không gọi runner để xác thực key.
- Máy chủ chỉ cần Node/npm, kết nối tới upstream model, ngrok account/agent và cấu hình chat hợp lệ. Không cần Cloudflare account, Wrangler, Docker hoặc Colima.
- Việc chạy chat trên host không biến nó thành sandbox; handler không được cung cấp exec/file/Git/workspace operations.

### Phương án đã chọn

1. **App/process riêng — chọn:** tách port, auth và lifecycle; chạy được khi MCP/runner đều tắt.
2. Gắn chat vào `apps/api` — không chọn: kéo theo cấu hình MCP/control plane và dễ public nhầm surface.
3. Public model gateway nội bộ — không chọn: gateway yêu cầu agent lease và budget; bỏ kiểm tra đó sẽ làm yếu boundary cũ.

## 3. Cấu hình và secret

Config contract đã implement tại `apps/chat-api/src/config.ts`; bảng dưới giữ các biến chính của thiết kế:

| Biến | Ý nghĩa |
|---|---|
| `CHAT_API_PORT` | Cổng loopback, mặc định `3211`; không cho cấu hình bind wildcard trong luồng này |
| `CHAT_API_KEY_FILE` | Absolute path tới file chứa chat client key, nằm ngoài repository |
| `CHAT_UPSTREAM_BASE_URL` | HTTPS base URL của upstream OpenAI-compatible, bao gồm `/v1` |
| `CHAT_UPSTREAM_API_KEY_FILE` | Absolute path tới file provider key, khác chat key |
| `CHAT_ALLOWED_MODELS` | Danh sách model ID được phép; giữ nguyên ID khi gửi upstream |
| `CHAT_PUBLIC_HOST` | Exact hostname ngrok thực tế được operator cấp cho instance |

Một upstream cố định, một chat key chia sẻ cho nhóm máy tin cậy là thiết kế tối thiểu. Không thêm database/key CRUD/dashboard. Rotate/revoke bằng thay key trong private file và restart app; khóa cũ bị từ chối ở request mới sau restart. Nếu cần thu hồi riêng từng máy thì mở rộng key registry trong yêu cầu riêng, không gán khả năng đó cho shared key hiện tại.

Phân biệt ba secret: **chat client key**, **upstream provider key**, **ngrok authtoken**. Không dùng key MCP cho chat; không forward chat key đến provider. App từ chối khởi động nếu chat key trùng provider key. Tạo key ngẫu nhiên ít nhất 32 byte; private file quyền `0600`, thư mục `0700`. Không truyền secret trong argv, plist, URL, log hoặc commit.

ngrok credential sử dụng private config của ngrok; service launcher không in file đó. Tắt request inspection của tunnel; kiểm tra riêng cấu hình traffic capture/retention ở ngrok account trước public vì prompt và Authorization đi qua dịch vụ này.

## 4. Cách chạy dự kiến sau implementation

Các npm script và Make target đã implement. Hướng dẫn vận hành hiện hành: [`docs/chat-api.md`](../../docs/chat-api.md) và [`docs-site/chat-api.md`](../../docs-site/chat-api.md). Install/start tunnel là live operation, chưa được thực hiện trong lần implementation này.

### Chạy foreground trước

1. Dùng Node.js >=24, `npm ci` theo lockfile.
2. Tạo private config/key files ngoài checkout; chọn upstream và model có hỗ trợ native cả hai API.
3. Nạp các biến cấu hình vào process bằng private env file ngoài repo; launcher không `source`/eval nội dung config như shell script.
4. Build và chạy app bằng command authority mới ở root:

```bash
npm run build:chat
npm run start:chat
```

5. Kiểm chứng local auth, hai API và streaming trước khi mở ngrok.
6. Mở tunnel ở process riêng sau readiness:

```bash
ngrok http http://127.0.0.1:3211 \
  --url "https://$CHAT_PUBLIC_HOST" \
  --inspect=false
```

`CHAT_PUBLIC_HOST` phải là domain ngrok thuộc account đang dùng; hostname từng ghi trong plan cũ không phải bằng chứng hiện còn được cấp. Không cần tạo DNS trỏ localhost. Xác nhận CLI version hỗ trợ cờ đã dùng bằng `ngrok http --help` trước rollout.

Base URL cho máy khác: `https://<assigned-ngrok-host>/v1`. API key là chat client key, không phải ngrok authtoken. Curl mẫu của cả hai endpoint nằm trong [feature plan](chat-api.md#7-curl-acceptance-sau-implementation).

### Makefile và auto-start macOS

Giữ yêu cầu `make install`/LaunchAgent của plan trước, nhưng installer chỉ quản lý app chat và tunnel:

| Target dự kiến | Hành vi |
|---|---|
| `make install` | Kiểm tra prerequisite/config, build chat, đăng ký user LaunchAgents và start đúng instance |
| `make start` | Start chat, chờ readiness, rồi start ngrok |
| `make status` | Kiểm tra đúng PID/listener và trạng thái tunnel; không in secret |
| `make logs` | Log lifecycle/lỗi đã redact, không prompt, response body hoặc credential |
| `make stop` | Dừng tunnel và chat của instance; không đụng MCP/Colima |
| `make uninstall` | Gỡ LaunchAgents; giữ private config/key và mọi dữ liệu MCP |

- Root Makefile chỉ bọc npm scripts/launcher; `package.json` là command authority.
- Chạy lại install không rotate key, nhân đôi job, chiếm port của process khác hoặc thay cấu hình đã có.
- Plist dùng executable/path tuyệt đối và private config path; không phụ thuộc interactive shell PATH, không chứa secret.
- Dùng foreground processes dưới launchd, không đặt `KeepAlive` quanh lệnh detached đã thoát; giới hạn restart để tránh busy loop.
- Tự chạy **sau login**, không hứa hoạt động trước login hoặc sau logout. Sleep/mất mạng có thể ngắt stream; không tự replay inference khi reconnect.
- Không cài ngầm package manager/runtime; thiếu prerequisite thì báo cách bổ sung. Không thay Docker context, profile Colima hoặc ngrok instance không thuộc plan.
- Không rebuild mỗi login. Repo path đổi thì cài lại registration. Log có quyền hạn chế và rotation hữu hạn.

## 5. Trình tự và acceptance runtime

### Phase A — Feature local

- [ ] Hoàn tất feature plan; start chat được khi MCP API, runner, Docker/Colima đều tắt.
- [x] Listener chỉ nằm ở loopback và không chiếm cổng hiện hữu (foreground smoke dùng cổng trống tạm).
- [x] Sai/thiếu config/key fail closed trong config tests; public health chỉ trả trạng thái tối thiểu trong process smoke.
- [ ] Local curl thật cho cả hai endpoint, JSON và SSE; sai key bị chặn trước khi gọi upstream.

### Phase B — Public qua ngrok

- [ ] Resolve account/hostname/CLI và quyền dùng provider; không dùng credential giả hoặc live key không được phép.
- [ ] Tunnel chỉ trỏ port chat; inspection tắt, review capture/retention và quota ngrok.
- [ ] Từ **máy khác**, curl HTTPS với key hợp lệ nhận output model thật cho cả hai API, cả JSON lẫn SSE.
- [ ] Thiếu/sai key bị `401`; `/mcp`, `/mcp-gateway`, `/mcp-api-key`, `/dashboard` và exec/workspace routes không truy cập được qua tunnel chat.
- [ ] Ngắt client hủy upstream; tunnel offline không tự fallback sang deployment/MCP cũ hoặc retry sinh chi phí.

### Phase C — Lifecycle macOS

- [ ] Install hai lần không thay key/config hoặc nhân đôi LaunchAgents.
- [ ] Login lại start app trước tunnel; restart, sleep/wake không tạo instance trùng hoặc tự replay request.
- [ ] Stop/uninstall không ảnh hưởng process, database, container, domain hay credential MCP.
- [ ] Rotate chat key rồi restart: key cũ `401`, key mới hoạt động; không cần deploy cloud.

### Phase D — Docs và verification

- [ ] Test tập trung theo feature plan, sau đó gate `npm run verify` cho thay đổi code.
- [ ] Syntax check shell theo CI và `plutil`/`launchctl` trên macOS thật nếu thêm launcher.
- [x] Cập nhật README, internal docs và official docs site: phân biệt rõ chat, MCP và internal model gateway; ghi cấu hình, curl, startup/shutdown, rotation và rủi ro ngrok.
- [x] Chạy `npm run docs:build`; MCP tool/schema/skill không đổi nên không chạy reference/plugin sync.
- [x] Không deploy Workers, chạy `verify:production`, migration, DNS cutover hay Docker verification. Build repo có Wrangler **dry-run** hiện hữu, không deploy.

Đánh dấu acceptance bằng output thực tế và evidence đã sanitize. Chưa có ngrok account/provider credential/máy client thứ hai thì ghi rõ gate chưa kiểm chứng, không tuyên bố public end-to-end đã xong.

## 6. Rollback và giới hạn

- Rollback bằng stop ngrok + chat hoặc phục hồi bản chat/config trước; không rollback hay retire hệ thống MCP.
- Không xóa runtime state, key files, Colima VM, container hoặc domain cũ để rollback.
- Leak chat key có thể tiêu tốn quota provider dù không cấp quyền chạy code; revoke/rotate và kiểm tra metadata an toàn.
- ngrok là bên thứ ba xử lý traffic, không phải “dữ liệu chỉ ở local”. Máy local/provider/ngrok đều phải online; không cam kết HA hoặc quota miễn phí.
- Tính năng ngrok/traffic policy phụ thuộc account; không dùng browser interstitial bypass như cơ chế xác thực.

## 7. Căn cứ

- `package.json`: Node >=24 và npm workspace/build conventions.
- `apps/api/src/app.ts`, `docs/system-architecture.md`: MCP và dashboard hiện có là boundary riêng, không cần thay cho chat.
- `apps/model-gateway/src/gateway.ts`, `compose.yaml`: internal inference gateway dùng agent leases; không public lại listener này.
- [ngrok agent CLI](https://ngrok.com/docs/gateway/agent/cli): HTTPS tunnel tới localhost và chọn public URL.

Evidence implementation và các gate còn thiếu được ghi tại [chat-api.md — Implementation evidence](chat-api.md#11-implementation-evidence). Foreground rotate/restart/stop đã smoke; install hai lần, login/sleep và stop/uninstall LaunchAgents thật vẫn pending.
