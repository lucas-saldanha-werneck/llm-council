# llm-council

Ask several LLMs from different vendors the same question from inside Claude Code. Each model
answers on its own, then ranks the other answers without knowing who wrote them, and a chairman
model writes one final answer. Use it when you want a decision checked by models that weren't
trained by the same company.

The idea and the three stages come from Andrej Karpathy's
[llm-council](https://github.com/karpathy/llm-council), which is a web app. This plugin runs the
same flow as a Claude Code skill: one Node script that calls the OpenRouter API, with no server
or browser.

## What Claude sees

Ask Claude something like "ask the llm council whether we should use Postgres or SQLite for a
small internal tool". The skill runs the script and Claude gets this back (output of
`--dry-run`, which fakes the model answers):

```
## Council final answer

[dry-run] Simulated answer from anthropic/claude-fable-5. {"ranking": ["A", "B", "C", "D"], "assessments": {"A": "solid", "B": "good", "C": "ok", "D": "weak"}}

## Ranking (anonymous cross-review)

| # | Model | Answer | Mean position |
|---|-------|--------|---------------|
| 1 | x-ai/grok-4.5 | A | 1.00 |
| 2 | anthropic/claude-fable-5 | B | 2.00 |
| 3 | openai/gpt-5.6-terra | C | 3.00 |
| 4 | google/gemini-3.1-pro-preview | D | 4.00 |

Cost: US$ 0.0000 | Tokens: 0 | Full transcript: /home/you/.config/llm-council/sessions/2026-11-08T13-36-42-should-i-use-postgres-or-sqlite-for-a-small-intern.md
```

In a real run the final answer is the chairman's synthesis, and the cost line shows what
OpenRouter charged. Claude shows you the final answer, the ranking, the cost and the transcript
path. The transcript has every model's full answer and every review.

## Install

You need Node.js 18 or newer and an [OpenRouter](https://openrouter.ai) API key with credits.

```
/plugin marketplace add lucas-saldanha-werneck/llm-council
/plugin install llm-council@llm-council
```

Then give the script your key. Either set it in the environment you start Claude Code from:

```bash
export OPENROUTER_API_KEY=...
```

or save it in a file the script reads when the variable is not set:

```bash
mkdir -p ~/.config/llm-council
printf 'OPENROUTER_API_KEY=%s\n' "PASTE_YOUR_KEY" > ~/.config/llm-council/.env
chmod 600 ~/.config/llm-council/.env
```

Check the install without spending credits by asking Claude to run the council with `--dry-run`.

## Cost

OpenRouter bills each call at the model's listed price. The script adds up the `cost` that
OpenRouter returns and prints it after each run.

A rough figure for the default models, using OpenRouter's prices on 2026-11-08 and these
assumptions: a 500-token question, 1,500-token answers, 400-token reviews and a 2,000-token
final answer. That is about 37,000 input and 9,600 output tokens, and comes to about
US$0.45 per run. Most of it is the chairman and Claude Fable 5, the most expensive model in
the set. Long questions, long answers and models that bill reasoning tokens cost more.

## Config

The defaults are in `skills/llm-council/config.json`. To change them, create
`~/.config/llm-council/config.json` with only the keys you want to override. Don't edit the
bundled file: plugin updates replace it.

```json
{
  "council": [
    { "model": "openai/gpt-5.6-terra" },
    { "model": "deepseek/deepseek-v4-pro" },
    { "model": "google/gemini-3.1-pro-preview" }
  ],
  "chairman": { "model": "google/gemini-3.1-pro-preview" }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `council` | `openai/gpt-5.6-terra`, `anthropic/claude-fable-5`, `google/gemini-3.1-pro-preview`, `x-ai/grok-4.5` | Models that answer and review. At least 2. Each entry is `{ "model": "...", "fallback": "..." }`; `fallback` is optional. |
| `chairman` | `anthropic/claude-fable-5` | Model that writes the final answer. Same shape as a council entry. |
| `max_tokens` | `answer` 8000, `review` 3000, `final` 12000 | Output limit per call, by stage. You can override one stage only. |
| `temperature` | `0.7` | Sent with every call. |
| `timeout_ms` | `240000` | Time limit per call. |

Claude Fable 5 has `anthropic/claude-opus-4.8` as its fallback in the defaults. The script uses
a fallback only when the main model returns HTTP 404 or 400, or an error saying the model was
not found.

Model ids are listed at [openrouter.ai/models](https://openrouter.ai/models). All five ids above
were on OpenRouter's public model list on 2026-11-08.

Environment variables:

| Variable | Meaning |
|----------|---------|
| `OPENROUTER_API_KEY` | Your key. Read before the `.env` file. |
| `LLM_COUNCIL_MODELS` | Comma-separated model ids. Replaces `council`. |
| `LLM_COUNCIL_CHAIRMAN` | Model id. Replaces `chairman`. |
| `LLM_COUNCIL_DIR` | Folder for `config.json`, `.env` and `sessions/`. Default `~/.config/llm-council`. |
| `LLM_COUNCIL_API_URL` | Chat completions URL. Default OpenRouter's. The tests point it at a local fake server. |

`node skills/llm-council/scripts/council.mjs --show-config` prints the config in effect.

## Optional requirements

- **1Password CLI (`op`)**, if you keep the key in 1Password. Start Claude Code with
  `op run --env-file=<file> -- claude`, where the file maps `OPENROUTER_API_KEY` to your secret
  reference. Without `op`, use the environment variable or the `.env` file above.

## How it works

1. Every council model gets the question in parallel.
2. The answers are shuffled and labeled A, B, C... Every model that answered gets all of them,
   its own included, and returns a JSON ranking. The script averages each answer's position.
3. The chairman gets the question, all answers with model names, and all reviews, and writes
   the final answer. It ends with a "Disagreements" section when members disagree.

Every prompt asks the models to answer in the language of your question. If fewer than 2
models answer in stage 1, the run stops. If the chairman fails, you still get the ranking and
the transcript. Exit codes: 1 for a bad config or no question, 2 for no API key, 3 for fewer
than 2 answers.

Your question goes to OpenRouter and to every model's vendor. Transcripts are saved as `0600`
files in `~/.config/llm-council/sessions/` and are never deleted by the plugin.

## Uninstall

```
/plugin uninstall llm-council@llm-council
/plugin marketplace remove llm-council
```

Your config, key file and transcripts stay in `~/.config/llm-council/`. Delete that folder to
remove them.

## Tests

```bash
node --test tests/test_council.mjs
```

The tests run the script against a local fake OpenRouter server. They never call the real API.

## Limits

- The test suite fakes every HTTP reply. A live run against OpenRouter was not made for this
  release.
- Tested on macOS with Node.js 26 and Claude Code 2.1.319. Not tested on Linux or Windows.
- Models come and go on OpenRouter. If a default disappears, override it in your config.

## License

MIT. See [LICENSE](LICENSE).

Built with Claude Code
