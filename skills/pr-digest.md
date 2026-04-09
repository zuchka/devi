---
name: pr-digest
description: Generate a social media digest of notable merged PRs from a GitHub repo since the last run. Writes X and LinkedIn copy, posts to Slack, saves a dated digest file.
---

# PR Digest Skill

**Trigger:** `/pr-digest <github-repo-url>`

Use `DIGEST_REPO` env var as fallback if no URL argument is provided. If neither is available, stop and ask the user for a repo URL.

---

## Setup (MUST complete all four steps before running the script)

1. Parse `owner` and `repo` from the repo URL.
2. Ensure `state/` directory exists at the project root (create with `mkdir -p state`).
3. Ensure `digests/` directory exists at the project root (create with `mkdir -p digests`).
4. **Before invoking `digest.js`:** check whether `state/<owner>-<repo>.json` exists. If it does not, create it now:
   ```json
   { "lastDigestAt": "<ISO timestamp 30 days ago>" }
   ```
   This ensures a clean starting state — `digest.js` can handle a missing file (it defaults to 30 days ago), but pre-creating it avoids ambiguity.

## Step 1: Fetch Candidates

Run:
```bash
node scripts/digest.js <repo-url>
```

Capture stdout as JSON. If the command exits non-zero, stop and surface the error — do not proceed.

The JSON array contains PRs. Each element:
```json
{
  "number": 42,
  "title": "feat: add jq support for response filtering",
  "body": "PR description or empty string",
  "url": "https://github.com/owner/repo/pull/42",
  "mergedAt": "2026-03-28T14:22:00Z",
  "author": "username",
  "labels": [{ "name": "feature" }],
  "additions": 120,
  "deletions": 30,
  "changedFiles": 5
}
```

## Step 2: Judge PRs

For each PR in the JSON array, decide: **notable** or **skip**.

A PR is notable if it meets at least one of:
- Introduces or changes user-facing functionality
- Adds a new API, CLI command, or integration
- Delivers a measurable performance improvement
- Fixes a bug that affected users in production
- Makes a meaningful architectural change worth communicating externally

If a PR has no body, judge on title alone. If the title is too vague (e.g., "updates", "misc changes"), skip it.

## Step 3: Silent Skip

If zero PRs are notable:
- Update `state/<owner>-<repo>.json` with `{ "lastDigestAt": "<current ISO timestamp>" }`
- Print: `No notable PRs since <lastDigestAt date>. State updated.`
- Stop.

## Step 4: Write Social Copy

Assign each notable PR a sequential number starting at 1. For each, write:

**X copy** (≤280 chars):
- Lead with the user value or impact — not the PR number
- Conversational but sharp
- No hashtags
- One tweet only — no thread copy

**LinkedIn copy** (2–4 sentences):
- Open with the user benefit or impact
- Professional tone
- End with a call to action or link reference
- No author tags, no hashtags

## Step 5: Write Digest File

Determine filename: start with `digests/YYYY-MM-DD.md` (today's date). If that file already exists, use `digests/YYYY-MM-DD-2.md`, then `-3`, etc.

Write the file with this structure (note the `N.` number prefix on each heading):

```
# PR Digest — <owner>/<repo> — <YYYY-MM-DD>

_<N> notable PRs since <lastDigestAt date>_

---

## 1. [PR Title](pr-url)

**X copy**
<copy here>

**LinkedIn copy**
<copy here>

---

## 2. [PR Title](pr-url)

**X copy**
<copy here>

**LinkedIn copy**
<copy here>

---
```

## Step 6: Print to Terminal

Print the full digest content to the terminal. After the digest, print this footer:

```
---
To schedule an item: "schedule number <N> to linkedin", "schedule number <N> to x", or "schedule number <N> to both"
```

## Step 7: Post to Slack

If `SLACK_WEBHOOK_URL` is not set, skip this step silently.

POST to `$SLACK_WEBHOOK_URL` with this JSON body:
```json
{
  "text": "🗞 PR Digest — <owner>/<repo> (<YYYY-MM-DD>)",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🗞 *PR Digest — <owner>/<repo>* (<YYYY-MM-DD>)\n\n<bullets>"
      }
    }
  ]
}
```

Each bullet: `• <PR URL|PR Title (escaped)> — <X copy truncated to 120 chars>`

Escape PR titles in this order: first replace `&` with `&amp;`, then `>` with `&gt;`, then `|` with `-`.

If the POST fails (non-2xx), log a warning but continue — do not block state update.

## Step 8: Update State

Write to `state/<owner>-<repo>.json`:
```json
{ "lastDigestAt": "<current ISO timestamp>" }
```
