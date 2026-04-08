---
name: buffer-schedule
description: Schedule a numbered item from the latest digest to Buffer queues for LinkedIn and/or X (Twitter).
---

# Buffer Schedule Skill

**Trigger:** User wants to schedule a numbered content item to Buffer (e.g., "schedule number 3 to linkedin and x", "add item 2 to our queues")

---

## Step 1: Validate Environment

Check that `BUFFER_API_KEY` is set. If not, stop:
> `BUFFER_API_KEY` is not set. Export it and try again.

## Step 2: Parse the Request

From the user's message, determine:
- **Item number** (N) — which numbered entry from the digest to schedule
- **Target channels** — `linkedin`, `x` (also accept `twitter`), or both. Default to both if unspecified.

## Step 3: Get the Copy

Find the most recent digest file: list `digests/`, sort by name descending, take the first result.

In that file, locate the section for item N — the heading matching `## N.`. Extract:

- **X copy**: the text block between the `**X copy**` label and the `**LinkedIn copy**` label
- **LinkedIn copy**: the text block between the `**LinkedIn copy**` label and the next `---` separator

Trim leading/trailing whitespace from each copy block. If item N does not exist, stop and tell the user which numbers are available.

## Step 4: Get Channel IDs

Check `state/buffer-channels.json`. If it does not exist or is an empty array, discover channels now:

```bash
node scripts/buffer-post.js channels
```

Save the JSON output to `state/buffer-channels.json`.

From the channel list, identify:
- **LinkedIn channel**: the entry where `service` is `"linkedin"` — use the first match
- **X channel**: the entry where `service` is `"twitter"` or `"x"` — use the first match

If a required channel is not found, report which service is missing and stop.

## Step 5: Post to Buffer

For each requested channel, post using a heredoc to pass the copy safely:

**For LinkedIn:**
```bash
node scripts/buffer-post.js post <linkedin-channel-id> << 'BUFEOF'
<linkedin copy text>
BUFEOF
```

**For X:**
```bash
node scripts/buffer-post.js post <x-channel-id> << 'BUFEOF'
<x copy text>
BUFEOF
```

Run these sequentially. Capture stdout (the posted `{ id, status, dueAt }` JSON) and any stderr.

## Step 6: Report Results

Print a summary for the user:

```
Scheduled item N: "<commit title>"

✓ LinkedIn — queued (post id: <id>)
✓ X — queued (post id: <id>)
```

If a channel post failed, show the error message but do not treat it as fatal — report the failure and confirm any successes.
