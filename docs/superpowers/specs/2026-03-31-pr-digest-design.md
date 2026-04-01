# PR Digest Skill — Design Spec

**Date:** 2026-03-31  
**Status:** Approved  
**Skill invocation:** `/pr-digest <github-repo-url>`

---

## Overview

A repeatable Claude skill that fetches merged PRs from a GitHub repository since the last digest, filters out maintenance and trivial changes, generates social copy for X (Twitter) and LinkedIn, posts a summary to Slack, and writes a dated markdown digest file. Designed to run on a recurring schedule. The target repo is treated as remote-only — no local clone is required.

---

## Architecture

Three layers:

### 1. `scripts/digest.js` (Node.js — data layer)
- Accepts a GitHub repo URL as CLI argument (e.g., `https://github.com/owner/repo`)
- Parses `owner` and `repo` from the URL
- Reads `state/<owner>-<repo>.json` from the `content-flywheel` project root to find `lastDigestAt` (defaults to 30 days ago if the file is missing — but does NOT create or write the file)
- Fetches merged PRs using the GitHub Search API: `GET /search/issues?q=is:pr+is:merged+repo:<owner>/<repo>+merged:><lastDigestAt>&per_page=100`
- Paginates through all results until exhausted (respects `X-RateLimit-Remaining`; exits with error if rate limit is hit mid-fetch)
- For each PR result, fetches additional detail: `GET /repos/<owner>/<repo>/pulls/<number>` to get labels, diff stats, and changed files
- Sends all requests with headers: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer $GITHUB_TOKEN`
- Applies heuristic pre-filter to drop obvious noise (see Filtering section)
- Outputs a structured JSON array of candidate PRs to stdout
- Does not write to disk under any circumstances

### 2. `skills/pr-digest.md` (Claude skill — intelligence layer)
- Receives the repo URL as input
- Ensures `state/` and `digests/` directories exist (creates them if not)
- Ensures `state/<owner>-<repo>.json` exists (creates it with a 30-day-ago `lastDigestAt` if not)
- Runs `digest.js` and captures JSON output
- Makes final judgment on each candidate PR: notable vs. skip
- Generates X and LinkedIn copy for notable PRs
- If zero notable PRs: updates state, exits silently with a terminal note
- If notable PRs exist: writes digest file, prints to terminal, posts to Slack, updates state

### 3. `state/<owner>-<repo>.json` (state — lives in `content-flywheel`)
- Contains a single `lastDigestAt` ISO timestamp
- Created by the skill on first run (with a 30-day-ago default), before invoking `digest.js`
- Updated by the skill at the end of a successful run (after digest file written and Slack posted)
- If Slack fails but digest was written: state is still updated (Slack failure is non-fatal, logged to terminal)
- If digest write fails: state is NOT updated (run is retryable)

---

## Data Flow

```
User: /pr-digest https://github.com/owner/repo
        │
        ▼
digest.js
  ├── parse owner/repo from URL
  ├── read state/<owner>-<repo>.json (or default to 30 days ago)
  ├── fetch merged PRs via GitHub Search API (paginated)
  ├── fetch PR detail for each result
  ├── heuristic pre-filter (drop noise)
  └── output JSON to stdout
        │
        ▼
Claude (pr-digest skill)
  ├── judge each candidate PR: notable or skip
  ├── if zero notable PRs → update state, print terminal note, exit
  └── if notable PRs:
        ├── generate X copy + LinkedIn copy per PR
        ├── write digests/YYYY-MM-DD.md (append -2, -3 if file exists)
        ├── print digest to terminal
        ├── POST summary to Slack webhook (non-fatal if fails)
        └── update state/<owner>-<repo>.json with current ISO timestamp
