# llm-council

Ask several LLMs from different vendors the same question from inside Claude Code. Each model
answers on its own, then ranks the other answers without knowing who wrote them, and a chairman
model writes one final answer. Use it when you want a decision checked by models that weren't
trained by the same company.

The idea and the three stages come from Andrej Karpathy's
[llm-council](https://github.com/karpathy/llm-council), which is a web app. This plugin runs the
same flow as a Claude Code skill: one Node script that calls the OpenRouter API, with no server
or browser.

The plugin also has a second skill, [cross-review](#cross-review-council--codex): it sends the same
plan to the council and to OpenAI's Codex at the same time, and Claude merges both answers into
one table of findings.

## What Claude sees

Ask Claude something like "ask the llm council whether we should use Postgres or SQLite for a
small internal tool". Claude writes your question to a temporary file, runs the script with
`--question-file`, and gets this back (output of `--dry-run`, which fakes the model answers):

```
## Council final answer

[dry-run] Simulated answer from anthropic/claude-fable-5.

## Ranking (anonymous cross-review)

| # | Model | Answer | Mean position |
|---|-------|--------|---------------|
| 1 | x-ai/grok-4.5 | A | 1.00 |
| 2 | anthropic/claude-fable-5 | B | 2.00 |
| 3 | openai/gpt-5.6-terra | C | 3.00 |
| 4 | google/gemini-3.1-pro-preview | D | 4.00 |

Valid rankings: 4 of 4 reviews.

Cost: US$ 0.0000 | Tokens: 0 | Full transcript: /home/you/.config/llm-council/sessions/2026-11-08T14-08-41-should-i-use-postgres-or-sqlite-for-a-small-intern-cdd7092c.md
```

In a real run the final answer is the chairman's synthesis, and the cost line shows what
OpenRouter charged. Claude shows you the final answer, the ranking, the cost and the transcript
path. The transcript has every model's full answer and every review.

## Install

You need Node.js 18 or newer and an [OpenRouter](https://openrouter.ai) API key with credits.

```
/plugin marketplace add lucas-saldanha-werneck/claude-plugins
/plugin install llm-council@lucas-tools
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

## Settings

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

## Passing the question

The skill tells Claude to write your question to a file and run
`council.mjs --question-file <file>`, so the question never goes inside a shell command.
Questions about code often contain `$(...)`, backticks or quotes, and a shell would run or
change them. `--question-file -` reads the question from stdin. A plain quoted argument,
`council.mjs "question"`, still works when you run the script by hand.

This is an instruction to Claude, not a sandbox. Whether you see each command before it runs
depends on your Claude Code permission settings.

## Cross-review (council + Codex)

Ask Claude to "cross-review this plan" or "check it with the council and Codex". Claude writes the
plan to a temporary file and runs:

```
node skills/cross-review/scripts/cross-review.mjs --plan-file /tmp/plan.md
```

The script builds one prompt (the plan, plus "Is it right? What is missing? What is the biggest
risk? Is there a better option?") and sends exactly that text, in parallel, to:

- the LLM council (`council.mjs --question-file`), and
- Codex, as `codex exec -s read-only --skip-git-repo-check -C <folder> -o <file> -`, with the
  prompt on stdin. The read-only sandbox means Codex can read the folder for context but cannot
  change anything.

It prints both answers and a status block (output of `--dry-run` with Codex not installed, cut):

```
# Cross-review

Both reviewers got the same text: /tmp/plan.md (74 chars). Codex is not installed: this is a council-only review.

## LLM council

## Council final answer
...

## Codex (read-only)

Not run: the `codex` CLI was not found on PATH, so this is a council-only review. ...

## Status

- Council: ok
- Codex: not installed
- Cross-review transcript: /home/you/.config/llm-council/sessions/2026-11-08T16-25-20-cross-review-49ea5147.md
```

Claude then gives you one table (finding, found by Council / Codex / both, severity, do they
agree) and a short combined recommendation.

Options: `--cd <folder>` (the folder Codex may read, default the current one), `--no-codex`,
`--dry-run` (fake council, Codex not started), `--plan-file -` (stdin).
`CROSS_REVIEW_CODEX` points at another `codex` binary; `CROSS_REVIEW_TIMEOUT_MS` (default
1500000, 25 min) limits each reviewer. The default covers the council's worst case (3 stages of
240 s calls plus a fallback retry); raise it if you raised the council's `timeout_ms`. A reviewer
that hits the limit is stopped with every process it started and reported as `timed out after N s`.

If one reviewer fails, you still get the other, with the real error of the one that failed.
Exit codes: 0 when at least one reviewer answered, 1 for a bad argument or plan file, 5 when
neither answered. The cross-review transcript (prompt and both answers) is saved as a `0600`
file next to the council transcripts.

## Optional requirements

- **Codex CLI (`codex`)**, for cross-review. Install it from
  [github.com/openai/codex](https://github.com/openai/codex) and sign in. Without it, cross-review
  runs the council alone and says so.
- **1Password CLI (`op`)**, if you keep the key in 1Password. Start Claude Code with
  `op run --env-file=<file> -- claude`, where the file maps `OPENROUTER_API_KEY` to your secret
  reference. Without `op`, use the environment variable or the `.env` file above.

## How it works

1. Every council model gets the question in parallel.
2. The answers are shuffled and labeled A, B, C... Every model that answered gets all of them,
   its own included, and returns a JSON ranking. A ranking counts only if it lists every answer
   exactly once; others are ignored. The script averages each answer's position over the valid
   rankings and says how many there were. If none is valid, it says the ranking is unavailable
   instead of printing an order.
3. The chairman gets the question, all answers with model names, and all reviews, and writes
   the final answer. It ends with a "Disagreements" section when members disagree.

Every prompt asks the models to answer in the language of your question. If fewer than 2
models answer in stage 1, the run stops. If the chairman fails, you still get the ranking and
the transcript.

When a model stops because it hit its `max_tokens` limit (OpenRouter reports
`finish_reason: "length"`), the script says so on stderr. A cut-off member answer gets a note
at its end, so reviewers and the chairman know it is incomplete. A cut-off final answer gets a
warning at its end that tells you to raise `max_tokens.final`.

Exit codes: 1 for a bad config, no question or an unreadable question file, 2 for no API key,
3 for fewer than 2 answers, 4 when the transcript folder can't be created or written. The
script checks that folder before the first paid call, so exit code 4 never costs credits.

Your question goes to OpenRouter and to every model's vendor. Transcripts are saved as `0600`
files in `~/.config/llm-council/sessions/` and are never deleted by the plugin. Each file name
ends with a random suffix and is created only if it does not exist yet, so two runs at the same
moment never overwrite each other. If saving still fails at the end of a run (for example a
full disk), you get the final answer, the ranking and the cost anyway, with a "Transcript not
saved" line in place of the path.

## Uninstall

```
/plugin uninstall llm-council@lucas-tools
```

Your config, key file and transcripts stay in `~/.config/llm-council/`. Delete that folder to
remove them.

## Tests

```bash
node --test tests/test_council.mjs
```

The tests run the scripts against a local fake OpenRouter server and a fake `codex`. They never
call the real API or the real Codex.

## Limits

- The test suite fakes every HTTP reply. A live run against OpenRouter was not made for this
  release.
- Cross-review was tested with a fake `codex` that records its arguments and stdin. It was not run
  against the real Codex CLI. The flags were checked against `codex exec --help` of codex-cli
  0.166.0.
- Tested on macOS with Node.js 26 and Claude Code 2.1.319. Not tested on Linux or Windows.
- Models come and go on OpenRouter. If a default disappears, override it in your config.

## License

MIT. See [LICENSE](LICENSE).

Built with Claude Code
