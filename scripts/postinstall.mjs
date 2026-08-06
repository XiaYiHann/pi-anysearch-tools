#!/usr/bin/env node
/**
 * pi-anysearch install hook (runs on `pi install npm:pi-anysearch` / git installs).
 *
 * - Interactive TTY: asks the user to paste an AnySearch API key and persists it
 *   to <agent dir>/anysearch.json (same file the extension reads at runtime).
 * - Non-TTY (CI, scripted installs, `ignore-scripts`): prints setup instructions
 *   and exits 0 — the extension still works in anonymous mode.
 *
 * Local-path installs (`pi install ./path`) never run npm scripts; the extension
 * covers that case with a one-time reminder on session start.
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR_NAME = ".pi";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function getAgentDir() {
	const envDir = process.env[AGENT_DIR_ENV];
	if (envDir) return envDir;
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

function getConfigPath() {
	return join(getAgentDir(), "anysearch.json");
}

function hasKeyConfigured() {
	if (process.env.ANYSEARCH_API_KEY?.trim()) return true;
	const configPath = getConfigPath();
	if (!existsSync(configPath)) return false;
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
		return typeof parsed?.anysearchApiKey === "string" && parsed.anysearchApiKey.trim().length > 0;
	} catch {
		return false;
	}
}

function writeApiKey(key) {
	const normalized = key.trim();
	if (!normalized) throw new Error("API key is empty");
	const configPath = getConfigPath();
	let config = {};
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
		} catch {
			// corrupt file: overwrite
		}
	}
	config.anysearchApiKey = normalized;
	mkdirSync(join(getAgentDir()), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function promptForApiKey() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await new Promise((resolve) => {
			rl.question(
				"\npi-anysearch: 未检测到 AnySearch API key（匿名模式受限速）。\n" +
				"现在粘贴 key 以启用付费配额（直接回车跳过，之后可运行 /anysearch-setup 配置）:\n> ",
				resolve,
			);
		});
		const trimmed = answer.trim();
		if (!trimmed) {
			console.log("\n已跳过。之后可在 Pi 中运行 /anysearch-setup 配置，或设置 ANYSEARCH_API_KEY。");
			return;
		}
		if (!trimmed.startsWith("as_sk_")) {
			console.log(`\n提示：key 通常以 as_sk_ 开头（收到 "${trimmed.slice(0, 12)}…"）。仍会保存。`);
		}
		writeApiKey(trimmed);
		console.log(`\n已保存到 ${getConfigPath()}。重启 Pi 后 anysearch_search 将使用付费配额。`);
	} finally {
		rl.close();
	}
}

async function main() {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

	if (hasKeyConfigured()) {
		if (interactive) console.log("pi-anysearch: 已检测到 API key，跳过配置。");
		return;
	}

	if (!interactive) {
		console.log(
			"\npi-anysearch 已安装。未配置 API key，将使用匿名模式（限速）。\n" +
			`  配置方式：运行 /anysearch-setup（Pi 内），或 export ANYSEARCH_API_KEY=as_sk_...，\n` +
			`  或写入 ${getConfigPath()}。`,
		);
		return;
	}

	await promptForApiKey();
}

main().catch((err) => {
	console.error(`pi-anysearch postinstall 出错（不影响使用，匿名模式仍可用）: ${err.message}`);
	process.exitCode = 0;
});