```

---

## Filtering

### Heuristic pre-filter (in `digest.js`)
Drop PRs matching any of:

**Labels:** `dependencies`, `chore`, `maintenance`, `automated`, `bot`

**Title patterns (case-insensitive):**
- `bump`
- `^chore[:(]`
- `^deps[:(]`
- `^fix typo`
- `renovate`
- `dependabot`
- `^ci[:(]`

### `digest.js` JSON output schema

Each element in the output array:

```json
{
  "number": 123,
  "title": "Add dark mode support",
  "body": "PR description text or empty string if none",
  "url": "https://github.com/owner/repo/pull/123",
  "mergedAt": "2026-03-28T14:22:00Z",
  "author": "username",
  "labels": ["feature", "ui"],
  "additions": 142,
  "deletions": 38,
  "changedFiles": 7
}
```

### Claude judgment pass (in skill)
For remaining candidates, Claude evaluates notability. A PR is notable if it meets **at least one** of:
- Introduces or changes user-facing functionality
- Adds a new API, CLI command, or integration
- Delivers a measurable performance improvement
- Fixes a bug that affected users in production
- Makes a meaningful architectural change worth communicating externally

A PR with only a title and no description is judged on title alone using the same criteria. If the title is too vague to assess (e.g., "updates"), skip it.

---

## Output

### Digest file: `digests/YYYY-MM-DD.md`
Written to the `content-flywheel` project directory. If `YYYY-MM-DD.md` already exists (e.g., re-run on same day), use `YYYY-MM-DD-2.md`, `YYYY-MM-DD-3.md`, etc.

File structure:

```markdown
# PR Digest — owner/repo — YYYY-MM-DD

_N notable PRs since YYYY-MM-DD_

---

## [PR Title](pr-url)

**X copy**
<= 280 chars. Lead with value, not PR number. Conversational but sharp. No hashtag spam.
One tweet only — do not produce thread copy.

**LinkedIn copy**
2–4 sentences. Professional tone. Open with the user benefit or impact.
End with a call to action or a link reference. Do not tag authors or use hashtags.

---
```

### Terminal output
Full digest printed to stdout on every successful run with notable PRs.

### Slack
POST to `$SLACK_WEBHOOK_URL` with the following JSON payload:

```json
{
  "text": "🗞 PR Digest — <repo> (<date>)",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🗞 *PR Digest — <repo>* (<date>)\n\n• <PR URL|PR Title> — <X copy>\n• <PR URL|PR Title> — <X copy>"
      }
    }
  ]
}
```

One bullet per notable PR. `<X copy>` is truncated to 120 chars in the Slack message (full copy lives in the digest file). Only fires when there are notable PRs.

PR titles embedded in the Slack payload must have `>` escaped to `&gt;` and `|` replaced with `-` to avoid breaking mrkdwn link syntax.

### Silent skip
If no notable PRs: update `state/<owner>-<repo>.json`, print a brief terminal note (e.g., `No notable PRs since <date>. State updated.`), exit with code 0.

---

## File Structure

```
content-flywheel/
├── skills/
│   └── pr-digest.md
├── scripts/
│   └── digest.js
├── state/
│   └── <owner>-<repo>.json   # per-repo digest state (gitignored)
├── digests/
│   └── YYYY-MM-DD.md         # generated output (committed or gitignored, user's choice)
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-03-31-pr-digest-design.md
```

---

## Configuration

All config via environment variables:

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub API auth (classic token or fine-grained with `repo` read scope) |
| `SLACK_WEBHOOK_URL` | No (recommended) | Slack incoming webhook URL. If absent, Slack posting is silently skipped. |
| `DIGEST_REPO` | No | Default repo URL; CLI argument takes precedence if both are set |

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `GITHUB_TOKEN` missing | Exit with error before any API calls |
| GitHub API 401/403 | Exit with error message, no state update |
| GitHub API 404 | Exit with "repo not found" error |
| GitHub API 429 / rate limit hit mid-fetch | Exit with error; state not updated (run is retryable) |
| `digest.js` exits non-zero | Skill halts, surfaces error to terminal |
| `state/` directory missing | Skill creates it before invoking `digest.js` |
| `digests/` directory missing | Skill creates it before writing digest file |
| `SLACK_WEBHOOK_URL` not set | Slack step is silently skipped; run completes normally |
| Slack webhook fails (HTTP error) | Log warning to terminal, continue — state still updates |
| Digest file write fails | Log error, do not update state (run is retryable) |

---

## Skill Prompt Structure (`skills/pr-digest.md`)

1. **Trigger** — `/pr-digest <github-repo-url>`
2. **Step 1: Run script** — `node scripts/digest.js <repo-url>`, capture JSON output; halt on non-zero exit
3. **Step 2: Judge PRs** — evaluate each candidate against notability criteria
4. **Step 3: Silent skip check** — if zero notable PRs, update state and exit
5. **Step 4: Write copy** — X (≤280 chars) and LinkedIn (2–4 sentences) per notable PR
6. **Step 5: Write digest file** — `digests/YYYY-MM-DD.md` (with suffix if collision)
7. **Step 6: Print to terminal**
8. **Step 7: Post to Slack** — HTTP POST to `$SLACK_WEBHOOK_URL` (non-fatal)
9. **Step 8: Update state** — write current ISO timestamp to `state/<owner>-<repo>.json`

---

## Scheduling

The skill is designed to run on a repeating interval via Claude Code's `schedule` skill (cron-based remote trigger). Recommended cadence: weekly. The state file handles cutoff tracking — no dates need to be passed manually on scheduled runs. Set `DIGEST_REPO` in the environment to avoid passing the URL each time.
