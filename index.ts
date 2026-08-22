/**
 * devpass_pi - DevPass custom provider extension for Pi coding agent.
 *
 * Provides dynamic model discovery and registration for DevPass / LLM Gateway.
 * Automatically fetches the latest model catalog from https://api.llmgateway.io/v1/models,
 * maps prices, context windows, max tokens, modalities, and reasoning capabilities,
 * caches models locally for fast offline-resilient startup, and registers the `devpass` provider.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "devpass";
export const PROVIDER_NAME = "DevPass";
export const BASE_URL = "https://api.llmgateway.io/v1";
export const MODELS_ENDPOINT = `${BASE_URL}/models`;
export const KEY_INFO_ENDPOINT = `${BASE_URL}/key`;
export const CACHE_FILE_NAME = "devpass-models-cache.json";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface DevPassKeyInfo {
	label?: string;
	usage?: string;
	limit?: number | string | null;
	devPlan?: string;
	devPlanCreditsUsed?: string;
	devPlanCreditsLimit?: string;
	devPlanCreditsRemaining?: string;
	devPlanPremiumWeeklyLimit?: string;
	devPlanPremiumCreditsUsed?: string;
	devPlanPremiumWeekResetsAt?: string;
	devPlanMonthResetsAt?: string;
	devPlanMonthlyResetsAt?: string;
	[key: string]: unknown;
}

interface RawModelProvider {
	providerId?: string;
	externalId?: string;
	pricing?: {
		prompt?: string;
		completion?: string;
		image?: string;
		request?: string;
		input_cache_read?: string;
		input_cache_write?: string;
		input_cache_write_1h?: string;
	};
	streaming?: boolean;
	vision?: boolean;
	cancellation?: boolean;
	tools?: boolean;
	parallelToolCalls?: boolean;
	reasoning?: boolean;
	reasoning_efforts?: string[];
	max_output?: number;
}

interface RawModelPricing {
	prompt?: string;
	completion?: string;
	image?: string;
	request?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	input_cache_write_1h?: string;
	web_search?: string;
	internal_reasoning?: string;
}

interface RawModelArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
	tokenizer?: string;
}

interface RawModelItem {
	id: string;
	name?: string;
	display_name?: string;
	created?: number;
	description?: string;
	family?: string;
	architecture?: RawModelArchitecture;
	providers?: RawModelProvider[];
	pricing?: RawModelPricing;
	context_length?: number;
	max_output?: number;
	supported_parameters?: string[];
	json_output?: boolean;
	structured_outputs?: boolean;
	free?: boolean;
	deactivated_at?: string;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
		supportsUsageInStreaming?: boolean;
		supportsFinishReason?: boolean;
		maxTokensField?: "max_completion_tokens" | "max_tokens";
		requiresToolResultName?: boolean;
		cacheControlFormat?: "anthropic";
	};
}

export const FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 1050000,
		maxTokens: 128000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 1050000,
		maxTokens: 128000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1000000,
		maxTokens: 64000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10.0, cacheRead: 0.3125, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 65535,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 65535,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o Mini",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "deepseek-v4",
		name: "DeepSeek V4",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 65536,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "deepseek-v3.1",
		name: "DeepSeek V3.1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 163840,
		maxTokens: 32768,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "deepseek-r1",
		name: "DeepSeek R1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 },
		contextWindow: 64000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "o3",
		name: "o3",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 100000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "o3-mini",
		name: "o3 Mini",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 100000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "o4-mini",
		name: "o4 Mini",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 100000,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
	{
		id: "auto",
		name: "Auto Route",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	},
];

export function getAgentDirPath(): string {
	try {
		if (typeof getAgentDir === "function") {
			return getAgentDir();
		}
	} catch {}
	if (process.env.PI_AGENT_DIR) {
		return process.env.PI_AGENT_DIR;
	}
	return join(homedir(), ".pi", "agent");
}

/**
 * Resolve API key from environment variables or auth.json.
 */
export function resolveDevPassApiKey(): string | undefined {
	if (process.env.DEVPASS_API_KEY) return process.env.DEVPASS_API_KEY;
	if (process.env.LLMGATEWAY_API_KEY) return process.env.LLMGATEWAY_API_KEY;

	try {
		if (typeof readStoredCredential === "function") {
			const cred = readStoredCredential("devpass");
			if (cred && cred.type === "api_key" && cred.key) {
				return cred.key;
			}
		}
	} catch {}

	try {
		const authFile = join(getAgentDirPath(), "auth.json");
		if (existsSync(authFile)) {
			const data = JSON.parse(readFileSync(authFile, "utf-8"));
			if (data?.devpass?.key) {
				return data.devpass.key;
			}
		}
	} catch {}

	return undefined;
}

