# Security policy

## Reporting a vulnerability

Please report security problems privately: open the **Security** tab of this repository and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Please do not open a public issue
for a security problem. You will get an answer in the same thread.

## Supported versions

Only the latest release is supported. Fixes land in a new release; older versions are not patched.

## What this plugin accesses

- **Network:** your question (or, for cross-review, your plan text) is sent to the OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`), which forwards it to the model vendors you configured. `LLM_COUNCIL_API_URL` can change the address; a host other than openrouter.ai gets a warning because your key is sent there.
- **Secrets:** it reads `OPENROUTER_API_KEY` from the environment, or from `~/.config/llm-council/.env`. The key is sent only to the API address above.
- **Files it writes:** transcripts of every run under `~/.config/llm-council/sessions/` (folder `0700`, files `0600`), which contain the full question and all answers.
- **Programs it starts:** cross-review runs the local `codex` CLI read-only in the folder you give with `--cd`, if it is installed. Use `--no-codex` to skip it.
