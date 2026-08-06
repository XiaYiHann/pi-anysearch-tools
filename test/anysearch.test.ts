import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResponse } from "../anysearch.ts";

test("parseResponse accepts a valid envelope", () => {
	const envelope = {
		code: 0,
		message: "success",
		request_id: "abc",
		data: {
			results: [
				{ title: "T", url: "https://example.com", snippet: "S", content: "C" },
			],
			metadata: { total_results: 1, search_time_ms: 42 },
		},
	};
	const { results, metadata } = parseResponse(envelope);
	assert.equal(results.length, 1);
	assert.equal(results[0].title, "T");
	assert.equal(results[0].url, "https://example.com");
	assert.equal(metadata.total_results, 1);
});

test("parseResponse rejects a non-zero code", () => {
	assert.throws(
		() => parseResponse({ code: -1, message: "boom" }),
		/expected code 0/,
	);
});

test("parseResponse rejects missing results array", () => {
	assert.throws(
		() => parseResponse({ code: 0, data: {} }),
		/expected data.results array/,
	);
});

test("parseResponse rejects malformed result entries", () => {
	assert.throws(
		() =>
			parseResponse({
				code: 0,
				data: { results: [{ title: "T", url: "", snippet: "S", content: "C" }] },
			}),
		/url non-empty string/,
	);
});

test("parseResponse tolerates missing metadata", () => {
	const { metadata } = parseResponse({
		code: 0,
		data: { results: [{ title: "T", url: "https://x.dev", snippet: "S", content: "C" }] },
	});
	assert.deepEqual(metadata, {});
});
