// scripts/digest.js

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
