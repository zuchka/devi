// scripts/digest.js

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readState(stateDir, owner, repo) {
  const stateFile = join(stateDir, `${owner}-${repo}.json`);
  try {
    const raw = await readFile(stateFile, 'utf8');
    const { lastDigestAt } = JSON.parse(raw);
    if (!lastDigestAt) throw new Error('missing lastDigestAt');
    return lastDigestAt;
  } catch {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return thirtyDaysAgo.toISOString();
  }
}

export function parseRepoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid repo URL: ${url}`);
  }
  if (parsed.hostname !== 'github.com') {
    throw new Error(`Expected a github.com URL, got: ${parsed.hostname}`);
  }
  const parts = parsed.pathname.replace(/^\/|\/$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Could not parse owner/repo from URL: ${url}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

const NOISE_LABELS = new Set(['dependencies', 'chore', 'maintenance', 'automated', 'bot']);

const NOISE_TITLE_PATTERNS = [
  /bump\b/i,
  /^chore[:(]/i,
  /^deps[:(]/i,
  /^fix typo/i,
  /renovate/i,
  /dependabot/i,
  /^ci[:(]/i,
];

export function shouldFilter(pr) {
  if (pr.labels.some((l) => NOISE_LABELS.has(l.name.toLowerCase()))) return true;
  if (NOISE_TITLE_PATTERNS.some((re) => re.test(pr.title))) return true;
  return false;
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

export async function fetchMergedPRs(owner, repo, since, fetchFn = fetch) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    ...GITHUB_HEADERS,
    Authorization: `Bearer ${token}`,
  };

  const allItems = [];
  let url = `https://api.github.com/search/issues?q=is:pr+is:merged+repo:${owner}/${repo}+merged:>${since}&per_page=100`;

  while (url) {
    const res = await fetchFn(url, { headers });
    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining !== null && Number(remaining) === 0) {
      throw new Error('GitHub rate limit exhausted mid-fetch. Re-run when limit resets.');
    }
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching PRs`);
    }
    const data = await res.json();
    allItems.push(...data.items);

    const link = res.headers.get('Link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return allItems;
}
