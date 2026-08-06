# pi-anysearch-tools

**AnySearch 驱动的网页搜索工具，作为 Pi Coding Agent 的扩展包。**

注册 `anysearch_search` 工具，由 [AnySearch Search API](https://www.anysearch.com/docs#search-api)
（`POST https://api.anysearch.com/v1/search`）提供支持：根据查询意图路由到最合适的数据源，
融合并重排结果，返回带标题、URL、摘要（可选清洗后正文）的结果列表。

## 特性

- **零配置可用**：AnySearch 支持匿名访问（按 IP 限速 + 每日免费配额），不配 key 也能搜。
- **可选 API key**：`ANYSEARCH_API_KEY` 环境变量或配置文件，走付费配额、更高并发。
- **结果自带正文**：`include_content: true` 时直接返回清洗后的页面正文，无需二次抓取。
- **标准 Pi package**：通过 `pi install` 安装，TypeScript 直接加载（jiti），无需编译。

## 安装

本地目录安装（开发）：

```bash
pi install /path/to/pi-anysearch-tools
```

或发布到 npm 后：

```bash
pi install npm:pi-anysearch-tools
```

临时试用（当前会话，不写入设置）：

```bash
pi -e /path/to/pi-anysearch-tools
```

## API Key 配置

优先级：`ANYSEARCH_API_KEY` 环境变量 > 配置文件 > 匿名访问。

```bash
# 环境变量
export ANYSEARCH_API_KEY=as_sk_...
```

或写入配置文件 `<agent dir>/anysearch.json`（通常是 `~/.pi/agent/anysearch.json`）：

```json
{
  "anysearchApiKey": "as_sk_..."
}
```

不配置任何 key 时自动使用匿名访问，功能不受影响，只是限速更严格。

## 安装后提醒

`pi install` 本身不会加载扩展，因此包内代码无法在安装命令执行时弹提示；
但**安装后第一次启动 Pi（TUI）时**会自动弹出一次性提醒：

- 已配置 key → 不提醒。
- 未配置 → 顶部警告条提示配置 key，同时**保持匿名模式可用**。
- 提醒只出现一次（记入 `pi-anysearch-state.json`），不会每次打扰。

提醒出现后，可以直接运行 `/anysearch-setup` 交互式输入 key：

```
/anysearch-setup   # 粘贴 as_sk_... key，自动写入配置文件
/anysearch-status  # 查看当前认证状态与配置路径
```

`/anysearch-setup` 保存后立即生效（无需重启），`anysearch_search` 马上切换到付费配额。

## 工具说明

### `anysearch_search`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅ | 搜索查询 |
| `max_results` | int | – | 结果数 1–20，默认 10 |
| `tag` | string | – | 子域能力标签，如 `code.doc`，按意图路由到专门数据源 |
| `zone` | string | – | 区域：`cn` 或 `intl` |
| `language` | string | – | 偏好语言，如 `zh-CN`、`en` |
| `params` | object | – | 透传给 AnyMix 的扩展参数，如 `{"ticker": "AAPL"}` |
| `include_content` | bool | – | 是否在结果中附带清洗后的页面正文 |

返回结果示例（agent 看到的文本）：

```
1. Pi Coding Agent
   https://pi.dev/
   AGENTS.md: Project instructions loaded at startup from ...
```

## 与 pi-web-access 共存

本地若已安装 [pi-web-access](https://github.com/nicobailon/pi-web-access)（它注册 `web_search`
等多 provider 工具，AnySearch 是其中显式 provider 之一），本包注册的是独立的
`anysearch_search` 工具名，不会冲突。两者可同时存在：

- 想要纯 AnySearch 体验：只启用 `anysearch_search`（如 `--tools anysearch_search`）。
- 想要全家桶：保留 pi-web-access，本包可作为专用入口或对照。

## 开发与测试

```bash
npm test                     # 单元测试（不依赖网络）
```

本地端到端验证（需要模型配置）：

```bash
pi -e . --tools anysearch_search -p "搜索 pi coding agent"
```

## License

MIT