/**
 * Map raw model metadata from LLM Gateway to Pi's ProviderModelConfig.
 */
export function mapRawModel(raw: RawModelItem): ProviderModelConfig | null {
	if (!raw.id || typeof raw.id !== "string") return null;

	// Filter out deactivated models
	if (raw.deactivated_at) {
		const deactivatedDate = new Date(raw.deactivated_at);
		if (!isNaN(deactivatedDate.getTime()) && deactivatedDate <= new Date()) {
			return null;
		}
	}

	// Filter out non-text output models (audio-only, image generation only, embeddings, etc.)
	if (raw.architecture?.output_modalities && !raw.architecture.output_modalities.includes("text")) {
		return null;
	}

	const id = raw.id;
	// Exclude non-chat utilities
	if (
		id.includes("embedding") ||
		id.includes("rerank") ||
		id.includes("moderation") ||
		id.includes("tts") ||
		id.includes("stt") ||
		id.includes("whisper") ||
		id.includes("transcription")
	) {
		return null;
	}

	const name = raw.name || raw.display_name || id;

	// Input modalities
	const input: ("text" | "image")[] = [];
	if (raw.architecture?.input_modalities?.includes("text") ?? true) {
		input.push("text");
	}
	if (raw.architecture?.input_modalities?.includes("image") || raw.providers?.some((p) => p.vision)) {
		if (!input.includes("image")) input.push("image");
	}
	if (input.length === 0) {
		input.push("text");
	}

	// Convert $/token to $/million tokens
	const promptPrice = parseFloat(raw.pricing?.prompt || "0");
	const completionPrice = parseFloat(raw.pricing?.completion || "0");
	const cacheReadPrice = parseFloat(raw.pricing?.input_cache_read || "0");
	const cacheWritePrice = parseFloat(raw.pricing?.input_cache_write || "0");

	const cost = {
		input: isNaN(promptPrice) ? 0 : promptPrice * 1_000_000,
		output: isNaN(completionPrice) ? 0 : completionPrice * 1_000_000,
		cacheRead: isNaN(cacheReadPrice) ? 0 : cacheReadPrice * 1_000_000,
		cacheWrite: isNaN(cacheWritePrice) ? 0 : cacheWritePrice * 1_000_000,
	};

	const contextWindow = raw.context_length && raw.context_length > 0 ? raw.context_length : 128000;
	const maxTokens = raw.max_output && raw.max_output > 0 ? raw.max_output : Math.min(contextWindow, 16384);

	// Detect reasoning / extended thinking
	const isReasoning = !!(
		raw.providers?.some((p) => p.reasoning) ||
		raw.supported_parameters?.includes("reasoning") ||
		raw.supported_parameters?.includes("reasoning_effort") ||
		raw.supported_parameters?.includes("effort") ||
		id.includes("thinking") ||
		id.startsWith("o1") ||
		id.startsWith("o3") ||
		id.startsWith("o4") ||
		id.includes("r1")
	);

	let thinkingLevelMap: ProviderModelConfig["thinkingLevelMap"] = undefined;
	if (isReasoning) {
		const efforts = new Set<string>();
		for (const p of raw.providers || []) {
			for (const e of p.reasoning_efforts || []) {
				efforts.add(e.toLowerCase());
			}
		}
		if (efforts.size > 0) {
			thinkingLevelMap = {
				minimal: efforts.has("minimal") ? "minimal" : efforts.has("low") ? "low" : null,
				low: efforts.has("low") ? "low" : null,
				medium: efforts.has("medium") ? "medium" : null,
				high: efforts.has("high") ? "high" : null,
				xhigh: efforts.has("xhigh") ? "xhigh" : null,
				max: efforts.has("max") ? "max" : null,
			};
		}
	}

	return {
		id,
		name,
		reasoning: isReasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input,
		cost,
		contextWindow,
		maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			cacheControlFormat: "anthropic",
		},
	};
}

function getCachePath(): string {
	return join(getAgentDirPath(), CACHE_FILE_NAME);
}

export function loadCachedModels(): { models: ProviderModelConfig[]; timestamp: number } | null {
	try {
		const cachePath = getCachePath();
		if (!existsSync(cachePath)) return null;
		const raw = readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw);
		if (data && Array.isArray(data.models) && data.models.length > 0) {
			return { models: data.models, timestamp: data.timestamp || 0 };
		}
	} catch {}
	return null;
}

