// scripts/digest.js

import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /^test[:(]/i,
  /^docs[:(]/i,
  /^refactor[:(]/i,
];

export function shouldFilter(item) {
  if (item.labels?.some((l) => NOISE_LABELS.has(l.name.toLowerCase()))) return true;
  if (NOISE_TITLE_PATTERNS.some((re) => re.test(item.title))) return true;
  return false;
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

export async function fetchCommits(owner, repo, since, fetchFn = fetch) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    ...GITHUB_HEADERS,
    Authorization: `Bearer ${token}`,
  };

  const allCommits = [];
  let url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=100`;

  while (url) {
    const res = await fetchFn(url, { headers });
    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining !== null && Number(remaining) === 0) {
      throw new Error('GitHub rate limit exhausted mid-fetch. Re-run when limit resets.');
    }
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} fetching commits`);
    }
    const data = await res.json();
    allCommits.push(...data);

    const link = res.headers.get('Link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return allCommits.map((c) => {
    const [title, ...bodyLines] = c.commit.message.split('\n');
    return {
      sha: c.sha.slice(0, 7),
      title: title.trim(),
      body: bodyLines.join('\n').trim().slice(0, 4000),
      url: c.html_url,
      date: c.commit.author.date,
      author: c.author?.login ?? c.commit.author.name,
    };
  });
}

export async function runDigest(owner, repo, stateDir, fetchFn = fetch) {
  const since = await readState(stateDir, owner, repo);
  const commits = await fetchCommits(owner, repo, since, fetchFn);
  return commits.filter((c) => !shouldFilter(c));
}

// Only runs when invoked directly (not when imported by tests)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  const repoArg = process.argv[2] ?? process.env.DIGEST_REPO;
  if (!repoArg) {
    console.error('Error: provide a GitHub repo URL as argument or set DIGEST_REPO');
    process.exit(1);
  }

  try {
    const { owner, repo } = parseRepoUrl(repoArg);
    const stateDir = resolve(dirname(fileURLToPath(import.meta.url)), '../state');
    const candidates = await runDigest(owner, repo, stateDir);
    process.stdout.write(JSON.stringify(candidates, null, 2) + '\n');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
