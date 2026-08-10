# pi-anysearch-tools

[![npm](https://img.shields.io/npm/v/pi-anysearch-tools)](https://www.npmjs.com/package/pi-anysearch-tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

`pi-anysearch-tools` is a [Pi Coding Agent](https://pi.dev/) extension that adds the `anysearch_search` tool. It searches fresh, external web information through the AnySearch API:

```text
POST https://api.anysearch.com/v1/search
```

Use it for current documentation, news, prices, products, people, comparisons, fact-checking, and other information that may not be available in the model's training data. It is a web-search tool—not a replacement for Pi's local file or shell tools.

> 中文说明：这是一个面向 Pi Coding Agent 的 AnySearch 联网搜索扩展。无需 API key 也可匿名使用，但匿名请求受速率和配额限制。

## Core capabilities

- Ranked web results with titles, URLs, and snippets.
- Optional cleaned page content with `include_content: true`.
- Region, language, vertical-search tag, and provider-specific parameter support.
- Anonymous access without initial configuration.
- Optional API-key authentication from an environment variable or Pi agent configuration.
- Compact Pi TUI rendering, with summaries available in expanded mode.

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
> ~/.pi/agent/anysearch.json
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
| `query` | string | Yes | Non-empty web search query. Whitespace-only values are rejected. |
| `max_results` | integer | No | Number of results, from 1 to 20. Default: 10. |
| `tag` | string | No | Vertical capability tag such as `code.doc` or `news`. |
| `zone` | `cn` \| `intl` | No | Search region. |
| `language` | string | No | Preferred language, such as `zh-CN` or `en`. |
| `params` | object | No | Extra AnyMix parameters, such as `{"ticker":"AAPL"}`. |
| `include_content` | boolean | No | Include cleaned page content. This produces a substantially larger response. |

Example tool arguments:

```json
{
  "query": "latest Pi Coding Agent extension documentation",
  "max_results": 5,
  "zone": "intl",
  "language": "en",
  "include_content": false
}
```

## Returned results

The tool returns numbered text for the agent. Each result contains:

1. title;
2. URL;
3. snippet, when available;
4. cleaned page content only when `include_content` is `true`.

Structured result details also contain the result list, API metadata, and an `apiKeyUsed` boolean. They never contain the API key. API and network failures are thrown so Pi can mark the tool result as an error.

In the TUI, the default view stays compact. Expanding the tool result shows snippets, but the renderer does not repeat full page bodies.

## Coexisting with `pi-web-access`

This package can be installed alongside [`pi-web-access`](https://github.com/nicobailon/pi-web-access). `pi-anysearch-tools` registers the distinct tool name `anysearch_search`, so it does not replace `pi-web-access` tools such as `web_search`.

Use `anysearch_search` when you want a direct AnySearch entry point; keep `pi-web-access` when you also want its broader provider and web-access features.

## Security

- Never commit API keys to Git, source files, examples, or issue reports.
- Prefer `ANYSEARCH_API_KEY` for CI and managed environments.
- The configuration file stores the key locally as plain JSON; protect access to your Pi agent directory.
- Pi extensions execute with the user's permissions. Review the source before installation.
- This extension performs network requests to `https://api.anysearch.com/v1/search` when `anysearch_search` is called. It does not make a network request merely by loading the extension.

## Development and verification

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

For a temporary local Pi run:

```bash
pi -e .
```

## Links

- [GitHub repository](https://github.com/XiaYiHann/pi-anysearch-tools)
- [npm package](https://www.npmjs.com/package/pi-anysearch-tools)
- [Pi package page](https://pi.dev/packages/pi-anysearch-tools)
- [AnySearch Search API documentation](https://www.anysearch.com/docs#search-api)
- [Pi Coding Agent](https://pi.dev/)

## License

MIT, as declared in [`package.json`](./package.json).
