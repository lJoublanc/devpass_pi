# devpass_pi

`devpass_pi` is a Pi coding agent extension that adds **DevPass** (LLM Gateway) as a first-class provider with automatic dynamic model catalog discovery.

## Features

- **Dynamic Model Catalog**: Automatically fetches and registers all 200+ available models from `https://api.llmgateway.io/v1/models` on startup — no need to configure model lists manually!
- **Zero Config Setup**: Uses the `devpass` credentials stored in `~/.pi/agent/auth.json` (or `DEVPASS_API_KEY` / `LLMGATEWAY_API_KEY` environment variables).
- **Accurate Pricing & Token Limits**: Automatically maps per-token pricing to Pi's per-million token cost tracking, along with context windows, max tokens, and input modalities (text, vision).
- **Extended Thinking / Reasoning**: Detects reasoning capabilities on models (e.g. OpenAI o-series, DeepSeek R1/V3.x, Claude extended thinking, Qwen thinking) and wires up thinking levels (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- **Offline & Startup Resilience**: Caches fetched model metadata locally in `~/.pi/agent/devpass-models-cache.json` with a 24-hour TTL, falling back to cached or built-in flagship models if offline or if network requests time out.
- **Context Overflow Auto-Recovery**: Catches context overflow errors and normalizes them for Pi's automatic compaction and retry flow.
- **Commands**:
  - `/devpass-refresh` - Force-refreshes the remote model catalog and registers new models immediately without restarting.
  - `/devpass-status` - Displays current DevPass configuration, API key status, subscription status (plan type, % used, premium & monthly resets), and cache information.

## Installation

The extension is installed globally at `~/.pi/agent/extensions/devpass_pi.ts`. Pi auto-discovers it on startup.

To install or update:
```bash
cp index.ts ~/.pi/agent/extensions/devpass_pi.ts
```

## Authentication

Add your DevPass API key to Pi via `auth.json`:

```json
// ~/.pi/agent/auth.json
{
  "devpass": {
    "key": "llmgtwy_your_api_key_here",
    "type": "api_key"
  }
}
```

Or set the environment variable in your shell:

```bash
export DEVPASS_API_KEY="llmgtwy_your_api_key_here"
```

## Usage

Select any DevPass model using `/model` or the `--model` flag:

```bash
# Using flagship Claude model
pi --model devpass/claude-sonnet-4-6

# Using flagship GPT model
pi --model devpass/gpt-5.4

# Using DeepSeek
pi --model devpass/deepseek-v4

# Using Gemini
pi --model devpass/gemini-3.1-pro-preview
```

To list all available DevPass models:
```bash
pi --list-models | grep devpass
```

## Commands

- `/devpass-refresh` — Fetch the latest model catalog from LLM Gateway and re-register provider models in the current session.
- `/devpass-status` — Show the active DevPass API key status, subscription status (plan type, % used, premium & monthly resets), and model cache state.
