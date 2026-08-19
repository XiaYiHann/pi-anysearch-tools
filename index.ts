/**
 * pi-anysearch — AnySearch web search for the Pi coding agent.
 *
 * Registers 4 tools backed by the AnySearch v3 MCP endpoint
 * (https://api.anysearch.com/mcp, JSON-RPC 2.0): anysearch_search (general +
 * vertical domain search), anysearch_batch_search (2-5 parallel queries),
 * anysearch_extract (URL → full-page Markdown) and anysearch_get_sub_domains
 * (vertical domain directory). Anonymous access works out of the box; set
 * ANYSEARCH_API_KEY or add `anysearchApiKey` to <agent dir>/anysearch.json
 * for higher limits and paid quota.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Theme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DOMAINS,
	type AnySearchParams,
	type McpCallResult,
	batchSearchAnySearch,
	extractAnySearch,
	getSubDomainsAnySearch,
	getConfigPath,
	hasApiKey,
	hasBeenPrompted,
	markPrompted,
	searchAnySearch,
	writeApiKey,
} from "./anysearch.ts";

const API_ENDPOINT = "https://api.anysearch.com/mcp";
const SETUP_COMMAND_NAME = "anysearch-setup";
const STATUS_COMMAND_NAME = "anysearch-status";
const SETUP_COMMAND = `/${SETUP_COMMAND_NAME}`;
const ANONYMOUS_MODE_NOTICE =
	`AnySearch 匿名模式：请求受速率和配额限制。运行 ${SETUP_COMMAND} 配置 API key，或设置 ANYSEARCH_API_KEY。`;
const COLLAPSED_CHAR_LIMIT = 2000;
const EXPANDED_SUMMARY_LIMIT = 400;

type ToolResultLike = {
	content: Array<{ type: string; text?: string }>;
	details?: AnySearchToolDetails;
};
type RenderResultOptions = { expanded: boolean; isPartial: boolean };
type RenderResultContext = { isError?: boolean };

interface AnySearchToolDetails {
	text: string;
	isError: boolean;
	requestId?: string;
	mode: "anonymous" | "configured";
	autoRegisteredApiKey?: string;
}

/** Shared typebox shape for the search tool and each batch_search item. */
const SEARCH_ITEM_PARAMETERS = {
	query: Type.String({ minLength: 1, pattern: "\\S", description: "Search query (one intent only, natural language)" }),
	domain: Type.Optional(
		StringEnum([...DOMAINS] as const, {
			description: "Vertical domain for routing (Path 2). Omit for general search. Must come from anysearch_get_sub_domains.",
		}),
	),
	sub_domain: Type.Optional(
		Type.String({
			description: "Sub-domain routing key (e.g. finance.quote). Required when domain is set; must come from anysearch_get_sub_domains.",
		}),
	),
	sub_domain_params: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Structured params from anysearch_get_sub_domains (object of string values). Required params must always be included — use an empty string for inapplicable ones, never omit them.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Number of results to return (1-10, default 10)" }),
	),
	zone: Type.Optional(
		StringEnum(["cn", "intl"] as const, { description: 'Region for the search: "cn" or "intl"' }),
	),
	language: Type.Optional(Type.String({ description: "Preferred language, e.g. zh-CN or en" })),
};
const SEARCH_PARAMETERS = Type.Object({
	query: SEARCH_ITEM_PARAMETERS.query,
	domain: SEARCH_ITEM_PARAMETERS.domain,
	sub_domain: SEARCH_ITEM_PARAMETERS.sub_domain,
	sub_domain_params: SEARCH_ITEM_PARAMETERS.sub_domain_params,
	max_results: SEARCH_ITEM_PARAMETERS.max_results,
	zone: SEARCH_ITEM_PARAMETERS.zone,
	language: SEARCH_ITEM_PARAMETERS.language,
});

const BATCH_SEARCH_PARAMETERS = Type.Object({
	queries: Type.Array(
		Type.Object(SEARCH_ITEM_PARAMETERS),
		{ minItems: 1, maxItems: 5, description: "1-5 search requests (one item = single search); one failure does not block the others" },
	),
});

const EXTRACT_PARAMETERS = Type.Object({
	url: Type.String({
		pattern: "^https?://",
		minLength: 8,
		description: "Page URL to fetch (must start with http:// or https://). HTML pages only; content truncated at 50,000 characters.",
	}),
});

