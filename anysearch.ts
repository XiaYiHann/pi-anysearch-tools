/**
 * AnySearch API client for the pi-anysearch extension.
 *
 * Docs: https://www.anysearch.com/docs#search-api
 * Endpoint: POST https://api.anysearch.com/v1/search
 *
 * Auth: `Authorization: Bearer <key>` is optional — anonymous requests work
 * but are rate-limited per IP and metered against the daily free quota.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ANYSEARCH_API_URL = "https://api.anysearch.com/v1/search";
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 20;

/** One result from the AnySearch API. */
export interface AnySearchResult {
	title: string;
	url: string;
	snippet: string;
	content: string;
}

export interface AnySearchSearchParams {
	query: string;
	max_results?: number;
	tag?: string;
	zone?: string;
	language?: string;
	params?: Record<string, unknown>;
	include_content?: boolean;
}

export interface AnySearchSearchResponse {
	text: string;
	details: {
		results: Array<{
			title: string;
			url: string;
			snippet: string;
			content?: string;
		}>;
		metadata: Record<string, unknown>;
		apiKeyUsed: boolean;
	};
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

function normalizeMaxResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 10;
	return Math.max(1, Math.min(Math.floor(value), MAX_RESULTS));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`AnySearch API returned invalid response: ${message}`);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}… (truncated)`;
}

/** Validate the API envelope. Throws on malformed payloads. */
export function parseResponse(value: unknown): { results: AnySearchResult[]; metadata: Record<string, unknown> } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalidResponse("expected an object envelope");
	}
	const envelope = value as Record<string, unknown>;
	if (envelope.code !== 0) {
		throw invalidResponse(`expected code 0, got ${JSON.stringify(envelope.code)}`);
	}
	if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
		throw invalidResponse("expected data object");
	}
	const data = envelope.data as Record<string, unknown>;
	if (!Array.isArray(data.results)) throw invalidResponse("expected data.results array");

	const results: AnySearchResult[] = [];
	for (const [index, item] of data.results.entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw invalidResponse(`expected data.results[${index}] object`);
		}
		const result = item as Record<string, unknown>;
		const { title, url, snippet, content } = result;
		if (typeof title !== "string") throw invalidResponse(`expected data.results[${index}].title string`);
		if (typeof url !== "string" || !url) throw invalidResponse(`expected data.results[${index}].url non-empty string`);
		if (typeof snippet !== "string") throw invalidResponse(`expected data.results[${index}].snippet string`);
		if (typeof content !== "string") throw invalidResponse(`expected data.results[${index}].content string`);
		results.push({ title, url, snippet, content });
	}

	const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
		? (data.metadata as Record<string, unknown>)
		: {};

	return { results, metadata };
}

function buildText(results: AnySearchResult[], includeContent: boolean): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
			if (result.snippet) lines.push(`   ${result.snippet}`);
			if (includeContent && result.content) lines.push(`   Content: ${truncate(result.content, 4000)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

/**
 * Run a search against the AnySearch API.
 * Throws a descriptive Error on API or network failure.
 */
export async function searchAnySearch(
	params: AnySearchSearchParams,
	signal?: AbortSignal,
): Promise<AnySearchSearchResponse> {
	const apiKey = resolveApiKey();
	const numResults = normalizeMaxResults(params.max_results);

	const body: Record<string, unknown> = { query: params.query, max_results: numResults };
	if (params.tag) body.tag = params.tag;
	if (params.zone) body.zone = params.zone;
	if (params.language) body.language = params.language;
	if (params.params && typeof params.params === "object") body.params = params.params;

	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

	let response: Response;
	try {
		response = await fetch(ANYSEARCH_API_URL, {
			method: "POST",
			headers: {
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) throw new Error("AnySearch request was cancelled or timed out");
		throw new Error(`AnySearch request failed: ${message}`);
	}

	if (!response.ok) {
		let detail = "";
		try {
			const raw = await response.json();
			const envelope = raw as { message?: unknown; request_id?: unknown; data?: { retry_after?: unknown } };
			detail = typeof envelope.message === "string" ? envelope.message : JSON.stringify(raw);
			if (envelope.request_id !== undefined) detail += ` (request_id: ${String(envelope.request_id)})`;
			if (response.status === 429 && envelope.data && typeof envelope.data === "object") {
				const retryAfter = (envelope.data as { retry_after?: unknown }).retry_after;
				if (retryAfter !== undefined) detail += ` (retry_after: ${String(retryAfter)})`;
			}
		} catch {
			detail = truncate(await response.text().catch(() => ""), 300);
		}
		const retryAfterHeader = response.headers.get("retry-after");
		const hint = retryAfterHeader ? ` Retry-After: ${retryAfterHeader}s.` : "";
		throw new Error(`AnySearch API error ${response.status}: ${detail || "unknown error"}.${hint}`);
	}

	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		throw new Error(`AnySearch API returned invalid JSON: ${errorMessage(err)}`);
	}

	let parsed: ReturnType<typeof parseResponse>;
	try {
		parsed = parseResponse(rawData);
	} catch (err) {
		throw new Error(errorMessage(err));
	}

	const results = parsed.results.slice(0, numResults);
	const includeContent = params.include_content === true;

	return {
		text: buildText(results, includeContent),
		details: {
			results: results.map((result) => ({
				title: result.title,
				url: result.url,
				snippet: result.snippet,
				...(includeContent ? { content: result.content } : {}),
			})),
			metadata: parsed.metadata,
			apiKeyUsed: Boolean(apiKey),
		},
	};
}
