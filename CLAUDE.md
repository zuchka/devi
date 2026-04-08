# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`content-flywheel` is a commit digest generation system. It fetches merged commits from a GitHub repo since the last run, filters noise, evaluates commits for user significance, generates social copy (X + LinkedIn), writes dated markdown digests, and posts to Slack.

## Commands

```bash
npm test                    # Run all tests (Node native test runner)
npm run digest              # Run the digest script (requires GITHUB_TOKEN + repo URL arg)

# Run a single test file
node --test scripts/digest.test.js

# Filter to a specific test by name pattern
node --test --test-name-pattern "shouldFilter" scripts/digest.test.js

# List Buffer channels (outputs JSON with id/service/serviceUsername per channel)
node scripts/buffer-post.js channels

# Post to a specific Buffer channel (reads post text from stdin)
echo "post text" | node scripts/buffer-post.js post <channelId>
```

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub API auth (classic or fine-grained with `repo` read scope) |
| `BUFFER_API_KEY` | Yes (for scheduling) | Buffer API key for posting to social queues |
| `SLACK_WEBHOOK_URL` | No | Slack incoming webhook; silently skipped if absent |
| `DIGEST_REPO` | No | Default repo URL; CLI argument takes precedence |

## Architecture

The system has three layers:

**Layer 1 — `scripts/digest.js`** (data fetching, side-effect-free)
- Parses GitHub repo URLs, reads state from `state/<owner>-<repo>.json`, fetches paginated commits via GitHub API, applies heuristic pre-filter, and outputs JSON to stdout.
- Key exports: `parseRepoUrl`, `readState`, `shouldFilter`, `fetchCommits`, `runDigest`

**Layer 2 — `skills/pr-digest.md`** (Claude skill prompt, AI judgment)
- Invoked as `/pr-digest https://github.com/owner/repo`
- Calls `digest.js`, applies AI judgment on notability, generates **numbered** social copy (X + LinkedIn), writes `digests/YYYY-MM-DD.md`, posts to Slack, and updates state.
- Items are numbered `## 1. [Title](url)` in the digest file and terminal output so they can be referenced when scheduling.

**Layer 2b — `skills/buffer-schedule.md`** (Claude skill prompt, Buffer posting)
- Triggered when user says "schedule number N to [linkedin/x/both]"
- Reads item N from the most recent digest file, discovers Buffer channel IDs (caches in `state/buffer-channels.json`), posts to Buffer via `buffer-post.js`.

**Layer 1b — `scripts/buffer-post.js`** (Buffer GraphQL client)
- `channels` command: queries Buffer API to list all channels with their IDs and service types
- `post <channelId>` command: creates a queued post by reading text from stdin; uses `mode: addToQueue`

**Layer 3 — `state/<owner>-<repo>.json`** (state management, gitignored)
- Stores `lastDigestAt` timestamp. Defaults to 30 days ago on first run.

**Data flow:**
```
/pr-digest <repo-url>
  → digest.js: parse → read state → fetch commits (paginated) → heuristic filter → JSON stdout
  → Claude (pr-digest.md): judge notability → generate numbered copy → write digest → post Slack → update state

User: "schedule number 3 to linkedin and x"
  → Claude (buffer-schedule.md): read digest → extract item 3 copy
    → buffer-post.js channels → cache state/buffer-channels.json
    → buffer-post.js post <linkedin-id> (LinkedIn copy via stdin)
    → buffer-post.js post <x-id> (X copy via stdin)
```

## Heuristic Pre-Filter (`shouldFilter`)

`digest.js` drops commits matching these **title patterns** (case-insensitive):
- `bump\b`, `^chore[:(]`, `^deps[:(]`, `^fix typo`, `renovate`, `dependabot`, `^ci[:(]`, `^test[:(]`, `^docs[:(]`, `^refactor[:(]`

Or having any of these **labels**: `dependencies`, `chore`, `maintenance`, `automated`, `bot`

After heuristic filtering, the Claude skill applies judgment: a commit is notable if it introduces user-facing functionality, new APIs/CLI commands, performance improvements, production bug fixes, or meaningful architectural changes.

## Runtime Requirements

- Node.js ≥ 18.0.0 (uses native `fetch`, ESM modules, `node:fs/promises`)
- No build step — pure ESM, run directly with `node`
- `state/` and `digests/` directories are gitignored; the skill creates them if missing

## Buffer Channel ID Caching

Channel IDs are discovered on first scheduling run and cached in `state/buffer-channels.json` (gitignored). If the cache is stale (e.g., you added a new channel), delete the file to force re-discovery. The script matches `service: "linkedin"` for LinkedIn and `service: "twitter"` or `"x"` for X.

## Key Design Docs

- `docs/superpowers/specs/2026-03-31-pr-digest-design.md` — architecture spec, JSON schema, error handling matrix
- `docs/superpowers/plans/2026-03-31-pr-digest.md` — TDD implementation plan with code examples
- `skills/pr-digest.md` — the executable Claude skill (8-step workflow)
