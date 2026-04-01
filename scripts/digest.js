// scripts/digest.js

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readState(stateDir, owner, repo) {
  const stateFile = join(stateDir, `${owner}-${repo}.json`);
  try {
    const raw = await readFile(stateFile, 'utf8');
    const { lastDigestAt } = JSON.parse(raw);
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
