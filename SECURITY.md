# Security policy

## Reporting a vulnerability

Please report security problems privately: open the **Security** tab of this repository and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Please do not open a public issue
for a security problem. You will get an answer in the same thread.

## Supported versions

Only the latest release is supported. Fixes land in a new release; older versions are not patched.

## What this plugin accesses

- **Network (OpenRouter):** your question (or, for cross-review, your plan text) is sent to the OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`), which forwards it to the model vendors you configured. `LLM_COUNCIL_API_URL` can change the address (https only, or plain http to localhost); a host other than openrouter.ai gets a warning because your key is sent there.
- **Network (Codex):** cross-review also runs the local `codex` CLI (`codex exec -s read-only`) on the same plan, in the folder given with `--cd` (default: the current folder). Codex sends the plan, and any files it reads in that folder, to OpenAI under your own Codex login. `--no-codex` skips it; `CROSS_REVIEW_CODEX` can point to another binary.
- **Secrets:** it reads `OPENROUTER_API_KEY` from the environment, or from `~/.config/llm-council/.env`. The key is sent only as a Bearer header to the API address above.
- **Files:** it reads `~/.config/llm-council/config.json` if present and writes transcripts of every run under `~/.config/llm-council/sessions/` (folder `0700`, files `0600`), which contain the full question and all answers. `LLM_COUNCIL_DIR` moves this whole folder, `.env` included. Cross-review keeps the plan in a temporary folder (file `0600`) that it deletes when it ends.
- **Programs it starts:** `node` for the council script, the `codex` CLI as above, and a small `node` watchdog that kills them if cross-review is stopped.