export function saveCachedModels(models: ProviderModelConfig[]): void {
	try {
		const cachePath = getCachePath();
		writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), models }, null, 2), "utf-8");
	} catch {
		// Ignore filesystem write errors in sandboxed / read-only environments
	}
}

export async function fetchRemoteModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const response = await fetch(MODELS_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": "devpass-pi-extension",
		},
		signal: signal ?? AbortSignal.timeout(6000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch DevPass models: HTTP ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as { data?: RawModelItem[] } | RawModelItem[];
	const rawList = Array.isArray(payload) ? payload : payload.data || [];

	const models: ProviderModelConfig[] = [];
	for (const raw of rawList) {
		const mapped = mapRawModel(raw);
		if (mapped) {
			models.push(mapped);
		}
	}

	if (models.length === 0) {
		throw new Error("DevPass models endpoint returned empty list");
	}

	return models;
}

export async function loadModels(
	apiKey: string | undefined,
	forceRefresh = false,
): Promise<{ models: ProviderModelConfig[]; source: "remote" | "cache" | "fallback" }> {
	const cached = loadCachedModels();
	const isCacheFresh = cached && Date.now() - cached.timestamp < CACHE_TTL_MS;

	if (!forceRefresh && isCacheFresh && cached) {
		return { models: cached.models, source: "cache" };
	}

	if (apiKey) {
		try {
			const models = await fetchRemoteModels(apiKey);
			saveCachedModels(models);
			return { models, source: "remote" };
		} catch {
			if (cached && cached.models.length > 0) {
				return { models: cached.models, source: "cache" };
			}
		}
	} else {
		if (cached && cached.models.length > 0) {
			return { models: cached.models, source: "cache" };
		}
	}

	return { models: FALLBACK_MODELS, source: "fallback" };
}

export function formatRelativeTime(targetDate: Date, now: Date = new Date(), includePrefix = true): string {
	const diffMs = targetDate.getTime() - now.getTime();
	if (diffMs <= 0) return "due now";
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHours = Math.floor(diffMin / 60);
	const diffDays = Math.floor(diffHours / 24);

	const prefix = includePrefix ? "in " : "";

	if (diffDays > 0) {
		const remHours = diffHours % 24;
		return remHours > 0 ? `${prefix}${diffDays}d ${remHours}h` : `${prefix}${diffDays}d`;
	}
	if (diffHours > 0) {
		const remMin = diffMin % 60;
		return remMin > 0 ? `${prefix}${diffHours}h ${remMin}m` : `${prefix}${diffHours}h`;
	}
	if (diffMin > 0) {
		return `${prefix}${diffMin}m`;
	}
	return `${prefix}${diffSec}s`;
}

export function isPremiumModel(model: { cost?: { input?: number; output?: number } } | undefined): boolean {
	if (!model?.cost) return false;
	const inputCost = model.cost.input ?? 0;
	const outputCost = model.cost.output ?? 0;
	return outputCost >= 15.0 || inputCost >= 5.0;
}

export function formatStatusLineText(
	keyInfo: DevPassKeyInfo | null,
	additionalCost = 0,
	isPremium = false,
	now: Date = new Date(),
): string | undefined {
	if (!keyInfo) return undefined;

	const baseUsed = parseFloat(keyInfo.devPlanCreditsUsed || keyInfo.usage || "0");
	const limit = parseFloat(keyInfo.devPlanCreditsLimit || "0");
	const totalUsed = baseUsed + additionalCost;

	if (limit <= 0) {
		return undefined;
	}

	const premUsed = parseFloat(keyInfo.devPlanPremiumCreditsUsed || "0");
	const premLimit = parseFloat(keyInfo.devPlanPremiumWeeklyLimit || "0");
	const isPremCapped = isPremium && premLimit > 0 && premUsed >= premLimit;

	const pct = (totalUsed / limit) * 100;

	if (pct >= 100 || isPremCapped) {
		let resetDate: Date | null = null;
		if (isPremCapped && keyInfo.devPlanPremiumWeekResetsAt) {
			resetDate = new Date(keyInfo.devPlanPremiumWeekResetsAt);
		} else if (keyInfo.devPlanMonthResetsAt || keyInfo.devPlanMonthlyResetsAt) {
			resetDate = new Date((keyInfo.devPlanMonthResetsAt || keyInfo.devPlanMonthlyResetsAt) as string);
		} else if (keyInfo.devPlanPremiumWeekResetsAt) {
			const prem = new Date(keyInfo.devPlanPremiumWeekResetsAt);
			if (!isNaN(prem.getTime())) {
				resetDate = calculateNextMonthlyReset(prem, now);
			}
		}

		if (resetDate && !isNaN(resetDate.getTime())) {
			const relTime = formatRelativeTime(resetDate, now, false);
			return `sub ${relTime}`;
		}
		return `sub 100%`;
	}

	return `sub ${Math.round(pct)}%`;
}

