import assert from "node:assert/strict";
import {
	calculateNextMonthlyReset,
	FALLBACK_MODELS,
	fetchDevPassKeyInfo,
	formatDateTime,
	formatRelativeTime,
	formatSubscriptionStatus,
	KEY_INFO_ENDPOINT,
	loadCachedModels,
	loadModels,
	mapRawModel,
	PROVIDER_ID,
	PROVIDER_NAME,
	resolveDevPassApiKey,
	saveCachedModels,
} from "./index.ts";

async function runTests() {
	console.log("Running devpass_pi tests...\n");

	// Test 1: Provider Constants
	assert.equal(PROVIDER_ID, "devpass");
	assert.equal(PROVIDER_NAME, "DevPass");
	console.log("✓ Provider constants verified");

	// Test 2: API Key Resolution
	const apiKey = resolveDevPassApiKey();
	assert.ok(apiKey, "Should resolve API key from auth.json or env");
	assert.ok(apiKey.startsWith("llmgtwy_"), "API key should start with llmgtwy_");
	console.log("✓ API key resolution verified:", apiKey.slice(0, 15) + "...");

	// Test 3: Raw Model Mapping
	const sampleRaw = {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		architecture: {
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
		},
		pricing: {
			prompt: "3.0e-6",
			completion: "15.0e-6",
			input_cache_read: "0.3e-6",
			input_cache_write: "3.75e-6",
		},
		context_length: 200000,
		max_output: 64000,
		providers: [
			{
				providerId: "anthropic",
				reasoning: true,
				reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
				vision: true,
			},
		],
	};

	const mapped = mapRawModel(sampleRaw as any);
	assert.ok(mapped, "Mapped model should not be null");
	assert.equal(mapped.id, "claude-sonnet-4-5");
	assert.equal(mapped.name, "Claude Sonnet 4.5");
	assert.deepEqual(mapped.input, ["text", "image"]);
	assert.equal(mapped.cost.input, 3.0);
	assert.equal(mapped.cost.output, 15.0);
	assert.equal(mapped.cost.cacheRead, 0.3);
	assert.equal(mapped.cost.cacheWrite, 3.75);
	assert.equal(mapped.contextWindow, 200000);
	assert.equal(mapped.maxTokens, 64000);
	assert.equal(mapped.reasoning, true);
	assert.ok(mapped.thinkingLevelMap);
	assert.equal(mapped.thinkingLevelMap.low, "low");
	assert.equal(mapped.thinkingLevelMap.medium, "medium");
	assert.equal(mapped.thinkingLevelMap.high, "high");
	assert.equal(mapped.thinkingLevelMap.xhigh, "xhigh");
	assert.equal(mapped.thinkingLevelMap.max, "max");
	assert.equal(mapped.compat?.supportsDeveloperRole, false);
	assert.equal(mapped.compat?.maxTokensField, "max_tokens");
	console.log("✓ Model metadata mapping verified");

	// Test 4: Filtering Deactivated & Non-Text Models
	const deactivated = mapRawModel({
		id: "old-model",
		deactivated_at: "2020-01-01T00:00:00.000Z",
	} as any);
	assert.equal(deactivated, null, "Should filter out past-deactivated models");

	const audioOnly = mapRawModel({
		id: "audio-gen",
		architecture: { output_modalities: ["audio"] },
	} as any);
	assert.equal(audioOnly, null, "Should filter out audio-only output models");

	const embedding = mapRawModel({
		id: "text-embedding-3-small",
		architecture: { output_modalities: ["text"] },
	} as any);
	assert.equal(embedding, null, "Should filter out embedding models");
	console.log("✓ Deactivated, non-text, and embedding model filtering verified");

	// Test 5: Fallback Models
	assert.ok(FALLBACK_MODELS.length > 10, "Should have rich list of fallback models");
	const gpt54 = FALLBACK_MODELS.find((m) => m.id === "gpt-5.4");
	assert.ok(gpt54, "Fallback models should include gpt-5.4");
	console.log("✓ Fallback models verified (count:", FALLBACK_MODELS.length, ")");

	// Test 6: Model Loading (Cache & Remote)
	const result = await loadModels(apiKey);
	assert.ok(result.models.length > 50, "Should load models");
	assert.ok(["remote", "cache"].includes(result.source), `Source should be remote or cache, got: ${result.source}`);
	console.log(`✓ Model catalog loading verified (${result.models.length} models from ${result.source})`);

	// Test 7: Cache Round-trip
	saveCachedModels(result.models);
	const cached = loadCachedModels();
	assert.ok(cached, "Cached models should be readable");
	assert.equal(cached.models.length, result.models.length);
	console.log("✓ Cache serialization and deserialization verified");

	// Test 8: Relative Time & Date Formatting
	const now = new Date("2026-08-22T12:00:00.000Z");
	const futureDays = new Date("2026-08-28T18:00:00.000Z");
	assert.equal(formatRelativeTime(futureDays, now), "in 6d 6h");
	assert.equal(formatDateTime(now), "2026-08-22 12:00:00 UTC");
	console.log("✓ Relative time and date formatting verified");

	// Test 9: Monthly Reset Calculation
	const premReset = new Date("2026-08-28T15:49:09.656Z");
	const monthlyReset = calculateNextMonthlyReset(premReset, now);
	assert.equal(monthlyReset.toISOString(), "2026-09-21T15:49:09.656Z");
	console.log("✓ Monthly reset calculation verified");

	// Test 10: Subscription Status Formatting
	const sampleKeyInfo = {
		label: "Dev Plan API Key",
		usage: "7.6981027682",
		limit: null,
		devPlan: "lite",
		devPlanCreditsUsed: "7.6981027682",
		devPlanCreditsLimit: "87",
		devPlanCreditsRemaining: "79.30",
		devPlanPremiumWeeklyLimit: "10.44",
		devPlanPremiumCreditsUsed: "0.00",
		devPlanPremiumWeekResetsAt: "2026-08-28T15:49:09.656Z",
	};
	const statusStr = formatSubscriptionStatus(sampleKeyInfo, now);
	assert.ok(statusStr.includes("Type: Lite"), "Should format type");
	assert.ok(statusStr.includes("8.8%"), "Should format % used");
	assert.ok(statusStr.includes("Next Premium Reset:"), "Should format premium reset");
	assert.ok(statusStr.includes("Next Monthly Reset:"), "Should format monthly reset");
	console.log("✓ Subscription status formatting verified");

	// Test 11: Live Key Info Fetch (read-only GET /v1/key, consumes 0 LLM credits)
	if (apiKey) {
		const liveKeyInfo = await fetchDevPassKeyInfo(apiKey);
		assert.ok(liveKeyInfo, "Key info should be returned");
		assert.ok(liveKeyInfo.devPlan, "devPlan should be present");
		console.log(`✓ Live key info fetched successfully (Plan: ${liveKeyInfo.devPlan}, Usage: ${liveKeyInfo.devPlanCreditsUsed}/${liveKeyInfo.devPlanCreditsLimit})`);
	}

	console.log("\nAll tests passed successfully! 🎉");
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
