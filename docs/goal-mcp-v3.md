# pi-anysearch v3 (/mcp) P0+P1+P2 升级 Goal

依据：官方 anysearch-skill v3.0.1 接口规范（scripts/shared/doc_spec.md、SKILL.md）+ 2026-08-19 匿名实测（/mcp 四工具可用、zone/language 有效、max_results 服务端上限 10、sub_domain_params 必须 object）。

## 推荐执行版（中文，可直接复制）

```
/goal 以 TDD 方式完成 pi-anysearch 插件（/home/xyh/code/pi-anysearch）的 P0+P1+P2 接口升级：从旧 REST /v1/search 迁移到官方 v3 接口 POST https://api.anysearch.com/mcp（JSON-RPC 2.0，method 为 tools/call，请求头需 Accept: application/json, text/event-stream，Bearer key 与匿名访问规则不变），落地 4 个工具与协议细节，先写测试再写实现。
范围 P0：实现单一 JSON-RPC 客户端（fetch + jsonrpc/id/method/params 请求体）；响应取 result.content 首项的 text（Markdown）、result.isError、_meta.request_id；删除旧 /v1/search REST 代码路径与其信封解析。
范围 P1：用 4 个 registerTool 替换现有单一 anysearch_search：
1) anysearch_search：query 必填；可选 domain（17 值枚举：general resource social_media finance academic legal health business security ip code energy environment agriculture travel film gaming）、sub_domain、sub_domain_params（object；required 字段不适用时传空字符串，不得省略）、max_results（1-10，默认 10）、zone（cn/intl）、language；移除旧 tag、params、include_content 参数。
2) anysearch_batch_search：queries 数组 2-5 项，每项遵循 search 同构参数（query 必填）；单项失败不阻塞其余项。
3) anysearch_extract：url 必填（必须以 http:// 或 https:// 开头），返回整页 Markdown（服务端 5 万字符截断）。
4) anysearch_get_sub_domains：domain（单个）或 domains（数组不超过 5 个，优先于 domain），返回垂直域目录文本；同一会话内对相同域集合做内存缓存，不重复请求。
范围 P2：max_results schema 从 1-20 改为 1-10 且代码 clamp（服务端硬上限 10）；错误信息携带 _meta.request_id；响应或错误中出现 auto_registered.api_key 时解析出来，经 UI 提示用户，用户确认后用现有 writeApiKey 写入 agent 目录配置文件；保留匿名模式提醒逻辑。
TDD 纪律：
1) 先写失败测试（node --test + assert，风格与现有 test/anysearch.test.ts 一致）：单测 mock global fetch，覆盖 JSON-RPC 请求体组装（method tools/call、工具名、参数透传含 zone、language、sub_domain_params object）、max_results clamp、isError 与 request_id 错误路径、auto_registered 解析、get_sub_domains 会话缓存；运行 npm test 先确认红。
2) 端到端测试 test/e2e.test.ts 对 /mcp 做真实匿名调用，覆盖 5 场景：通用搜索（断言文本含 Paris）、finance 垂直搜索（domain 为 finance、sub_domain 为 finance.quote、sub_domain_params 为 object，字段 type 为 stock、symbol 为 AAPL、cn_code 为空字符串；断言文本含 NASDAQ 或 Price 或 MarketCap）、batch_search 两条查询（断言含 Paris 与 Berlin）、extract 抓取 example.com（断言含 Example Domain）、get_sub_domains 查询 finance（断言含 finance. 与 Parameters）；每个成功场景把原始响应存为 .evidence/ 下的 json 文件作证据；网络不可达时 e2e 标记 skipped 并打印原因，静默跳过视为失败。
3) 实现最小代码转绿；不得改测试语义凑绿；因服务端措辞漂移调整断言标记必须在报告中说明。
约束：不新增 npm 依赖（项目无 devDependencies，typebox 由宿主提供）；不改 key 优先级（环境变量 ANYSEARCH_API_KEY 优先于 anysearch.json）；不删除或破坏 anysearch-setup 与 anysearch-status 命令；不做 P3（邮箱注册流程、完整 prompt 决策树移植）；保留 TUI 折叠/展开渲染可用。
验证：运行 npm test（即 node --experimental-strip-types --test test/*.test.ts）直至单测与集成测试全部通过；再运行一次 npm test 让 e2e 生效，5 个 e2e 场景通过（或显式打印跳过原因），且 .evidence/ 下有对应 5 个 json 文件；保留两次运行的完整输出作为验证证据。
边界：只修改 anysearch.ts、index.ts、test/、README.md、package.json（仅允许 test 相关 scripts，不改版本号），新增 .evidence/ 目录。
迭代策略：e2e 失败后最多 3 轮聚焦修复；每轮重试前先读取原始响应与 request_id 再改代码；遇 429 限流则降并发或等待后重试；匿名配额耗尽时暂停并报告。
完成条件：npm test 全绿（含 e2e 通过或显式跳过原因）、.evidence/ 的 5 个 json 文件可列出、并输出简明的中文变更清单（新增工具、参数、协议变化）与验证输出。
暂停条件：需要真实付费 key、匿名模式完全不可用、需要改动本范围外的插件既有公开接口、或所有权不清时暂停并请求确认。
```

