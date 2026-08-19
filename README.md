# pi-anysearch-tools

[![npm](https://img.shields.io/npm/v/pi-anysearch-tools)](https://www.npmjs.com/package/pi-anysearch-tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

`pi-anysearch-tools` is a [Pi Coding Agent](https://pi.dev/) extension that adds four AnySearch search tools, backed by the official AnySearch v3 endpoint:

```text
POST https://api.anysearch.com/mcp   (JSON-RPC 2.0, method "tools/call")
```

Use it for current documentation, news, prices, products, people, comparisons, fact-checking, vertical-domain data (stocks, papers, legal cases, flights, drugs, code docs, weather, …), and full-page URL extraction—information that may not be available in the model's training data. These are web-search tools, not replacements for Pi's local file or shell tools.

> 中文说明：这是一个面向 Pi Coding Agent 的 AnySearch 联网搜索扩展（官方 v3 /mcp 接口）。无需 API key 也可匿名使用，但匿名请求受速率和配额限制。

## Core capabilities

- General web search as Markdown (ranked results with titles, URLs, and content).
- Vertical domain search via `domain` / `sub_domain` / `sub_domain_params` (17 domains).
- Parallel batch search: 1–5 queries in one call; a single failure does not block the rest.
- Full-page URL extraction as clean Markdown (server-truncated at 50,000 characters).
- Vertical domain directory discovery (`anysearch_get_sub_domains`), cached per session.
- Region (`zone`) and language passthrough; `max_results` clamped to the server cap of 1–10.
- Anonymous access without initial configuration.
- Optional API-key authentication from an environment variable or Pi agent configuration.
- If the API auto-registers a new key on quota exhaustion, the extension asks once via the TUI and saves it after confirmation.
- Compact Pi TUI rendering (collapsed by default, expandable).

## Installation

Install the published npm package:

```bash
pi install npm:pi-anysearch-tools
```

### Local development and temporary use

From a checkout of this repository:

```bash
# Load the extension for the current Pi invocation only
pi -e .

# Install the local directory as a Pi package
pi install .
```

## API key configuration

Configuration priority is:

```text
ANYSEARCH_API_KEY environment variable
> <agent dir>/anysearch.json
> anonymous mode
```

Set the environment variable in your shell or CI environment:

```bash
export ANYSEARCH_API_KEY="your-api-key"
```

Or create `~/.pi/agent/anysearch.json`:

```json
{
  "anysearchApiKey": "your-api-key"
}
```

`~/.pi/agent` is Pi's default agent directory. If `PI_CODING_AGENT_DIR` is set, the extension reads `anysearch.json` from that directory instead.

Anonymous mode remains usable when no key is configured, but it has stricter rate and quota limits.

### Auto-registered keys

When a configured key's quota is exhausted, the AnySearch API may return a new key in the response (`auto_registered.api_key`). The extension detects it, asks for confirmation in the TUI, and writes the key to the agent configuration file after you confirm. In headless mode it instead appends a notice to the tool result; the key can also be retrieved later from the AnySearch dashboard.

### Pi commands

```text
/anysearch-setup
```

Opens an interactive prompt and saves the key to the Pi agent configuration file. The new key is used by subsequent searches without restarting Pi, unless a non-empty `ANYSEARCH_API_KEY` remains set; the environment variable always takes precedence.

```text
/anysearch-status
```

Shows the configuration path and reports only `已配置` (configured) or `匿名模式` (anonymous mode). It does not display the key or a key prefix.

### `postinstall` behavior

The npm package includes a `postinstall` script:

- In an interactive terminal, it may ask for an API key when none is configured. Press Enter to keep using anonymous mode.
- In a non-interactive installation, it skips the prompt and prints setup guidance; installation still succeeds.
- If npm lifecycle scripts are disabled, for example with `npm install --ignore-scripts`, the script does not run.

You can always configure the extension later with `/anysearch-setup` or `ANYSEARCH_API_KEY`.

## Tool reference

### `anysearch_search`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query (one intent, natural language). Whitespace-only values are rejected. |
| `domain` | enum (17 values) | No | Vertical domain for routing: `general`, `resource`, `social_media`, `finance`, `academic`, `legal`, `health`, `business`, `security`, `ip`, `code`, `energy`, `environment`, `agriculture`, `travel`, `film`, `gaming`. Must come from `anysearch_get_sub_domains`. |
| `sub_domain` | string | No | Sub-domain routing key (e.g. `finance.quote`). Required when `domain` is set; must come from `anysearch_get_sub_domains`. |
| `sub_domain_params` | object | No | Structured params from `anysearch_get_sub_domains` (string values). Params marked *required* must always be included—pass an empty string for inapplicable ones; never omit them. |
| `max_results` | integer | No | Number of results, from 1 to 10 (server hard cap). Default: 10. |
| `zone` | `cn` \| `intl` | No | Search region. |
| `language` | string | No | Preferred language, such as `zh-CN` or `en`. |

General search — `query` only:

```json
{ "query": "latest Pi Coding Agent extension documentation", "max_results": 5 }
```

Vertical search — after `anysearch_get_sub_domains({ "domains": ["finance"] })`:

```json
{
  "query": "AAPL",
  "domain": "finance",
  "sub_domain": "finance.quote",
  "sub_domain_params": { "type": "stock", "symbol": "AAPL", "cn_code": "" },
  "max_results": 3
}
```

### `anysearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `queries` | array (1–5 items) | Yes | Each item follows the `anysearch_search` schema (`query` required). One item works as a single search. |

Runs up to 5 independent queries in one call; best for multi-angle research and hybrid general + vertical sweeps. A single failed query does not block the others. Results are grouped per query.

```json
{
  "queries": [
    { "query": "quantum computing breakthroughs" },
    { "query": "QBTS", "domain": "finance", "sub_domain": "finance.quote", "sub_domain_params": { "type": "stock", "symbol": "QBTS", "cn_code": "" } }
  ]
}
```

### `anysearch_extract`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | Yes | Page URL (must start with `http://` or `https://`). HTML pages only; content truncated at 50,000 characters. |

Use when search snippets are too short to answer, when the user provides a URL, or to verify a claim against the original source.

### `anysearch_get_sub_domains`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | enum (17 values) | No* | Single domain to query. |
| `domains` | array of enum (1–5) | No* | Batch of up to 5 domains; takes priority over `domain`. |

\* at least one of `domain` / `domains` is required.

Returns the vertical domain directory (sub-domains with descriptions and parameters, required params marked). Call it before any vertical search—never invent `sub_domain` or `sub_domain_params`. Results are cached per session for the same domain set.

## Returned results

Search results are deduplicated per query before being returned: an item whose normalized URL (scheme, `www`, tracking params, trailing slash, case-insensitive) or normalized title (case/punctuation-insensitive, aggregator site suffixes stripped, >= 12 chars; truncation-prefix matches at >= 20 chars also collapse) matches an earlier item in the same query is dropped, kept items are renumbered, and the `## Search Results` count is rewritten. `anysearch_extract` and `anysearch_get_sub_domains` text passes through untouched.

Each tool returns the AnySearch response text (Markdown) for the agent, plus structured details containing the response `request_id` (when present) and the auth mode (`anonymous` or `configured`). Details never contain the API key. API and network failures are thrown so Pi can mark the tool result as an error; error messages include the `request_id` when the server provides one.

In the TUI, search responses render as the classic numbered list (top 5 when collapsed, full list with snippets when expanded). Other tools (extract, domain directory) render the response text directly, truncated when collapsed.

## Coexisting with `pi-web-access`

This package can be installed alongside [`pi-web-access`](https://github.com/nicobailon/pi-web-access). `pi-anysearch-tools` registers the tool names `anysearch_search`, `anysearch`, `anysearch_extract`, and `anysearch_get_sub_domains`, so it does not replace `pi-web-access` tools such as `web_search`.

Use the AnySearch tools when you want a direct AnySearch entry point (especially for vertical-domain data); keep `pi-web-access` when you also want its broader provider and web-access features.

## Security

- Never commit API keys to Git, source files, examples, or issue reports.
- Prefer `ANYSEARCH_API_KEY` for CI and managed environments.
- The configuration file stores the key locally as plain JSON; protect access to your Pi agent directory.
- Pi extensions execute with the user's permissions. Review the source before installation.
- This extension performs network requests to `https://api.anysearch.com/mcp` when one of the tools is called. It does not make a network request merely by loading the extension.

## Development and verification

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

`npm test` runs two suites with Node's built-in test runner (`node --experimental-strip-types --test test/*.test.ts`):

- `test/anysearch.test.ts` — unit/integration tests with a mocked `fetch`: JSON-RPC request assembly (method, tool name, argument passthrough including `zone`, `language`, and `sub_domain_params`), `max_results` clamping, `isError`/`request_id` error paths, `auto_registered` key parsing, the `get_sub_domains` session cache, and result dedupe (URL/title normalization, per-section scoping, renumbering and count rewrite).
- `test/e2e.test.ts` — end-to-end tests against the real `/mcp` endpoint (anonymous: the agent dir and env key are isolated so no configured key is ever used). Five scenarios: general search, finance vertical search, batch search, `example.com` extraction, and `get_sub_domains` for finance. Each passing scenario stores the raw JSON-RPC response under `.evidence/`; if the network is unreachable the scenarios are skipped with an explicit reason.

For a temporary local Pi run:

```bash
pi -e .
```

## Links

- [GitHub repository](https://github.com/XiaYiHann/pi-anysearch-tools)
- [npm package](https://www.npmjs.com/package/pi-anysearch-tools)
- [Pi package page](https://pi.dev/packages/pi-anysearch-tools)
- [AnySearch documentation](https://www.anysearch.com/docs)
- [Pi Coding Agent](https://pi.dev/)

## License

MIT, as declared in [`package.json`](./package.json).
