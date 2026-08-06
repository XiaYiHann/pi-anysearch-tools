/**
 * pi-anysearch — AnySearch web search for the Pi coding agent.
 *
 * Registers the `anysearch_search` tool, backed by the AnySearch unified
 * search API (https://www.anysearch.com/docs#search-api). Anonymous access
 * works out of the box; set ANYSEARCH_API_KEY or add `anysearchApiKey` to
 * <agent dir>/anysearch.json for higher limits and paid quota.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
	hasApiKey,
	hasBeenPrompted,
	markPrompted,
	resolveApiKey,
	searchAnySearch,
	writeApiKey,
	getConfigPath,
} from "./anysearch.ts";

export default function anysearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "anysearch_search",
		label: "AnySearch Search",
		description:
			"Search the web using the AnySearch API (https://api.anysearch.com/v1/search). " +
			"Returns ranked results with title, URL, snippet, and optionally cleaned-up page content. " +
			"Use when the user asks for fresh, current, or web-based information.",
		promptSnippet: "Search the web using AnySearch (unified search for AI agents)",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
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
				Type.String({
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
					description: "Extended parameters passed through to AnyMix, e.g. {\"ticker\": \"AAPL\"}",
				}),
			),
			include_content: Type.Optional(
				Type.Boolean({
					description: "Include cleaned-up page body content in each result (larger responses)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const response = await searchAnySearch(params, signal);
			// First-call nudge: if no key is configured and the reminder has not
			// been shown yet (session_start or postinstall), mention it once here.
			if (!hasApiKey() && !hasBeenPrompted()) {
				markPrompted();
				response.text +=
					"\n\n[提示] 当前为 AnySearch 匿名模式（限速）。运行 /anysearch-setup 可配置 API key，或设置 ANYSEARCH_API_KEY。";
			}
			return {
				content: [{ type: "text", text: response.text }],
				details: response.details,
			};
		},

		renderCall(args, theme) {
			// e.g. anysearch_search 「TypeScript 5.9 release notes」 (max_results=3)
			let text = theme.fg("toolTitle", theme.bold("anysearch_search"));
			text += theme.fg("accent", ` 「${args.query}」`);
			const opts: string[] = [];
			if (args.max_results) opts.push(`max_results=${args.max_results}`);
			if (args.tag) opts.push(`tag=${args.tag}`);
			if (args.zone) opts.push(`zone=${args.zone}`);
			if (args.language) opts.push(`lang=${args.language}`);
			if (args.include_content) opts.push("include_content");
			if (opts.length > 0) text += theme.fg("dim", ` (${opts.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "AnySearch 搜索中…"), 0, 0);
			}

			const details = result.details as
				| { results?: Array<{ title?: string; url?: string; snippet?: string }>; apiKeyUsed?: boolean }
				| undefined;
			const results = details?.results ?? [];

			if (results.length === 0) {
				return new Text(theme.fg("warning", "AnySearch: 无结果"), 0, 0);
			}

			const header = theme.fg("toolTitle", theme.bold(`AnySearch ${results.length} 条结果`));
			const lines = results.map((r, i) => {
				const title = r.title ? theme.fg("accent", r.title) : "(无标题)";
				const url = r.url ? theme.fg("dim", r.url) : "";
				let line = `${theme.fg("dim", `${i + 1}.`)} ${title}`;
				if (url) line += `\n   ${url}`;
				if (expanded && r.snippet) line += `\n   ${theme.fg("dim", r.snippet)}`;
				return line;
			});

			const mode = details?.apiKeyUsed ? theme.fg("success", "key") : theme.fg("warning", "anonymous");
			return new Text(`${header}\n${lines.join("\n")}\n${theme.fg("dim", `mode: ${mode}`)}`, 0, 0);
		},
	});

	// After installation, remind the user once to configure an API key.
	// Anonymous mode keeps working, but the key lifts rate limits and quota.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return; // skip print/json mode
		if (hasApiKey() || hasBeenPrompted()) return;
		markPrompted();
		ctx.ui.notify(
			"pi-anysearch: 未配置 API key，当前为匿名模式（限速）。运行 /anysearch-setup 输入 key，或设置环境变量 ANYSEARCH_API_KEY。",
			"warning",
		);
	});

	pi.registerCommand("anysearch-setup", {
		description: "交互式配置 AnySearch API key（写入 " + getConfigPath() + "）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("anysearch-setup 需要交互式终端（TUI）。也可设置环境变量 ANYSEARCH_API_KEY。", "warning");
				return;
			}

			const key = await ctx.ui.input("AnySearch API key（留空取消）:", "as_sk_...");
			if (!key || !key.trim()) {
				ctx.ui.notify("已取消，继续使用匿名模式。", "info");
				return;
			}
			const trimmed = key.trim();
			if (!trimmed.startsWith("as_sk_")) {
				const ok = await ctx.ui.confirm("确认保存？", `输入的 key 不以 as_sk_ 开头（${trimmed.slice(0, 12)}…），仍要保存吗？`);
				if (!ok) {
					ctx.ui.notify("已取消。", "info");
					return;
				}
			}

			try {
				writeApiKey(trimmed);
				ctx.ui.notify("AnySearch API key 已保存，anysearch_search 现在使用付费配额。", "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`保存失败：${message}`, "error");
			}
		},
	});

	pi.registerCommand("anysearch-status", {
		description: "查看 AnySearch 认证状态与配置路径",
		handler: async (_args, ctx) => {
			const key = resolveApiKey();
			const status = key
				? `已配置 API key（${key.slice(0, 10)}…）`
				: "匿名模式（未配置 API key，受限速限制）";
			ctx.ui.notify(`AnySearch：${status} · 配置：${getConfigPath()}`, "info");
		},
	});
}