默认选择理由：实测已证明 /mcp 匿名覆盖全部目标能力且 zone/language 不丢，全量迁移比双端点回退更短更小，故默认删 REST。

可选调整：
1. 旧 REST 路径：A 全量删除（默认，推荐）/ B 保留作 /mcp 失败时的回退
2. e2e 断言标记：A 用已实测的 5 个标记（默认）/ B 只断言 isError 为假、不校验内容
3. auto_registered：A 提示+确认后写入（默认，官方流程）/ B 只提示、不自动写入

你可以直接回复：按默认 / 1B 2A 3B

## Goal Draft (English-compatible)

```
/goal TDD upgrade of the pi-anysearch plugin (/home/xyh/code/pi-anysearch): migrate from legacy REST /v1/search to the official v3 endpoint POST https://api.anysearch.com/mcp (JSON-RPC 2.0 tools/call, Accept: application/json, text/event-stream; same Bearer key and anonymous rules). Tests first, then implementation.
P0: single JSON-RPC client (fetch, jsonrpc/id/method/params); read first text item of result.content (Markdown), result.isError, _meta.request_id; delete the /v1/search REST path and envelope parser.
P1: replace the single anysearch_search tool with 4 registered tools:
1) anysearch_search: query required; optional domain (17-value enum: general resource social_media finance academic legal health business security ip code energy environment agriculture travel film gaming), sub_domain, sub_domain_params (object; required-but-inapplicable params as empty string, never omitted), max_results (1-10, default 10), zone (cn/intl), language; drop tag, params, include_content.
2) anysearch_batch_search: 2-5 query items, each following the search schema (query required); a failed item does not block the rest.
3) anysearch_extract: url required (http:// or https://); full-page Markdown (server truncates at 50k chars).
4) anysearch_get_sub_domains: domain (single) or domains (array max 5, takes priority); returns the vertical domain directory; cache per session in memory, no repeat calls for the same domain set.
P2: max_results schema 1-20 to 1-10 with code clamp (server hard cap 10); errors carry _meta.request_id; on auto_registered.api_key in a response/error, surface via UI and after user confirmation persist via existing writeApiKey; keep anonymous-mode reminder.
TDD:
1) Failing tests first (node --test + assert, style of test/anysearch.test.ts): unit tests mock global fetch, covering JSON-RPC body assembly (method tools/call, tool name, arg passthrough incl. zone, language, sub_domain_params object), max_results clamping, isError and request_id error paths, auto_registered parsing, get_sub_domains session cache; run npm test to confirm red.
2) E2E test/e2e.test.ts: real anonymous /mcp calls, 5 scenarios: general search (assert Paris), finance vertical (domain finance, sub_domain finance.quote, sub_domain_params object type stock symbol AAPL cn_code empty; assert NASDAQ or Price or MarketCap), batch_search with 2 queries (assert Paris and Berlin), extract of example.com (assert Example Domain), get_sub_domains finance (assert finance. and Parameters); save each raw response to .evidence/ as json; if offline mark e2e skipped and print the reason, silent skip is a failure.
3) Minimum code to turn green; never change test semantics to force green; marker changes due to server wording drift must be reported.
Constraints: no new npm dependencies (no devDependencies; typebox from the host); keep key precedence (env ANYSEARCH_API_KEY over anysearch.json); keep anysearch-setup and anysearch-status working; no P3 (email registration, full prompt decision-tree porting); keep TUI collapsed/expanded rendering.
Verification: run npm test (node --experimental-strip-types --test test/*.test.ts) until all unit and integration tests pass; run it again so e2e runs: 5 scenarios pass (or explicit skip reason), .evidence/ holds 5 json files; keep both outputs as evidence.
Boundaries: modify only anysearch.ts, index.ts, test/, README.md, package.json (test scripts only, no version bump), plus new .evidence/.
Iteration policy: max 3 focused fix rounds after e2e failures; read the raw response and request_id before each retry; on 429 lower concurrency or wait then retry; on exhausted anonymous quota pause and report.
Stop when: npm test fully green (e2e passed or explicit skip reason), the 5 .evidence/ json files are listed, and a concise change report plus verification output is delivered.
Pause if: a real paid key is required, anonymous access is unavailable, a breaking change outside this scope is needed, or ownership is unclear.
```
