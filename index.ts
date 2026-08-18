/**
 * pi-anysearch — AnySearch web search for the Pi coding agent.
 *
 * Registers the `anysearch_search` tool, backed by the AnySearch unified
 * search API (https://www.anysearch.com/docs#search-api). Anonymous access
 * works out of the box; set ANYSEARCH_API_KEY or add `anysearchApiKey` to
 * <agent dir>/anysearch.json for higher limits and paid quota.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	getConfigPath,
	hasApiKey,
	hasBeenPrompted,
	markPrompted,
	searchAnySearch,
	writeApiKey,
} from "./anysearch.ts";

const TOOL_NAME = "anysearch_search";
const TOOL_LABEL = "AnySearch Search";
const API_ENDPOINT = "https://api.anysearch.com/v1/search";
const SETUP_COMMAND_NAME = "anysearch-setup";
const STATUS_COMMAND_NAME = "anysearch-status";
const SETUP_COMMAND = `/${SETUP_COMMAND_NAME}`;
const ANONYMOUS_MODE_NOTICE =
	`AnySearch 匿名模式：请求受速率和配额限制。运行 ${SETUP_COMMAND} 配置 API key，或设置 ANYSEARCH_API_KEY。`;
const TOOL_DESCRIPTION =
	`Direct web search via AnySearch (${API_ENDPOINT}) returning high-quality ranked results with clean snippets. ` +
	"Complements web_search: strong for single-query lookups — " +
	"fresh facts, news, prices and stocks (tag \"news\" or params like {\"ticker\": \"AAPL\"}), weather, " +
	"and Chinese/regional content (zone \"cn\" with language \"zh-CN\"). " +
	"Prefer web_search for comprehensive research, multi-angle queries, multi-provider fan-out, or interactive curation. " +
	"Do not use it to search local files or perform shell operations. " +
	"Returns ranked titles, URLs, and snippets; include_content=true also includes cleaned page content and produces a much larger response. " +
	"Anonymous access works without an API key but is subject to rate and quota limits.";
const PROMPT_SNIPPET =
	"Search the web via AnySearch — direct single-query lookups with ranked results (news, prices, stocks, weather, Chinese/regional, vertical tags); complements web_search";
const PROMPT_GUIDELINES = [
	`Use ${TOOL_NAME} for direct single-query web lookups — fresh facts, news, prices, weather, and Chinese/regional queries (zone "cn", language "zh-CN") — it complements web_search rather than replacing it.`,
	`Prefer web_search for comprehensive or multi-angle research, multi-provider fan-out, interactive curation, or workflows combined with fetch_content, source_check, or get_search_content.`,
	`When using ${TOOL_NAME}, set zone/language for regional queries and use include_content=true only when full page text is needed because it produces a much larger response.`,
];
const COLLAPSED_RESULT_LIMIT = 5;

const SEARCH_PARAMETERS = Type.Object({
	query: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "Non-empty web search query",
	}),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 20,
			description: "Number of results to return (1-20, default 10)",
		}),
	),
	tag: Type.Optional(
		Type.String({
			description:
				'Sub-domain capability tag such as "code.doc" or "news" that routes the query to a specialized data source. See AnySearch docs for available tags.',
		}),
	),
	zone: Type.Optional(
		StringEnum(["cn", "intl"] as const, {
			description: 'Region for the search: "cn" or "intl"',
		}),
	),
	language: Type.Optional(
		Type.String({
			description: "Preferred language, e.g. zh-CN or en",
		}),
	),
	params: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: 'Extended parameters passed through to AnyMix, e.g. {"ticker": "AAPL"}',
		}),
	),
	include_content: Type.Optional(
		Type.Boolean({
			description: "Include cleaned-up page body content in each result (larger response)",
		}),
	),
});

type AnySearchToolDetails = Awaited<ReturnType<typeof searchAnySearch>>["details"];

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

export default function anysearchExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof SEARCH_PARAMETERS, AnySearchToolDetails | undefined>({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: SEARCH_PARAMETERS,

		async execute(_toolCallId, params, signal) {
			const response = await searchAnySearch(params, signal);
			if (claimAnonymousModeReminder()) {
				response.text += `\n\n[提示] ${ANONYMOUS_MODE_NOTICE}`;
			}
			return {
				content: [{ type: "text", text: response.text }],
				details: response.details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold(TOOL_NAME));
			text += theme.fg("accent", ` 「${args.query}」`);
			const opts: string[] = [];
			if (args.max_results !== undefined) opts.push(`max_results=${args.max_results}`);
			if (args.tag) opts.push(`tag=${args.tag}`);
			if (args.zone) opts.push(`zone=${args.zone}`);
			if (args.language) opts.push(`lang=${args.language}`);
			if (args.include_content) opts.push("include_content");
			if (opts.length > 0) text += theme.fg("dim", ` (${opts.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "AnySearch is searching the web…"), 0, 0);
			}

			if (context.isError) {
				const message = result.content
					.map((item) => (item.type === "text" ? item.text : ""))
					.filter(Boolean)
					.join("\n")
					.trim();
				return new Text(
					theme.fg("error", message ? `AnySearch error: ${message}` : "AnySearch search failed."),
					0,
					0,
				);
			}

			const details = result.details;
			const results = details?.results ?? [];
			if (results.length === 0) {
				return new Text(theme.fg("warning", "AnySearch found no results for this query."), 0, 0);
			}

			const header = theme.fg("toolTitle", theme.bold(`AnySearch · ${results.length} results`));
			const visibleResults = expanded ? results : results.slice(0, COLLAPSED_RESULT_LIMIT);
			const lines = visibleResults.map((searchResult, index) => {
				const title = searchResult.title
					? theme.fg("accent", searchResult.title)
					: theme.fg("muted", "(untitled)");
				const url = searchResult.url ? theme.fg("dim", searchResult.url) : "";
				let line = `${theme.fg("dim", `${index + 1}.`)} ${title}`;
				if (url) line += `\n   ${url}`;
				const summary = searchResult.snippet?.replace(/\s+/g, " ").trim();
				if (expanded && summary) line += `\n   ${theme.fg("muted", summary)}`;
				return line;
			});

			if (!expanded && results.length > visibleResults.length) {
				lines.push(theme.fg("dim", `… ${results.length - visibleResults.length} more results (expand to view)`));
			}
			const mode = details?.apiKeyUsed ? "configured" : "anonymous";
			lines.push(theme.fg("dim", `mode: ${mode}`));
			return new Text(`${header}\n${lines.join("\n")}`, 0, 0);
		},
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
				ctx.ui.notify(`AnySearch API key 已保存，${TOOL_NAME} 现在使用已配置的配额。`, "info");
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