const SUB_DOMAINS_PARAMETERS = Type.Object({
	domain: Type.Optional(
		StringEnum([...DOMAINS] as const, {
			description: "Single domain to query (used only when domains is not given)",
		}),
	),
	domains: Type.Optional(
		Type.Array(StringEnum([...DOMAINS] as const), {
			minItems: 1,
			maxItems: 5,
			description: "Batch of up to 5 domains (takes priority over domain). Prefer this when unsure which domain fits.",
		}),
	),
});

const SEARCH_DESCRIPTION =
	`Direct web search via AnySearch (${API_ENDPOINT}) returning ranked results as Markdown. ` +
	"Two paths: (1) general — query only; (2) vertical — domain + sub_domain + sub_domain_params for structured " +
	"data (stock quotes, academic papers, legal cases, flights, drugs, code docs, weather, …). For vertical search, " +
	"call anysearch_get_sub_domains FIRST to discover valid sub_domain and params — never guess them; pass required " +
	"params as empty strings when inapplicable. Strong for fresh facts, news, prices, and Chinese/regional content " +
	"(zone \"cn\" with language \"zh-CN\"). Prefer web_search for comprehensive multi-provider research. " +
	"Anonymous access works without an API key but is subject to rate and quota limits.";
const ANYSEARCH_DESCRIPTION =
	`Search the web via AnySearch (${API_ENDPOINT}): 1-5 queries in a single call — a single query or a ` +
	"parallel batch. Each item follows the search schema (query required; domain/sub_domain/sub_domain_params " +
	"optional, from anysearch_get_sub_domains — never invent them, and pass required params as empty strings). " +
	"Best for multi-angle research and hybrid general+vertical queries; a single failed query does not block " +
	"the others. Returns ranked results grouped per query, as Markdown. Strong for fresh facts, news, prices, " +
	"and Chinese/regional content (zone \"cn\" with language \"zh-CN\"). Prefer web_search for comprehensive " +
	"multi-provider research. Anonymous access works without an API key but is subject to rate and quota limits.";
const EXTRACT_DESCRIPTION =
	"Fetch a URL and return its full content as clean Markdown via AnySearch (HTML pages only; truncated at " +
	"50,000 characters). Use when search snippets are too short to answer, when the user provides a URL, or to " +
	"verify a claim against the original source.";
const SUB_DOMAINS_DESCRIPTION =
	"Query the AnySearch vertical domain directory. REQUIRED before any vertical (domain-routed) search: returns " +
	"available sub_domains with descriptions and parameters (marked required) for the given domain(s). Results are " +
	"cached per session — do not call repeatedly for the same domain set.";
const PROMPT_SNIPPET =
	"Search the web via AnySearch — general or vertical-domain search, parallel batch queries, and full-page URL extraction; complements web_search";
const PROMPT_GUIDELINES = [
	`Use anysearch_search for single-query lookups (zone "cn" + language "zh-CN" for Chinese/regional content). For vertical topics (stock prices, papers, legal cases, flights, drugs, code docs, weather, …) call anysearch_get_sub_domains first, then pass its domain/sub_domain/sub_domain_params — never invent them, and pass required params as empty strings when inapplicable.`,
	"Use anysearch for 1-5 queries in one call — a single query, multi-angle research, or a hybrid general+vertical sweep.",
	"Use anysearch_extract for full-page Markdown when snippets are insufficient or the user provides a URL.",
	"Prefer web_search for comprehensive or multi-angle research, multi-provider fan-out, interactive curation, or workflows combined with fetch_content, source_check, or get_search_content.",
];

function claimAnonymousModeReminder(): boolean {
	try {
		if (hasApiKey() || hasBeenPrompted()) return false;
		markPrompted();
		return true;
	} catch {
		// Reminder bookkeeping must never block extension startup or a real search.
		return false;
	}
}

