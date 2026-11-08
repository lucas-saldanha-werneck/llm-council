---
name: llm-council
description: Ask a council of LLMs from different vendors (by default GPT-5.6 Terra, Claude Fable 5, Gemini 3.1 Pro and Grok 4.5) through OpenRouter. Each model answers in parallel, then reviews and ranks the other answers anonymously, and a chairman model writes the final answer. Use when the user asks for the "llm council", "ask the council of LLMs", "ask the other models", "what do other LLMs think", "a second opinion from several models or vendors", "compare GPT, Gemini, Grok and Claude", or wants an important decision checked by models from different companies. It spends the user's OpenRouter credits.
---

# LLM Council

Runs the three stages of Andrej Karpathy's llm-council by calling the OpenRouter API directly, with no web app.
The script `scripts/council.mjs` does all of it. Don't rebuild the flow by hand.

## How to run

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/llm-council/scripts/council.mjs" "the user's question"
```

- Pass the user's question in full as one quoted argument. Don't summarize it.
- Progress goes to stderr. The final result goes to stdout as markdown.
- A run usually takes 1 to 3 minutes (three rounds of parallel calls). Use a Bash timeout of at least 300000 ms.
- Each run spends the user's OpenRouter credits. If the question looks trivial, ask the user before running.

## What to do with the result

1. Show the user the **Council final answer** (the chairman's synthesis) in full.
2. Show the **ranking table** (how the models rated each other's anonymous answers).
3. Give the cost of the run and the path of the full transcript. Transcripts (every answer and every review) are saved in `~/.config/llm-council/sessions/`, or in `$LLM_COUNCIL_DIR/sessions/` if that variable is set.
4. If the user wants one model's own answer, read the saved transcript. Don't run the council again.

## Errors

- **Exit code 2 (no API key):** tell the user to set `OPENROUTER_API_KEY` in the environment Claude Code runs in, or to save it in `~/.config/llm-council/.env` as `OPENROUTER_API_KEY=...` with `chmod 600`. Keys are created at https://openrouter.ai/keys and need prepaid credits. Never ask the user to paste the key into the chat.
- **Exit code 3 (fewer than 2 members answered):** usually no credits left or an OpenRouter outage. The user can check the balance at https://openrouter.ai/credits.
- **Exit code 1:** bad config or missing question. The message says which.
- **Model gone (404 or 400):** the script already tries the `fallback` model when one is set. If a model was removed from OpenRouter, change it in the user config (below).

## Config

Defaults live in `${CLAUDE_PLUGIN_ROOT}/skills/llm-council/config.json`. Don't edit that file: plugin updates replace it.
To change models, write `~/.config/llm-council/config.json` with only the keys to override, for example:

```json
{ "council": [ { "model": "openai/gpt-5.6-terra" }, { "model": "deepseek/deepseek-v4-pro" } ] }
```

Or set `LLM_COUNCIL_MODELS` (comma-separated model ids) and `LLM_COUNCIL_CHAIRMAN`. Valid ids are listed at https://openrouter.ai/models.
`node "${CLAUDE_PLUGIN_ROOT}/skills/llm-council/scripts/council.mjs" --show-config` prints the config in effect.

## Test without spending credits

`--dry-run` fakes the answers and runs the whole pipeline:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/llm-council/scripts/council.mjs" --dry-run "test"
```
