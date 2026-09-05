import assert from "node:assert/strict";
import {
	calculateNextMonthlyReset,
	deriveThinkingLevelMap,
	FALLBACK_MODELS,
	fetchDevPassKeyInfo,
	formatCwdForFooter,
	formatDateTime,
	formatRelativeTime,
	formatStatusLineText,
	formatSubscriptionStatus,
	formatTokens,
	isPremiumModel,
	KEY_INFO_ENDPOINT,
	loadCachedModels,
	loadModels,
	mapRawModel,
	PROVIDER_ID,
	PROVIDER_NAME,
	resolveDevPassApiKey,
	saveCachedModels,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
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

	// Test 3b: "none" maps to an explicit thinkingLevelMap.off
	// Models that think by default need off: "none"; omitting reasoning_effort
	// entirely (the old behaviour) leaves them thinking.
	const withNone = mapRawModel({
		id: "qwen3.8-flash",
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		providers: [
			{
				providerId: "alibaba",
				reasoning: true,
				// The gateway catalog over-advertises here: the model card documents
				// only low/medium/xhigh. off is what this test is about, so the
				// over-advertised tiers are asserted as mapped, not as correct.
				reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
			},
		],
	} as any);
	assert.equal(withNone?.thinkingLevelMap?.off, "none", 'catalog "none" should map to off');
	console.log("✓ Explicit off (reasoning_efforts: [\"none\"]) maps to thinkingLevelMap.off");

	// Models without "none" must keep off absent (not null), so pi can still
	// disable thinking by omitting the parameter.
	const withoutNone = mapRawModel({
		id: "gemini-3.7-flash",
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		providers: [
			{
				providerId: "google-ai-studio",
				reasoning: true,
				reasoning_efforts: ["minimal", "low", "medium", "high"],
			},
		],
	} as any);
	assert.ok(withoutNone?.thinkingLevelMap, "reasoning model should have a level map");
	assert.equal(
		"off" in withoutNone!.thinkingLevelMap!,
		false,
		"off must stay absent when the catalog has no \"none\"",
	);
	assert.equal(withoutNone?.thinkingLevelMap?.xhigh, null, "unsupported tiers are still nulled");
	console.log("✓ Models without \"none\" leave thinkingLevelMap.off unset");

	// Test 3c: effort levels are intersected across providers, not unioned, so one
	// over-declaring route cannot widen a model's advertised capability.
	const disagree = [
		{ providerId: "zai", reasoning: true, reasoning_efforts: ["low", "high", "max"] },
		{ providerId: "novita", reasoning: true, reasoning_efforts: ["low", "high", "max"] },
		{ providerId: "scx-ai-gp", reasoning: true, reasoning_efforts: ["low", "high", "max"] },
		// Real glm-5.3-flash data: this lone route advertises everything.
		{
			providerId: "runware",
			reasoning: true,
			reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
	];
	const intersected = deriveThinkingLevelMap(disagree as any);
	assert.equal(intersected?.low, "low", "tier agreed by all declaring providers is kept");
	assert.equal(intersected?.high, "high", "tier agreed by all declaring providers is kept");
	assert.equal(intersected?.max, "max", "tier agreed by all declaring providers is kept");
	assert.equal(intersected?.medium, null, "tier claimed by only one provider is hidden");
	assert.equal(intersected?.xhigh, null, "tier claimed by only one provider is hidden");
	// minimal aliases onto low rather than disappearing, matching prior behaviour.
	assert.equal(intersected?.minimal, "low", "minimal falls back to the lowest shared tier");
	// "none" is ORed, not intersected: it is a capability, not a ranking.
	assert.equal(intersected?.off, "none", 'off survives when only one route lists "none"');
	console.log("✓ Effort tiers are intersected across providers while off is ORed");

	// A provider declaring no tiers is unknown, not maximally restricted. minimax-m3
	// is served by minimax (all tiers) and together-ai (["none"] only); excluding the
	// latter keeps the map usable instead of collapsing it to off.
	const unknownRoute = deriveThinkingLevelMap([
		{
			providerId: "minimax",
			reasoning: true,
			reasoning_efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		},
		{ providerId: "together-ai", reasoning: true, reasoning_efforts: ["none"] },
	] as any);
	assert.equal(unknownRoute?.low, "low", "a route with no declared tiers must not veto");
	assert.equal(unknownRoute?.minimal, "minimal", "a route with no declared tiers must not veto");
	assert.equal(unknownRoute?.max, "max", "a route with no declared tiers must not veto");
	console.log("✓ Providers declaring no tiers are excluded from the intersection");

	// deepseek-v4-flash has 12 routes with no tier in common. Falling back to union
	// would restore the over-advertising, so a strict majority decides instead.
	const noConsensus = deriveThinkingLevelMap([
		{ providerId: "a", reasoning: true, reasoning_efforts: ["low", "high", "max"] },
		{ providerId: "b", reasoning: true, reasoning_efforts: ["high", "xhigh", "max"] },
		{ providerId: "c", reasoning: true, reasoning_efforts: ["medium", "high"] },
	] as any);
	assert.equal(noConsensus?.high, "high", "majority tier is offered when intersection is empty");
	assert.equal(noConsensus?.medium, null, "non-majority tier stays hidden when intersection is empty");
	assert.equal(noConsensus?.low, null, "non-majority tier stays hidden when intersection is empty");
	console.log("✓ Empty intersection falls back to majority tiers, not union");

	// Degenerate inputs must not produce a bogus map.
	assert.equal(deriveThinkingLevelMap([] as any), undefined, "no providers -> no map");
	assert.equal(
		deriveThinkingLevelMap([{ providerId: "x", reasoning: true }] as any),
		undefined,
		"providers with no efforts at all -> no map",
	);
	const explicitOnly = deriveThinkingLevelMap([
		{ providerId: "x", reasoning: true, reasoning_efforts: ["none"] },
	] as any);
	assert.equal(explicitOnly?.off, "none", 'a route declaring only "none" still enables off');
	assert.equal(explicitOnly?.low, null, 'a route declaring only "none" advertises no tiers');
	console.log("✓ Degenerate provider lists map sensibly");

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

	// Test 11: Statusline Formatting & Premium Detection
	assert.equal(isPremiumModel({ cost: { input: 5.0, output: 25.0 } }), true);
	assert.equal(isPremiumModel({ cost: { input: 0.3, output: 2.5 } }), false);
	assert.equal(formatStatusLineText(sampleKeyInfo, 0, false, now), "sub 9%");
	assert.equal(formatStatusLineText(sampleKeyInfo, 10.0, false, now), "sub 20%");
	assert.equal(formatStatusLineText(sampleKeyInfo, 85.0, false, now), "sub 30d 3h");

	// Premium capped statusline check
	const cappedKeyInfo = {
		...sampleKeyInfo,
		devPlanPremiumCreditsUsed: "10.44",
	};
	assert.equal(formatStatusLineText(cappedKeyInfo, 0, true, now), "sub 6d 3h");
	assert.equal(formatStatusLineText(cappedKeyInfo, 0, false, now), "sub 9%");
	console.log("✓ Statusline text formatting and premium threshold verified");

	// Test 12: Footer Formatting Helpers
	assert.equal(formatTokens(500), "500");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(25000), "25k");
	assert.equal(formatTokens(1500000), "1.5M");
	assert.equal(stripAnsi("\x1b[31mRed\x1b[0m"), "Red");
	assert.equal(visibleWidth("\x1b[32mGreen\x1b[0m"), 5);
	assert.equal(truncateToWidth("HelloWorld", 6, "..."), "Hel...");
	console.log("✓ Footer formatting helpers verified");

	// Test 13: Live Key Info Fetch (read-only GET /v1/key, consumes 0 LLM credits)
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