function resultText(result: ToolResultLike): string {
	return result.content
		.map((item) => (item.type === "text" ? (item.text ?? "") : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

interface ParsedSearchResult {
	title: string;
	url: string;
	summary: string;
}

interface ParsedSearchSection {
	label?: string;
	meta?: string;
	items: ParsedSearchResult[];
	note?: string;
}

/**
 * Parse /mcp search Markdown into per-query sections for the TUI.
 * Recognized structure: "## Query N: ..." sections (batch), a
 * "## Search Results (n results, Xms)" header, and "### n. Title" /
 * "- **URL**: ..." items. Returns undefined for non-listing text
 * (extract, domain directory, free-form error text) — callers fall
 * back to raw text.
 */
export function parseSearchMarkdown(text: string): ParsedSearchSection[] | undefined {
	const sections: ParsedSearchSection[] = [];
	let section: ParsedSearchSection | null = null;
	let item: ParsedSearchResult | null = null;
	const ensureSection = (): ParsedSearchSection => {
		if (!section) {
			section = { items: [] };
			sections.push(section);
		}
		return section;
	};
	for (const line of text.split("\n")) {
		const labelMatch = line.match(/^## (Query \d+[:：].*)$/);
		if (labelMatch) {
			section = { label: labelMatch[1].trim(), items: [] };
			sections.push(section);
			item = null;
			continue;
		}
		const metaMatch = line.match(/^## Search Results \(([^)]*)\)/);
		if (metaMatch) {
			ensureSection().meta = metaMatch[1].trim();
			item = null;
			continue;
		}
		const itemMatch = line.match(/^### \d+\.\s*(.*)$/);
		if (itemMatch) {
			const target = ensureSection();
			item = { title: itemMatch[1].trim(), url: "", summary: "" };
			target.items.push(item);
			continue;
		}
		if (item) {
			const urlMatch = line.match(/^\s*-\s*\*\*URL\*\*:\s*(.*)$/);
			if (urlMatch) {
				item.url = urlMatch[1].trim();
				continue;
			}
			const content = line.replace(/^\s*-\s*/, "").trim();
			if (content) {
				item.summary = item.summary ? `${item.summary} ${content}` : content;
				if (item.summary.length > 1500) item.summary = item.summary.slice(0, 1500);
			}
			continue;
		}
		if (section && line.trim() && !/^#{1,3} /.test(line)) {
			// Section-level text outside items (e.g. a per-query error).
			section.note = section.note ? `${section.note} ${line.trim()}` : line.trim();
			if (section.note.length > 200) section.note = section.note.slice(0, 200);
		}
	}
	return sections.some((s) => s.items.length > 0) ? sections : undefined;
}

interface ParsedExtractMeta {
	source?: string;
	title?: string;
}

/**
 * Pull the source URL and page title out of /mcp extract text. The server
 * format: optional "> **External page content (untrusted):** ..." warning,
 * "## <title>" heading, "**Source**: <url>" line. Returns an empty object
 * when nothing matches.
 */
export function parseExtractMeta(text: string): ParsedExtractMeta {
	const meta: ParsedExtractMeta = {};
	for (const line of text.split("\n")) {
		if (!meta.source) {
			const sourceMatch = line.match(/^\*\*Source\*\*:\s*(\S+)/);
			if (sourceMatch) meta.source = sourceMatch[1];
		}
		if (!meta.title) {
			const titleMatch = line.match(/^#{1,6}\s+(\S.*)$/);
			if (titleMatch && !line.startsWith(">")) meta.title = titleMatch[1].trim();
		}
		if (meta.source && meta.title) break;
	}
	return meta;
}

interface ParsedDomainDirectory {
	domain: string;
	count?: string;
	subDomains: string[];
}

/**
 * Parse the get_sub_domains directory Markdown ("## <domain> Domain
 * Capabilities (N available)" sections with "### <sub_domain>" entries) into
 * compact sections. Returns undefined when the shape is not recognized so
 * callers can fall back to raw text.
 */
export function parseDomainDirectory(text: string): ParsedDomainDirectory[] | undefined {
	const sections: ParsedDomainDirectory[] = [];
	let current: ParsedDomainDirectory | null = null;
	for (const line of text.split("\n")) {
		const domainMatch = line.match(/^## (\w+) Domain Capabilities \((\d+) available\)/);
		if (domainMatch) {
			current = { domain: domainMatch[1], count: domainMatch[2], subDomains: [] };
			sections.push(current);
			continue;
		}
		const subMatch = line.match(/^### (\S+)/);
		if (subMatch && current) current.subDomains.push(subMatch[1]);
	}
	return sections.some((s) => s.subDomains.length > 0) ? sections : undefined;
}

/** Surface an auto_registered API key: confirm via UI, then persist with writeApiKey. */
async function handleAutoRegistered(result: McpCallResult, ctx: ExtensionContext): Promise<string> {
	if (!result.autoRegisteredApiKey) return "";
	const key = result.autoRegisteredApiKey;
	const preview = `${key.slice(0, 12)}…`;
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"AnySearch 检测到新的 API key（auto_registered，配额自动注册）",
			`保存这个 key 到 ${getConfigPath()} 吗？（${preview}）`,
		);
		if (ok) {
			try {
				writeApiKey(key);
				ctx.ui.notify(`AnySearch API key 已保存（${preview}）。`, "info");
				return `\n\n[已保存 auto-registered API key（${preview}）到 ${getConfigPath()}]`;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`保存失败：${message}`, "error");
				return `\n\n[auto-registered API key 保存失败：${message}]`;
			}
		}
		return (
			`\n\n[未保存 auto-registered API key（${preview}）。` +
			"后续可从 AnySearch dashboard 获取新 key，或运行 " +
			`${SETUP_COMMAND} 保存，或设置 ANYSEARCH_API_KEY。]`
		);
	}
	return (
		`\n\n[提示] AnySearch 返回了 auto-registered API key（${preview}）。` +
		`运行 ${SETUP_COMMAND} 保存 key，或设置 ANYSEARCH_API_KEY。`
	);
}

function makeRenderResult(toolLabel: string, kind: "search" | "domains" | "extract") {
	return (
		result: ToolResultLike,
		{ expanded, isPartial }: RenderResultOptions,
		theme: Theme,
		context: RenderResultContext,
	) => {
		if (isPartial) {
			return new Text(theme.fg("warning", `${toolLabel} is running…`), 0, 0);
		}
		const text = resultText(result);
		if (context.isError || result.details?.isError) {
			return new Text(
				theme.fg("error", text ? `${toolLabel} error: ${text}` : `${toolLabel} failed.`),
				0,
				0,
			);
		}
		if (!text) {
			return new Text(theme.fg("warning", `${toolLabel} returned no content.`), 0, 0);
		}
		const mode = result.details?.mode === "configured" ? "configured" : "anonymous";
		const requestId = result.details?.requestId ? ` · request_id: ${result.details.requestId}` : "";
		const footer = theme.fg("dim", `mode: ${mode}${requestId}`);
		if (kind === "extract" && !expanded && text.length > COLLAPSED_CHAR_LIMIT) {
			const meta = parseExtractMeta(text);
			let host = "";
			try {
				host = new URL(meta.source ?? "").hostname;
			} catch {
				/* non-URL source */
			}
			const headerLine = theme.fg(
				"toolTitle",
				theme.bold(`AnySearch Extract${host ? ` · ${host}` : ""}`),
			);
			const lines: string[] = [];
			if (meta.title) lines.push(theme.fg("accent", meta.title));
			lines.push(theme.fg("dim", `… ${text.length.toLocaleString("en-US")} chars of page content (expand to view full content)`));
			lines.push(footer);
			return new Text(`${headerLine}\n${lines.join("\n")}`, 0, 0);
		}
		if (kind === "domains") {
			const domains = parseDomainDirectory(text);
			if (domains) {
				const total = domains.reduce((n, d) => n + d.subDomains.length, 0);
				const headerLine = theme.fg(
					"toolTitle",
					theme.bold(`AnySearch Domains · ${domains.length} domain(s), ${total} sub-domains`),
				);
				if (expanded) {
					return new Text(`${headerLine}\n${text}\n${footer}`, 0, 0);
				}
				const lines = domains.map(
					(d) =>
						`${theme.fg("toolTitle", theme.bold(`▸ ${d.domain} (${d.count ?? d.subDomains.length})`))} ${theme.fg("accent", d.subDomains.join(", "))}`,
				);
				return new Text(`${headerLine}\n${lines.join("\n")}\n${footer}`, 0, 0);
			}
		}
		const parsed = kind === "extract" ? undefined : parseSearchMarkdown(text);
		if (parsed) {
			const total = parsed.reduce((n, s) => n + s.items.length, 0);
			if (total > 0 || parsed.some((s) => s.note)) {
				const multi = parsed.length > 1;
				let singleMeta = "";
				if (!multi && parsed[0].meta) {
					// The count is already in the header; keep only the timing part.
					const rest = parsed[0].meta.split(",").slice(1).join(",").trim();
					singleMeta = rest ? ` (${rest})` : "";
				}
				const header = theme.fg(
					"toolTitle",
					theme.bold(
						multi
							? `${toolLabel} · ${total} results in ${parsed.length} queries`
							: `${toolLabel} · ${total} results${singleMeta}`,
					),
				);
				const lines: string[] = [];
				for (const section of parsed) {
					if (section.label) {
						lines.push(
							theme.fg("toolTitle", theme.bold(`▸ ${section.label}`)) +
							(section.meta ? theme.fg("dim", ` (${section.meta})`) : ""),
						);
					}
					section.items.forEach((itemResult, index) => {
						let line = `${theme.fg("dim", `${index + 1}.`)} ${
							itemResult.title ? theme.fg("accent", itemResult.title) : theme.fg("muted", "(untitled)")
						}`;
						if (expanded) {
							if (itemResult.url) line += `\n   ${theme.fg("dim", itemResult.url)}`;
							if (itemResult.summary) {
								const summary =
									itemResult.summary.length > EXPANDED_SUMMARY_LIMIT
										? `${itemResult.summary.slice(0, EXPANDED_SUMMARY_LIMIT)}…`
										: itemResult.summary;
								line += `\n   ${theme.fg("muted", summary)}`;
							}
						}
						lines.push(line);
					});
					if (section.items.length === 0 && section.note) {
						lines.push(theme.fg("muted", section.note));
					}
				}
				lines.push(footer);
				return new Text(`${header}\n${lines.join("\n")}`, 0, 0);
			}
		}
		if (expanded || text.length <= COLLAPSED_CHAR_LIMIT) {
			return new Text(`${text}\n\n${footer}`, 0, 0);
		}
		const collapsed = text.slice(0, COLLAPSED_CHAR_LIMIT).replace(/\s+\S*$/, "");
		return new Text(`${collapsed}\n… (truncated, expand to view ${text.length - COLLAPSED_CHAR_LIMIT} more chars)\n${footer}`, 0, 0);
	};
}

export default function anysearchExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof SEARCH_PARAMETERS, AnySearchToolDetails | undefined>({
		name: "anysearch_search",
		label: "AnySearch Search",
		description: SEARCH_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: SEARCH_PARAMETERS,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const response = await searchAnySearch(params as AnySearchParams, signal);
			const suffix = claimAnonymousModeReminder()
				? `\n\n[提示] ${ANONYMOUS_MODE_NOTICE}`
				: "";
			const autoNote = await handleAutoRegistered(response, ctx);
			return {
				content: [{ type: "text", text: response.text + suffix + autoNote }],
				details: {
					text: response.text,
					isError: response.isError,
					...(response.requestId ? { requestId: response.requestId } : {}),
					mode: hasApiKey() ? "configured" : "anonymous",
					...(response.autoRegisteredApiKey ? { autoRegisteredApiKey: response.autoRegisteredApiKey } : {}),
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("anysearch_search"));
			text += theme.fg("accent", ` 「${args.query}」`);
			const opts: string[] = [];
			if (args.domain) opts.push(`domain=${args.domain}`);
			if (args.sub_domain) opts.push(`sub_domain=${args.sub_domain}`);
			if (args.max_results !== undefined) opts.push(`max_results=${args.max_results}`);
			if (args.zone) opts.push(`zone=${args.zone}`);
			if (args.language) opts.push(`lang=${args.language}`);
			if (opts.length > 0) text += theme.fg("dim", ` (${opts.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult: makeRenderResult("AnySearch"),
	});

	pi.registerTool<typeof BATCH_SEARCH_PARAMETERS, AnySearchToolDetails | undefined>({
		name: "anysearch",
		label: "AnySearch",
		description: ANYSEARCH_DESCRIPTION,
		parameters: BATCH_SEARCH_PARAMETERS,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const response = await batchSearchAnySearch(params.queries as AnySearchParams[], signal);
			const suffix = claimAnonymousModeReminder() ? `\n\n[提示] ${ANONYMOUS_MODE_NOTICE}` : "";
			const autoNote = await handleAutoRegistered(response, ctx);
			return {
				content: [{ type: "text", text: response.text + suffix + autoNote }],
				details: {
					text: response.text,
					isError: response.isError,
					...(response.requestId ? { requestId: response.requestId } : {}),
					mode: hasApiKey() ? "configured" : "anonymous",
					...(response.autoRegisteredApiKey ? { autoRegisteredApiKey: response.autoRegisteredApiKey } : {}),
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("anysearch"));
			text += theme.fg("accent", ` (${args.queries.length} queries)`);
			const first = args.queries[0]?.query;
			if (first) text += theme.fg("dim", ` 「${first}${args.queries.length > 1 ? "…" : ""}」`);
			return new Text(text, 0, 0);
		},

		renderResult: makeRenderResult("AnySearch"),
	});

	pi.registerTool<typeof EXTRACT_PARAMETERS, AnySearchToolDetails | undefined>({
		name: "anysearch_extract",
		label: "AnySearch Extract",
		description: EXTRACT_DESCRIPTION,
		parameters: EXTRACT_PARAMETERS,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const response = await extractAnySearch(params.url, signal);
			const autoNote = await handleAutoRegistered(response, ctx);
			return {
				content: [{ type: "text", text: response.text + autoNote }],
				details: {
					text: response.text,
					isError: response.isError,
					...(response.requestId ? { requestId: response.requestId } : {}),
					mode: hasApiKey() ? "configured" : "anonymous",
					...(response.autoRegisteredApiKey ? { autoRegisteredApiKey: response.autoRegisteredApiKey } : {}),
				},
			};
		},

		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("anysearch_extract")) + theme.fg("dim", ` ${args.url}`);
			return new Text(text, 0, 0);
		},

		renderResult: makeRenderResult("AnySearch Extract", "extract"),
	});

	pi.registerTool<typeof SUB_DOMAINS_PARAMETERS, AnySearchToolDetails | undefined>({
		name: "anysearch_get_sub_domains",
		label: "AnySearch Sub-Domains",
		description: SUB_DOMAINS_DESCRIPTION,
		parameters: SUB_DOMAINS_PARAMETERS,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const response = await getSubDomainsAnySearch(
				{ domain: params.domain, domains: params.domains },
				signal,
			);
			const autoNote = await handleAutoRegistered(response, ctx);
			return {
				content: [{ type: "text", text: response.text + autoNote }],
				details: {
					text: response.text,
					isError: response.isError,
					...(response.requestId ? { requestId: response.requestId } : {}),
					mode: hasApiKey() ? "configured" : "anonymous",
					...(response.autoRegisteredApiKey ? { autoRegisteredApiKey: response.autoRegisteredApiKey } : {}),
				},
			};
		},

		renderCall(args, theme) {
			const domains = args.domains ?? (args.domain ? [args.domain] : []);
			const text =
				theme.fg("toolTitle", theme.bold("anysearch_get_sub_domains")) +
				theme.fg("accent", ` (${domains.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult: makeRenderResult("AnySearch domains", "domains"),
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !claimAnonymousModeReminder()) return;
		ctx.ui.notify(ANONYMOUS_MODE_NOTICE, "warning");
	});

	pi.registerCommand(SETUP_COMMAND_NAME, {
		description: "交互式配置 AnySearch API key（写入 " + getConfigPath() + "）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`${SETUP_COMMAND} 需要交互式终端（TUI）。也可设置环境变量 ANYSEARCH_API_KEY。`, "warning");
				return;
			}

			const key = await ctx.ui.input("AnySearch API key（留空取消）:", "as_sk_...");
			if (!key || !key.trim()) {
				ctx.ui.notify("已取消，继续使用匿名模式。", "info");
				return;
			}
			const trimmed = key.trim();
			if (!trimmed.startsWith("as_sk_")) {
				const ok = await ctx.ui.confirm("确认保存？", "输入的 key 不以 as_sk_ 开头，仍要保存吗？");
				if (!ok) {
					ctx.ui.notify("已取消。", "info");
					return;
				}
			}

			try {
				writeApiKey(trimmed);
				ctx.ui.notify(`AnySearch API key 已保存，搜索工具现在使用已配置的配额。`, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`保存失败：${message}`, "error");
			}
		},
	});

	pi.registerCommand(STATUS_COMMAND_NAME, {
		description: "查看 AnySearch 认证状态与配置路径",
		handler: async (_args, ctx) => {
			const status = hasApiKey() ? "已配置" : "匿名模式";
			ctx.ui.notify(`AnySearch：${status} · 配置：${getConfigPath()}`, "info");
		},
	});
}
