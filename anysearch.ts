/**
 * AnySearch API client for the pi-anysearch extension (v3 / MCP endpoint).
 *
 * Docs: https://www.anysearch.com/docs — official skill v3.0.1 interface spec.
 * Endpoint: POST https://api.anysearch.com/mcp (JSON-RPC 2.0, method "tools/call").
 *
 * Auth: `Authorization: Bearer <key>` is optional — anonymous requests work
 * but are rate-limited per IP and metered against the daily free quota.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ANYSEARCH_MCP_URL = "https://api.anysearch.com/mcp";
const ANYSEARCH_CLIENT = "pi-anysearch-tools/0.2.1"; // ponytail: static version for X-Anysearch-Client, bump when package.json bumps (telemetry parity with skill/3.0.1)
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 10; // server hard cap

/** The 17 vertical domains supported by the /mcp search tools. */
export const DOMAINS = [
	"general",
	"resource",
	"social_media",
	"finance",
	"academic",
	"legal",
	"health",
	"business",
	"security",
	"ip",
	"code",
	"energy",
	"environment",
	"agriculture",
	"travel",
	"film",
	"gaming",
] as const;

export type AnySearchDomain = (typeof DOMAINS)[number];

/** One argument set for the `search` tool (and for each `batch_search` item). */
export interface AnySearchParams {
	query: string;
	domain?: string;
	sub_domain?: string;
	sub_domain_params?: Record<string, string>;
	max_results?: number;
	// ponytail: zone/language removed from official v3 search schema (v2.1.0) but
	// kept here and still forwarded — live probe (2026) shows server still accepts
	// them (200 OK) for backward compat; server may ignore. Do not break callers.
	zone?: string;
	language?: string;
}

/** Parsed result of a JSON-RPC tools/call against /mcp. */
export interface McpCallResult {
	/** First text item of result.content (Markdown). */
	text: string;
	/** result.isError — true when the server reports an error in-band. */
	isError: boolean;
	/** _meta.request_id when present. */
	requestId?: string;
	/** auto_registered.api_key when the response carries one. */
	autoRegisteredApiKey?: string;
	/** The full JSON-RPC response (raw object, or raw body text when unparseable). */
	raw: unknown;
}

/** Config file shape. Located at <agent dir>/anysearch.json. */
interface AnySearchConfig {
	anysearchApiKey?: unknown;
	apiKey?: unknown;
}

/** Package-internal state (reminder bookkeeping). Located at <agent dir>/pi-anysearch-state.json. */
interface AnySearchState {
	setupPrompted?: boolean;
}

let cachedConfig: AnySearchConfig | null = null;
let cachedState: AnySearchState | null = null;

/** Path of the user-editable config file: <agent dir>/anysearch.json */
export function getConfigPath(): string {
	return join(getAgentDir(), "anysearch.json");
}

/** Path of the package-internal state file: <agent dir>/pi-anysearch-state.json */
export function getStatePath(): string {
	return join(getAgentDir(), "pi-anysearch-state.json");
}

/** Drop cached config so the next resolveApiKey() re-reads the file. */
export function invalidateConfigCache(): void {
	cachedConfig = null;
}

/** True when an API key is configured (env var or config file). */
export function hasApiKey(): boolean {
	return resolveApiKey() !== undefined;
}

/** Persist an API key to <agent dir>/anysearch.json, preserving other fields. */
export function writeApiKey(key: string): void {
	const normalized = key.trim();
	if (!normalized) throw new Error("API key is empty");

	const configPath = getConfigPath();
	let config: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				config = parsed as Record<string, unknown>;
			}
		} catch {
			// Corrupt config: overwrite with the new key only.
		}
	}
	config.anysearchApiKey = normalized;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	invalidateConfigCache();
}

function loadState(): AnySearchState {
	if (cachedState) return cachedState;
	const statePath = getStatePath();
	if (!existsSync(statePath)) {
		cachedState = {};
		return cachedState;
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
		cachedState = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as AnySearchState)
			: {};
	} catch {
		cachedState = {};
	}
	return cachedState;
}

/** Whether the setup reminder has already been shown (avoid nagging every session). */
export function hasBeenPrompted(): boolean {
	return loadState().setupPrompted === true;
}

/** Record that the setup reminder was shown. */
export function markPrompted(): void {
	const statePath = getStatePath();
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ setupPrompted: true }, null, 2)}\n`, "utf-8");
	cachedState = { setupPrompted: true };
}

function loadConfig(): AnySearchConfig {
	if (cachedConfig) return cachedConfig;
	const configPath = join(getAgentDir(), "anysearch.json");
	if (!existsSync(configPath)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(configPath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${configPath}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${configPath}: expected a JSON object`);
	}
	cachedConfig = parsed as AnySearchConfig;
	return cachedConfig;
}

function normalizeConfigKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * Resolve the AnySearch API key. Priority:
 *   1. `ANYSEARCH_API_KEY` environment variable
 *   2. `anysearchApiKey` or `apiKey` in <agent dir>/anysearch.json
 * Returns undefined for anonymous access.
 */
export function resolveApiKey(): string | undefined {
	const envKey = normalizeConfigKey(process.env.ANYSEARCH_API_KEY);
	if (envKey) return envKey;

	const config = loadConfig();
	const fileKey = normalizeConfigKey(config.anysearchApiKey) ?? normalizeConfigKey(config.apiKey);
	if (fileKey) return fileKey;

	return undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}… (truncated)`;
}

/** Clamp max_results into the server-supported 1-10 range (default 10). */
export function normalizeMaxResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 10;
	return Math.max(1, Math.min(Math.floor(value), MAX_RESULTS));
}

/** Build the `arguments` object for the search / batch_search items. */
export function buildSearchArguments(params: AnySearchParams): Record<string, unknown> {
	const args: Record<string, unknown> = {
		query: params.query,
		max_results: normalizeMaxResults(params.max_results),
	};
	if (params.domain) args.domain = params.domain;
	if (params.sub_domain) args.sub_domain = params.sub_domain;
	if (params.sub_domain_params) args.sub_domain_params = params.sub_domain_params;
	if (params.zone) args.zone = params.zone;
	if (params.language) args.language = params.language;
	return args;
}

/** Find a request id in a shallow _meta / request_id field, if present. */
function findRequestId(node: unknown): string | undefined {
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	const direct = record.request_id;
	if (typeof direct === "string") return direct;
	const meta = record._meta;
	if (meta && typeof meta === "object") {
		const metaId = (meta as Record<string, unknown>).request_id;
		if (typeof metaId === "string") return metaId;
	}
	return undefined;
}

/**
 * Extract an auto-registered API key from a quota-exhaustion response.
 * The documented shape is result.auto_registered.api_key (object with `key`,
 * or a bare string); the key may also be embedded in the response text.
 */
export function extractAutoRegisteredKey(structured: unknown, text: string): string | undefined {
	/** Walk the documented shapes: key string, api_key (string | {key}), auto_registered (object). */
	const fromKeyNode = (node: unknown): string | undefined => {
		if (typeof node === "string") return node.startsWith("as_sk_") ? node : undefined;
		if (!node || typeof node !== "object") return undefined;
		const record = node as Record<string, unknown>;
		const direct = typeof record.key === "string" && record.key.startsWith("as_sk_") ? record.key : undefined;
		return direct ?? fromKeyNode(record.api_key) ?? fromKeyNode(record.auto_registered);
	};
	const fromStructured = fromKeyNode(structured);
	if (fromStructured) return fromStructured;
	if (text && text.includes("auto_registered")) {
		const match = text.match(/as_sk_[A-Za-z0-9_-]{8,}/);
		if (match) return match[0];
	}
	return undefined;
}

let rpcId = 0;

/**
 * Call one AnySearch MCP tool (JSON-RPC 2.0 tools/call) against /mcp.
 * Throws a descriptive Error on network/HTTP/JSON-RPC failure; in-band tool
 * errors are returned via isError + text.
 */
export async function callMcpTool(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<McpCallResult> {
	const apiKey = resolveApiKey();
	const body = {
		jsonrpc: "2.0",
		id: ++rpcId,
		method: "tools/call",
		params: { name: toolName, arguments: args },
	};

	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

	let response: Response;
	try {
		response = await fetch(ANYSEARCH_MCP_URL, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"X-Anysearch-Client": ANYSEARCH_CLIENT,
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			throw new Error("AnySearch request was cancelled or timed out");
		}
		throw new Error(`AnySearch request failed: ${message}`);
	}

	const rawText = await response.text().catch(() => "");
	let raw: unknown;
	try {
		raw = rawText ? JSON.parse(rawText) : {};
	} catch {
		raw = rawText;
	}

	if (!response.ok) {
		const envelope = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const requestId = findRequestId(envelope) ?? findRequestId(envelope.error);
		const detail =
			typeof raw === "string"
				? truncate(raw, 300)
				: truncate(JSON.stringify(envelope.error ?? envelope ?? raw) || "", 300);
		const retryAfterHeader = response.headers.get("retry-after");
		const retryHint = retryAfterHeader ? ` Retry-After: ${retryAfterHeader}s.` : "";
		const requestHint = requestId ? ` (request_id: ${requestId})` : "";
		throw new Error(`AnySearch API error ${response.status}: ${detail || "unknown error"}.${requestHint}${retryHint}`);
	}

	const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

	// JSON-RPC-level error (protocol or tool dispatch failure).
	if (envelope.error && typeof envelope.error === "object") {
		const rpcError = envelope.error as Record<string, unknown>;
		const requestId = findRequestId(envelope) ?? findRequestId(rpcError);
		const requestHint = requestId ? ` (request_id: ${requestId})` : "";
		throw new Error(
			`AnySearch API error: ${typeof rpcError.message === "string" ? rpcError.message : JSON.stringify(rpcError)}${requestHint}`,
		);
	}

	const result = envelope.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error(`AnySearch API returned invalid response: missing result object${responseHint(envelope)}`);
	}
	const resultRecord = result as Record<string, unknown>;
	const content = Array.isArray(resultRecord.content) ? resultRecord.content : [];
	const firstText = content.find(
		(item): item is { type: string; text: string } =>
			!!item &&
			typeof item === "object" &&
			typeof (item as Record<string, unknown>).type === "string" &&
			typeof (item as Record<string, unknown>).text === "string",
	);
	const text = firstText ? firstText.text : "";
	const requestId = findRequestId(resultRecord._meta) ?? findRequestId(resultRecord);
	const isError = resultRecord.isError === true;
	if (!isError && !firstText) {
		throw new Error(`AnySearch API returned invalid response: empty content${requestId ? ` (request_id: ${requestId})` : ""}`);
	}
	const autoRegisteredApiKey = extractAutoRegisteredKey(resultRecord, text) ?? extractAutoRegisteredKey(envelope, text);

	return {
		text,
		isError,
		...(requestId ? { requestId } : {}),
		...(autoRegisteredApiKey ? { autoRegisteredApiKey } : {}),
		raw,
	};
}

function responseHint(envelope: Record<string, unknown>): string {
	const requestId = findRequestId(envelope);
	return requestId ? ` (request_id: ${requestId})` : "";
}

/** Normalize a search-result URL for dedupe: scheme/www/trailing-slash/case-insensitive, drop hash and tracking params. */
export function normalizeSearchUrl(raw: string): string {
	if (!raw) return "";
	try {
		const u = new URL(raw);
		u.hash = "";
		for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref", "ref_src"]) {
			u.searchParams.delete(p);
		}
		let s = u.host + u.pathname + (u.search || "").replace(/(%2[fF]|\/)+$/, "");
		if (s.startsWith("www.")) s = s.slice(4);
		return s.replace(/\/+$/, "").toLowerCase();
	} catch {
		return raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/+$/, "");
	}
}

/** Normalize a search-result title for dedupe: case/whitespace-insensitive, drop trailing truncation dots. */
export function normalizeSearchTitle(raw: string): string {
	return raw.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/**
 * Drop duplicate search results from server Markdown (per `## Query N` / `## Search Results`
 * section). A result is a duplicate of an earlier one in the same section when its normalized
 * URL matches OR its normalized title equals / is a truncation-prefix of an earlier title
 * (titles must be >= 12 chars, prefix match requires >= 20, to avoid collapsing distinct
 * generic pages). Kept items are renumbered 1..N and the `## Search Results`
 * header count is rewritten. Non-search text (extract, domain directory) passes through unchanged.
 */
