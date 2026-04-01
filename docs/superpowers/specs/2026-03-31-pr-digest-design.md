# PR Digest Skill — Design Spec

**Date:** 2026-03-31  
**Status:** Approved  
**Skill invocation:** `/pr-digest <github-repo-url>`

---

## Overview

A repeatable Claude skill that fetches merged PRs from a GitHub repository since the last digest, filters out maintenance and trivial changes, generates social copy for X (Twitter) and LinkedIn, posts a summary to Slack, and writes a dated markdown digest file. Designed to run on a recurring schedule.

---

## Architecture

Three layers:

### 1. `scripts/digest.js` (Node.js — data layer)
- Accepts a GitHub repo URL as input
- Reads `.digest-state.json` from the target repo root to find `lastDigestAt` (defaults to 30 days ago if missing)
- Calls GitHub REST API: `GET /repos/:owner/:repo/pulls?state=closed&merged=true`
- Filters to PRs where `merged_at > lastDigestAt`
- Applies heuristic pre-filter to drop obvious noise (see Filtering section)
- Outputs a structured JSON array of candidate PRs to stdout
- Does not write to disk

### 2. `skills/pr-digest.md` (Claude skill — intelligence layer)
- Receives JSON candidate PRs from `digest.js`
- Makes final judgment on each PR: notable vs. skip
- Generates X and LinkedIn copy for notable PRs
- Writes digest file, posts to Slack, updates state

### 3. `.digest-state.json` (state — lives in target repo, gitignored)
- Contains a single `lastDigestAt` ISO timestamp
- Updated at the end of each successful run

---

## Data Flow

```
User: /pr-digest https://github.com/owner/repo
        │
        ▼
digest.js
  ├── read .digest-state.json (or default to 30 days ago)
  ├── fetch merged PRs via GitHub API
  ├── filter: merged_at > lastDigestAt
  ├── heuristic pre-filter (drop noise)
  └── output JSON to stdout
        │
        ▼
Claude (pr-digest skill)
  ├── judge each candidate PR: notable or skip
  ├── if zero notable PRs → update state, exit silently
  └── if notable PRs:
        ├── generate X copy + LinkedIn copy per PR
        ├── write digests/YYYY-MM-DD.md
        ├── print digest to terminal
        ├── POST summary to Slack webhook
        └── update .digest-state.json in target repo
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

### Claude judgment pass (in skill)
For remaining candidates, Claude evaluates: does this PR represent a meaningful user-facing change, new feature, performance improvement, or interesting technical decision? If none of the above, skip it.

---

## Output

### Digest file: `digests/YYYY-MM-DD.md`
Written to the `content-flywheel` project directory. One entry per notable PR:

```markdown
## [PR Title](pr-url)

**X copy**
<= 280 chars. Lead with value, not PR number. Conversational but sharp. No hashtag spam.

**LinkedIn copy**
2–4 sentences. Professional tone. Can reference broader project context.
```

### Terminal output
Full digest printed to stdout on every successful run with notable PRs.

### Slack
POST to `$SLACK_WEBHOOK_URL`. Payload: one bullet per notable PR using its X copy as teaser, linking to the PR URL. Only fires when there are notable PRs.

### Silent skip
If no notable PRs: update `.digest-state.json`, print a brief terminal note (e.g., "No notable PRs since <date>. State updated."), exit.

---

## File Structure

```
content-flywheel/
├── skills/
│   └── pr-digest.md
├── scripts/
│   └── digest.js
├── digests/
│   └── YYYY-MM-DD.md        # generated output
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-03-31-pr-digest-design.md

# In the watched target repo:
.digest-state.json            # gitignored
```

---

## Configuration

All config via environment variables:

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub API auth token |
| `SLACK_WEBHOOK_URL` | Yes | Slack incoming webhook URL |
| `DIGEST_REPO` | No | Default repo URL (avoids passing it every run) |

---

## Skill Prompt Structure (`skills/pr-digest.md`)

1. **Trigger** — `/pr-digest <github-repo-url>`
2. **Step 1: Run script** — `node scripts/digest.js <repo-url>`, capture JSON output
3. **Step 2: Judge PRs** — evaluate each candidate for notability
4. **Step 3: Write copy** — X (≤280 chars) and LinkedIn (2–4 sentences) per notable PR
5. **Step 4: Silent skip check** — if zero notable, update state and exit
6. **Step 5: Write digest file** — `digests/YYYY-MM-DD.md`
7. **Step 6: Post to Slack** — HTTP POST to `$SLACK_WEBHOOK_URL`
8. **Step 7: Update state** — write current ISO timestamp to `.digest-state.json`

---

## Scheduling

The skill is designed to run on a repeating interval via Claude Code's `schedule` skill (cron-based remote trigger). Recommended cadence: weekly. The state file handles the rest — no need to pass dates manually.
