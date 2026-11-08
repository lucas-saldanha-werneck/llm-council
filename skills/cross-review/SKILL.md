---
name: cross-review
description: Cross-review a plan or decision by outside models. Sends the same text, in parallel, to the LLM council (GPT, Gemini, Grok, Claude via OpenRouter) and to OpenAI Codex in a read-only sandbox, then merges both answers into one table of findings. Codex is optional; without the codex CLI it is a council-only review. Use when the user says "cross-review", "council and codex", "llm council and an adversarial codex", "have the other models check this plan", "check with the council and Codex whether option A is the best", or wants a plan stress-tested by several vendors before acting. Spends the user's OpenRouter credits (and Codex usage, if installed).
---

# Cross-review: LLM council + Codex on the same text

Two independent opinions on one plan or decision, at the same time. The script
`scripts/cross-review.mjs` runs both and prints both answers; your job is to merge them.
Don't rebuild either reviewer by hand.

## How to run

1. **Input.** If the user gave a file, use it as is. If they gave text, or the plan is in this
   conversation, write it in full, unchanged, to a new temporary file with the Write tool. If it is
   unclear what to review, say in one line what you are going to review. If the user compares
   options ("is A the best?"), include every option in the file.
2. If the question looks trivial and not worth the credits, ask the user before running.
3. Run (Bash timeout at least 900000 ms; a run usually takes 2 to 6 minutes):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/cross-review/scripts/cross-review.mjs" --plan-file "/path/to/plan.md"
```

- Never put the plan text in the shell command; only the file path goes there. `--plan-file -` reads stdin.
- `--cd <folder>` lets Codex read that folder (read-only) for context; default is the current folder.
- `--no-codex` runs the council only. `--dry-run` fakes the council and does not start Codex (no cost).
- Codex always runs with `codex exec -s read-only`: it cannot write files. Never change that.
- Both reviewers get exactly the same prompt (the plan plus: Is it right? What is missing? What is
  the biggest risk? Is there a better option?). Don't run either one again with a different summary.

## Merge the answers

Read both sections of the output (`## LLM council` and `## Codex (read-only)`) and give the user
one table:

| Finding | Found by (Council / Codex / both) | Severity (high/medium/low) | Do they agree? |
|---|---|---|---|

Then one paragraph: the combined recommendation and where the two disagree.

Footer: the council cost (from its `Cost:` line), the council transcript path, and the
cross-review transcript path (from `## Status`).

## When something fails

- `- Codex: not installed`: say it was a council-only review, because the `codex` CLI is not on
  PATH. Codex is optional.
- One reviewer failed: deliver the other and say which one failed, with the real error from the
  output. Exit code 0 means at least one answered.
- Exit code 5: neither answered. Show both errors. Council exit code 2 means no OpenRouter key;
  see the llm-council skill for the fixes.
- Exit code 1: missing or unreadable plan file, or a bad argument.