export function formatDateTime(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function calculateNextMonthlyReset(premResetDate: Date, now: Date = new Date()): Date {
	const weekStart = new Date(premResetDate.getTime() - 7 * 24 * 60 * 60 * 1000);
	const targetDay = weekStart.getUTCDate();

	let year = weekStart.getUTCFullYear();
	let month = weekStart.getUTCMonth() + 1;

	while (true) {
		const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
		const day = Math.min(targetDay, daysInMonth);
		const candidate = new Date(
			Date.UTC(
				year,
				month,
				day,
				weekStart.getUTCHours(),
				weekStart.getUTCMinutes(),
				weekStart.getUTCSeconds(),
				weekStart.getUTCMilliseconds(),
			),
		);
		if (candidate.getTime() > now.getTime()) {
			return candidate;
		}
		month++;
		if (month > 11) {
			year++;
			month = 0;
		}
	}
}

export function formatSubscriptionStatus(keyInfo: DevPassKeyInfo | null, now: Date = new Date()): string {
	if (!keyInfo) return "Unavailable";

	const planType =
		keyInfo.devPlan && keyInfo.devPlan !== "none"
			? keyInfo.devPlan.charAt(0).toUpperCase() + keyInfo.devPlan.slice(1)
			: (keyInfo.label || "Pay-as-you-go");

	const used = parseFloat(keyInfo.devPlanCreditsUsed || keyInfo.usage || "0");
	const limit = parseFloat(keyInfo.devPlanCreditsLimit || "0");
	const remaining = parseFloat(keyInfo.devPlanCreditsRemaining || "0");

	const percentUsed = limit > 0 ? ((used / limit) * 100).toFixed(1) : null;

	const usageStr =
		percentUsed !== null
			? `${percentUsed}% ($${used.toFixed(2)} / $${limit.toFixed(2)} credits, $${remaining.toFixed(2)} remaining)`
			: `$${used.toFixed(2)} used`;

	const lines: string[] = [`Type: ${planType}`, `Usage: ${usageStr}`];

	if (keyInfo.devPlanPremiumWeeklyLimit) {
		const premUsed = parseFloat(keyInfo.devPlanPremiumCreditsUsed || "0");
		const premLimit = parseFloat(keyInfo.devPlanPremiumWeeklyLimit || "0");
		const premPct = premLimit > 0 ? ((premUsed / premLimit) * 100).toFixed(1) : "0.0";
		lines.push(`Premium Usage: ${premPct}% ($${premUsed.toFixed(2)} / $${premLimit.toFixed(2)} weekly limit)`);
	}

	if (keyInfo.devPlanPremiumWeekResetsAt) {
		const premResetDate = new Date(keyInfo.devPlanPremiumWeekResetsAt);
		if (!isNaN(premResetDate.getTime())) {
			lines.push(`Next Premium Reset: ${formatDateTime(premResetDate)} (${formatRelativeTime(premResetDate, now)})`);

			const monthResetDate =
				keyInfo.devPlanMonthResetsAt || keyInfo.devPlanMonthlyResetsAt
					? new Date((keyInfo.devPlanMonthResetsAt || keyInfo.devPlanMonthlyResetsAt) as string)
					: calculateNextMonthlyReset(premResetDate, now);

			if (!isNaN(monthResetDate.getTime())) {
				lines.push(
					`Next Monthly Reset: ${formatDateTime(monthResetDate)} (${formatRelativeTime(monthResetDate, now)})`,
				);
			}
		}
	} else if (keyInfo.devPlanMonthResetsAt || keyInfo.devPlanMonthlyResetsAt) {
		const monthResetDate = new Date((keyInfo.devPlanMonthResetsAt || keyInfo.devPlanMonthlyResetsAt) as string);
		if (!isNaN(monthResetDate.getTime())) {
			lines.push(
				`Next Monthly Reset: ${formatDateTime(monthResetDate)} (${formatRelativeTime(monthResetDate, now)})`,
			);
		}
	}

	return lines.map((l) => `\n  • ${l}`).join("");
}

export async function fetchDevPassKeyInfo(apiKey: string, signal?: AbortSignal): Promise<DevPassKeyInfo | null> {
	const response = await fetch(KEY_INFO_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": "devpass-pi-extension",
		},
		signal: signal ?? AbortSignal.timeout(6000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch DevPass key info: HTTP ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as { data?: DevPassKeyInfo } | DevPassKeyInfo;
	return "data" in payload && payload.data ? payload.data : (payload as DevPassKeyInfo);
}

export function registerDevPassProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: "$DEVPASS_API_KEY",
		api: "openai-completions",
		models,
	});
}

