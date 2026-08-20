/**
 * End-to-end tests: real anonymous calls against hybrid endpoints.
 * - POST https://api.anysearch.com/v1/search (search, JSON summaries)
 * - POST https://api.anysearch.com/mcp        (extract and capability discovery)
 *
 * Each passing scenario stores the raw response under .evidence/ as
 * evidence. When the network is unreachable the scenario is marked skipped
 * (with the reason printed) — a silent skip is a failure by construction:
 * t.skip() requires an explicit reason and we log it as well.
 * Quota, auth, mapping, parsing, or content failures are NOT treated as
 * network skips and must fail the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	batchSearchAnySearch,
	extractAnySearch,
	getSubDomainsAnySearch,
	searchAnySearch,
} from "../anysearch.ts";

// Isolate the agent dir so tests never read or write the user's Pi config.
// Authenticated runs opt in through ANYSEARCH_E2E_API_KEY; otherwise tests run anonymously.
delete process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-anysearch-e2e-"));
const savedEnvKey = process.env.ANYSEARCH_API_KEY;
const e2eApiKey = process.env.ANYSEARCH_E2E_API_KEY?.trim();
if (e2eApiKey) process.env.ANYSEARCH_API_KEY = e2eApiKey;
else delete process.env.ANYSEARCH_API_KEY;

const EVIDENCE_DIR = join(import.meta.dirname, "..", ".evidence");

function saveEvidence(name: string, raw: unknown): void {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	writeFileSync(join(EVIDENCE_DIR, `${name}.json`), JSON.stringify(raw, null, 2), "utf-8");
}

function isNetworkError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /request failed|timed out|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(
		message,
	);
}

function restoreEnv(): void {
	if (savedEnvKey === undefined) delete process.env.ANYSEARCH_API_KEY;
	else process.env.ANYSEARCH_API_KEY = savedEnvKey;
}

function skipOnNetworkError(t: { skip: (reason: string) => void }, err: unknown): boolean {
	if (!isNetworkError(err)) return false;
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[e2e] SKIPPED — network unreachable: ${message}`);
	t.skip(`network unreachable: ${message}`);
	return true;
}

test("e2e: general search", async (t) => {
	let result;
	try {
		result = await searchAnySearch({ query: "What is the capital of France", max_results: 3 });
	} catch (err) {
		if (skipOnNetworkError(t, err)) return;
		throw err;
	}
	assert.equal(result.isError, false);
	assert.ok(result.text.includes("Paris"));
	assert.ok(result.text.includes("**URL**"));
	assert.ok(result.text.length <= 12_000);
	const envelope = result.raw as { code?: unknown; data?: { results?: unknown[] } };
	assert.equal(envelope.code, 0);
	assert.ok(Array.isArray(envelope.data?.results));
	saveEvidence("e2e-general-search", result.raw);
});

test("e2e: finance vertical search", async (t) => {
	let result;
	try {
		result = await searchAnySearch({
			query: "AAPL",
			domain: "finance",
			sub_domain: "finance.quote",
			sub_domain_params: { type: "stock", symbol: "AAPL", cn_code: "" },
			max_results: 3,
		});
	} catch (err) {
		if (skipOnNetworkError(t, err)) return;
		throw err;
	}
	assert.equal(result.isError, false, `vertical search failed: ${result.text.slice(0, 300)}`);
	assert.ok(
		/AAPL|Apple|NASDAQ/.test(result.text),
		`expected stable finance identifier (AAPL|Apple|NASDAQ) in: ${result.text.slice(0, 300)}`,
	);
	saveEvidence("e2e-finance-vertical", result.raw);
});

test("e2e: batch search", async (t) => {
	let result;
	try {
		result = await batchSearchAnySearch([
			{ query: "What is the capital of France" },
			{ query: "What is the capital of Germany" },
			{ query: "What is the capital of Italy" },
		]);
	} catch (err) {
		if (skipOnNetworkError(t, err)) return;
		throw err;
	}
	assert.equal(result.isError, false, `batch search failed: ${result.text.slice(0, 300)}`);
	assert.ok(result.text.includes("## Query 1:"), `expected "## Query 1:" heading in: ${result.text.slice(0, 500)}`);
	assert.ok(result.text.includes("## Query 2:"), `expected "## Query 2:" heading in: ${result.text.slice(0, 500)}`);
	assert.ok(result.text.includes("## Query 3:"), `expected "## Query 3:" heading in: ${result.text.slice(0, 500)}`);
	assert.ok(result.text.includes("Paris"), `expected "Paris" in: ${result.text.slice(0, 300)}`);
	assert.ok(result.text.includes("Berlin"), `expected "Berlin" in: ${result.text.slice(0, 300)}`);
	assert.ok(result.text.includes("Rome"), `expected "Rome" in: ${result.text.slice(0, 300)}`);
	assert.ok(result.text.length <= 12_000, `batch text exceeds 12k: ${result.text.length}`);
	saveEvidence("e2e-batch-search", result.raw);
});

test("e2e: extract example.com", async (t) => {
	let result;
	try {
		result = await extractAnySearch("https://example.com");
	} catch (err) {
		if (skipOnNetworkError(t, err)) return;
		throw err;
	}
	assert.equal(result.isError, false, `extract failed: ${result.text.slice(0, 300)}`);
	assert.ok(result.text.includes("Example Domain"), `expected "Example Domain" in: ${result.text.slice(0, 300)}`);
	saveEvidence("e2e-extract", result.raw);
});

test("e2e: get_sub_domains finance", async (t) => {
	let result;
	try {
		result = await getSubDomainsAnySearch({ domain: "finance" });
	} catch (err) {
		if (skipOnNetworkError(t, err)) return;
		throw err;
	}
	assert.equal(result.isError, false, `get_sub_domains failed: ${result.text.slice(0, 300)}`);
	assert.ok(
		result.text.includes("finance.") && /Parameters/i.test(result.text),
		`expected "finance." and "Parameters" in: ${result.text.slice(0, 300)}`,
	);
	saveEvidence("e2e-get-sub-domains", result.raw);
});

// Runs last (declaration order): restore the caller's env after all e2e calls.
test("e2e teardown: restore env", restoreEnv);
