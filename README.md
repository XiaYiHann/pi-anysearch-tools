# pi-anysearch-tools

[![npm](https://img.shields.io/npm/v/pi-anysearch-tools)](https://www.npmjs.com/package/pi-anysearch-tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

`pi-anysearch-tools` is a [Pi Coding Agent](https://pi.dev/) extension that adds four AnySearch search tools, backed by the official AnySearch v3 endpoints:

```text
POST https://api.anysearch.com/v1/search  (search, JSON summaries)
POST https://api.anysearch.com/mcp        (extract and capability discovery)
```

Use it for current documentation, news, prices, products, people, comparisons, fact-checking, vertical-domain data (stocks, papers, legal cases, flights, drugs, code docs, weather, …), and full-page URL extraction—information that may not be available in the model's training data. These are web-search tools, not replacements for Pi's local file or shell tools.

> 中文说明：这是一个面向 Pi Coding Agent 的 AnySearch 联网搜索扩展（官方 v3 混合接口：搜索走 /v1/search JSON，抽取/能力发现走 /mcp）。无需 API key 也可匿名使用，但匿名请求受速率和配额限制。

## Core capabilities

- General web search as bounded Markdown (title, URL, and short snippet only — 500 chars per result, 12,000 chars total final cap including notices; use `anysearch_extract` for full page content).
- Vertical domain search via `domain` / `sub_domain` / `sub_domain_params` (17 domains).
- Parallel batch search: 1–5 queries in one call (1–5 accepted, 2–3 recommended); omitted `max_results` defaults to 3 per query; up to 5×10 supported but heavy — 12k cap keeps context bounded; a single failure does not block the rest.
- Full-page URL extraction as clean Markdown (server-truncated at 50,000 characters) — escalation path when snippets are insufficient.
- Vertical domain directory discovery (`anysearch_get_sub_domains`), cached per session.
- Region (`zone`) and language passthrough; `max_results` clamped to the server cap of 1–10 (single default 5, batch default 3 per query).
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
| `max_results` | integer | No | Number of results, from 1 to 10 (server hard cap). Default: 5. Snippets capped at 500 chars, total 12,000 chars final cap including notices; use `anysearch_extract` for full page. Explicit 5×10 still accepted but heavy — prefer 3 for batch. |
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
| `queries` | array (1–5 items) | Yes | Each item follows the `anysearch_search` schema (`query` required; omitted `max_results` defaults to 3 per query). One item works as a single search. 1–5 accepted, 2–3 recommended. |

Runs up to 5 independent queries in one call (1–5 accepted, 2–3 recommended); best for multi-angle research and hybrid general + vertical sweeps. Each query returns title, URL, and short snippet only (500 chars per result, 12,000 chars total final cap including notices; use `anysearch_extract` for full page). Up to 5×10 supported but heavy — prefer 3 per query. A single failed query does not block the others. Results are grouped per query.

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
| `domains` | array of enum (1–5) | No* | Batch of up to 5 domains; takes priority over `domain`. Prefer one domain per call to keep context small. |

\* at least one of `domain` / `domains` is required.

Returns the vertical domain directory (sub-domains with descriptions and parameters, required params marked). Call it before any vertical search—never invent `sub_domain` or `sub_domain_params`. Results are cached per session for the same domain set.

## Returned results

Search uses `POST https://api.anysearch.com/v1/search` (JSON summaries) and returns only bounded Markdown: title, URL, and short snippet only (500 chars per result, whitespace-normalized). The REST `content` field is discarded before the Pi tool result is built: it is absent from both model-facing `content` and persisted `details`. Single-search default is 5 results; batch per-query default is 3 (explicit 1–10 still accepted; up to 5×10 supported but heavy). Batch output is fairly allocated per query and capped at 12,000 characters total. The final Pi tool content — including anonymous and auto-registration notices — is also capped at 12,000 characters (`boundSearchToolText` truncates with `…`); `details.text` is kept consistent with the content sent to the model. Use `anysearch_extract` (`POST https://api.anysearch.com/mcp`) for full page content when snippets are insufficient.

Search results are deduplicated before being returned — high-duplication items are filtered out and never reach the agent's context (structured dedupe; batch dedupes globally across queries). An item is dropped when its normalized URL (scheme, `www`, tracking params, trailing slash, case-insensitive) matches an earlier item, OR its normalized title (case/punctuation-insensitive, leading arXiv id stripped, >= 12 chars) is >= 0.85 similar to an earlier title (char-bigram overlap; empirical split: real duplicates >= 0.93, distinct papers <= 0.72). Kept items are renumbered, and the `## Search Results` count is rewritten. `anysearch_extract` and `anysearch_get_sub_domains` text passes through untouched (via `POST https://api.anysearch.com/mcp`).

Each tool returns the AnySearch response text (Markdown) for the agent, plus structured details containing the response `request_id` (when present) and the auth mode (`anonymous` or `configured`). Details never contain the API key. `details.text` equals the final bounded content sent to the model (12,000-char cap including notices). API and network failures are thrown so Pi can mark the tool result as an error; error messages include the `request_id` when the server provides one.

In the TUI, search responses render as the classic numbered list (top 5 when collapsed, full list with snippets when expanded). Other tools (extract, domain directory) render the response text directly, truncated when collapsed.

## Coexisting with `pi-web-access`

This package can be installed alongside [`pi-web-access`](https://github.com/nicobailon/pi-web-access). `pi-anysearch-tools` registers the tool names `anysearch_search`, `anysearch`, `anysearch_extract`, and `anysearch_get_sub_domains`, so it does not replace `pi-web-access` tools such as `web_search`.

Use the AnySearch tools when you want a direct AnySearch entry point (especially for vertical-domain data); keep `pi-web-access` when you also want its broader provider and web-access features.

## Security

- Never commit API keys to Git, source files, examples, or issue reports.
- Prefer `ANYSEARCH_API_KEY` for CI and managed environments.
- The configuration file stores the key locally as plain JSON; protect access to your Pi agent directory.
- Pi extensions execute with the user's permissions. Review the source before installation.
- This extension performs network requests to `https://api.anysearch.com/v1/search` (search) and `https://api.anysearch.com/mcp` (extract and capability discovery) when one of the tools is called. It does not make a network request merely by loading the extension.

## Development and verification

```bash
npm install --ignore-scripts
npm test
ANYSEARCH_E2E_API_KEY=as_sk_... npm run test:e2e  # optional real endpoints
npm pack --dry-run
```

`npm test` runs the deterministic mocked-fetch suite; real network checks are explicit so quota, registration, and connectivity cannot make the default test command flaky:

- `test/anysearch.test.ts` — unit/integration tests with a mocked `fetch`: REST `POST https://api.anysearch.com/v1/search` request assembly (`format:"json"`, `tag`/`params` mapping, `zone`/`language` passthrough), `max_results` clamping (single default 5, batch default 3 per query), 500-char snippet cap, 12,000-char final cap including notices (`boundSearchToolText`), `isError`/`request_id` error paths, `auto_registered` key parsing, the `get_sub_domains` session cache, and result dedupe (URL/title normalization, per-section scoping, renumbering and count rewrite, global cross-query dedupe, fair per-query allocation).
- `test/e2e.test.ts` — explicit end-to-end tests against the real hybrid endpoints (`POST https://api.anysearch.com/v1/search` for search/batch, `POST https://api.anysearch.com/mcp` for extract/domain). It uses `ANYSEARCH_E2E_API_KEY` when provided and otherwise runs anonymously, while isolating the Pi agent directory so tests never read or write user configuration. Five scenarios cover general search, finance vertical search, batch search, `example.com` extraction, and `get_sub_domains` for finance. Each passing scenario stores the raw response under `.evidence/`; unreachable networks are skipped with an explicit reason.

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