export function dedupeSearchResults(text: string): string {
	// ponytail: line-based state machine over the server's `### N. Title` / `- **URL**: ...` shape;
	// fine while that shape is stable (server owns the format; drift already breaks parseSearchMarkdown too).
	// ponytail: exact/prefix title match only — cross-source same-doc merges (openreview vs arxiv abs
	// with differently-worded titles) are out of scope; add arxiv-id matching if that becomes noisy.
	const urlKeys = new Set<string>();
	const titleKeys: string[] = [];
	let block: string[] | null = null;
	let kept = 0;
	let declaredCount = -1;
	let headerOutIndex = -1;
	const out: string[] = [];

	const titleDup = (tKey: string): boolean => {
		if (tKey.length < 12) return false;
		return titleKeys.some(
			(prev) =>
				tKey === prev ||
				(tKey.length >= 20 && prev.startsWith(tKey)) ||
				(prev.length >= 20 && tKey.startsWith(prev)),
			);
	};

	const closeBlock = (): void => {
		if (!block) return;
		const head = block[0];
		const title = head.match(/^###\s*\d+\.\s*(.*)$/)?.[1]?.trim() ?? "";
		const urlLine = block.find((l) => /^\s*-\s*\*\*URL\*\*:\s*/.test(l));
		const url = urlLine?.match(/^\s*-\s*\*\*URL\*\*:\s*(.*)$/)?.[1]?.trim() ?? "";
		const uKey = normalizeSearchUrl(url);
		const tKey = normalizeSearchTitle(title);
		const dup = (uKey !== "" && urlKeys.has(uKey)) || titleDup(tKey);
		if (!dup) {
			kept++;
			out.push(head.replace(/^###\s*\d+\./, `### ${kept}.`), ...block.slice(1));
			if (uKey) urlKeys.add(uKey);
			if (tKey.length >= 12) titleKeys.push(tKey);
		}
		block = null;
	};

	const endSection = (): void => {
		if (headerOutIndex >= 0 && declaredCount >= 0 && kept < declaredCount) {
			out[headerOutIndex] = out[headerOutIndex].replace(
				`(${declaredCount} results`,
				`(${kept} results`,
			);
			}
		headerOutIndex = -1;
		declaredCount = -1;
	};

	for (const line of text.split("\n")) {
		if (/^###\s*\d+\.\s/.test(line)) {
			closeBlock();
			block = [line];
			continue;
		}
		if (/^##\s/.test(line)) {
			closeBlock();
			endSection();
			kept = 0;
			urlKeys.clear();
			titleKeys.length = 0;
			const count = line.match(/^## Search Results \((\d+) results/);
			if (count) {
				declaredCount = Number(count[1]);
				headerOutIndex = out.length;
			}
			out.push(line);
			continue;
		}
		if (block) block.push(line);
		else out.push(line);
	}
	closeBlock();
	endSection();
	return out.join("\n");
}

/** Run a single search (general or vertical) via the search tool. */
export async function searchAnySearch(
	params: AnySearchParams,
	signal?: AbortSignal,
): Promise<McpCallResult> {
	if (!params.query || !params.query.trim()) throw new Error("query is required");
	const result = await callMcpTool("search", buildSearchArguments(params), signal);
	if (!result.isError) result.text = dedupeSearchResults(result.text);
	return result;
}

/** Run 2-5 searches in one batch_search call; a single failure does not block the rest. */
export async function batchSearchAnySearch(
	queries: AnySearchParams[],
	signal?: AbortSignal,
): Promise<McpCallResult> {
	if (!Array.isArray(queries) || queries.length < 1 || queries.length > 5) {
		throw new Error("batch_search requires 1-5 queries");
	}
	const items = queries.map((item) => {
		if (!item.query || !item.query.trim()) throw new Error("each batch_search query item requires a non-empty query");
		return buildSearchArguments(item);
	});
	const result = await callMcpTool("batch_search", { queries: items }, signal);
	if (!result.isError) result.text = dedupeSearchResults(result.text);
	return result;
}

/** Fetch a URL's full page content as Markdown (server truncates at 50k chars). */
export async function extractAnySearch(url: string, signal?: AbortSignal): Promise<McpCallResult> {
	if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
	return callMcpTool("extract", { url }, signal);
}

/** Session-level cache for get_sub_domains results (keyed by normalized domain set). */
const subDomainCache = new Map<string, McpCallResult>();

/** Drop the get_sub_domains session cache (test hook). */
export function clearSubDomainCache(): void {
	subDomainCache.clear();
}

/**
 * Query the vertical domain directory. `domains` (array, max 5) takes priority
 * over `domain`. Results are cached per session for the same domain set.
 */
export async function getSubDomainsAnySearch(
	opts: { domain?: string; domains?: string[] },
	signal?: AbortSignal,
): Promise<McpCallResult> {
	const domains = opts.domains && opts.domains.length > 0 ? opts.domains : opts.domain ? [opts.domain] : undefined;
	if (!domains || domains.length === 0) throw new Error("get_sub_domains requires domain or domains");
	if (domains.length > 5) throw new Error("get_sub_domains accepts at most 5 domains");
	for (const domain of domains) {
		if (!DOMAINS.includes(domain as AnySearchDomain)) throw new Error(`unknown domain: ${domain}`);
	}
	const cacheKey = domains.slice().sort().join(",");
	const cached = subDomainCache.get(cacheKey);
	if (cached) return cached;
	const result = await callMcpTool("get_sub_domains", { domains }, signal);
	if (!result.isError) subDomainCache.set(cacheKey, result);
	return result;
}
