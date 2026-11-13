# Changelog

All notable changes to this plugin. Versions follow `.claude-plugin/plugin.json`.

## 0.3.6 (2026-11-13)

- Both skills: version and tags, plus Purpose, Prerequisites, Limitations and Troubleshooting sections.
- README: demo video and skill score badges; adds SECURITY.md.

## 0.3.5 (2026-11-13)

- Add author metadata, Instructions and Examples to SKILL.md.

## 0.3.4 (2026-11-12)

- Council: saves the transcript after every stage and on abort, retries 429/5xx with backoff, requires https for `LLM_COUNCIL_API_URL`.
- cross-review: kills the process group on timeout and stops reviewers if it is killed; a chairman failure or a simulated Codex no longer counts as an answer.
- The skill runs the council in the background.

## 0.3.3 (2026-11-11)

- Points to the catalog repo's new name, `lucas-tools`.

## 0.3.2 (2026-11-11)

- Catalog renamed to `lucas-tools`.

## 0.3.1 (2026-11-09)

- Docs: one-line description, catalog install, heading names.

## 0.3.0 (2026-11-08)

- New skill cross-review: send the same plan to the LLM council and to Codex and merge the answers.
- Timeouts kill the process tree; `--cd`, command quoting, cleanup and status fixes.
- CI runs the tests on Linux, macOS and Windows.

## 0.2.0 (2026-11-08)

- Safe question passing, strict ballots, safer transcripts.

## 0.1.0 (2026-11-08)

- First release: a multi-vendor LLM council as a Claude Code plugin.