const DEVPASS_OVERFLOW_PATTERN =
	/context(_length_exceeded| window| maximum context)|prompt is too long|maximum token limit/i;

export default async function devpassPi(pi: ExtensionAPI): Promise<void> {
	const apiKey = resolveDevPassApiKey();
	const { models } = await loadModels(apiKey);

	registerDevPassProvider(pi, models);

	let cachedKeyInfo: DevPassKeyInfo | null = null;
	let sessionAdditionalCost = 0;

	function updateStatusLine(ctx: {
		model?: { provider?: string; cost?: { input?: number; output?: number } };
		ui: { setStatus: (key: string, text: string | undefined) => void };
	}) {
		if (ctx.model?.provider !== PROVIDER_ID) {
			ctx.ui.setStatus(PROVIDER_ID, undefined);
			return;
		}
		const isPrem = isPremiumModel(ctx.model);
		const text = formatStatusLineText(cachedKeyInfo, sessionAdditionalCost, isPrem);
		ctx.ui.setStatus(PROVIDER_ID, text);
	}

	// Update status on session start
	pi.on("session_start", async (_event, ctx) => {
		sessionAdditionalCost = 0;
		const key = resolveDevPassApiKey();
		if (key) {
			try {
				cachedKeyInfo = await fetchDevPassKeyInfo(key);
			} catch {
				// Silently ignore if offline
			}
		}
		updateStatusLine(ctx);
	});

	// Update status on model selection
	pi.on("model_select", async (_event, ctx) => {
		updateStatusLine(ctx);
	});

	// Context overflow auto-recovery hook & session usage cost tracking
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant") {
			const isDevPass = message.provider === PROVIDER_ID || ctx.model?.provider === PROVIDER_ID;
			if (isDevPass && message.usage?.cost?.total) {
				sessionAdditionalCost += message.usage.cost.total;
				updateStatusLine(ctx);
			}
		}

		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (message.provider !== PROVIDER_ID && ctx.model?.provider !== PROVIDER_ID) return;

		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!DEVPASS_OVERFLOW_PATTERN.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});

	// Register /devpass-refresh command to force reload model catalog
	pi.registerCommand("devpass-refresh", {
		description: "Refresh DevPass dynamic model catalog from LLM Gateway",
		handler: async (_args, ctx) => {
			const currentKey = resolveDevPassApiKey();
			if (!currentKey) {
				ctx.ui.notify(
					"No DevPass API key found. Add it to ~/.pi/agent/auth.json under \"devpass\" or set DEVPASS_API_KEY.",
					"warning",
				);
				return;
			}
			ctx.ui.notify("Fetching updated DevPass model catalog...", "info");
			try {
				const { models: freshModels, source } = await loadModels(currentKey, true);
				registerDevPassProvider(pi, freshModels);
				try {
					cachedKeyInfo = await fetchDevPassKeyInfo(currentKey);
					sessionAdditionalCost = 0;
					updateStatusLine(ctx);
				} catch {}
				ctx.ui.notify(
					`DevPass catalog refreshed: ${freshModels.length} models registered (${source}).`,
					"info",
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh DevPass catalog: ${msg}`, "error");
			}
		},
	});

	// Register /devpass-status command
	pi.registerCommand("devpass-status", {
		description: "Show DevPass provider and subscription status",
		handler: async (_args, ctx) => {
			const currentKey = resolveDevPassApiKey();
			const cached = loadCachedModels();
			const keyStatus = currentKey ? `Configured (${currentKey.slice(0, 10)}...)` : "Not configured";
			const cacheInfo = cached
				? `${Math.round((Date.now() - cached.timestamp) / 60000)}m ago (${cached.models.length} models)`
				: "No cache file";

			let subscriptionInfo = "Not configured";
			if (currentKey) {
				try {
					const keyInfo = await fetchDevPassKeyInfo(currentKey);
					cachedKeyInfo = keyInfo;
					sessionAdditionalCost = 0;
					updateStatusLine(ctx);
					subscriptionInfo = formatSubscriptionStatus(keyInfo);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					subscriptionInfo = `Unavailable (${msg})`;
				}
			}

			ctx.ui.notify(
				`DevPass Status:\n- Provider: ${PROVIDER_ID}\n- Base URL: ${BASE_URL}\n- API Key: ${keyStatus}\n- Cache: ${cacheInfo}\n- Subscription:${subscriptionInfo}`,
				"info",
			);
		},
	});
}
