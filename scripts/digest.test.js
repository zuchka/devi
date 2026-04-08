import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoUrl, readState, shouldFilter, fetchCommits, runDigest } from './digest.js';

test('parseRepoUrl: handles https URL', () => {
  const result = parseRepoUrl('https://github.com/anthropics/claude-code');
  assert.deepEqual(result, { owner: 'anthropics', repo: 'claude-code' });
});

test('parseRepoUrl: handles URL with trailing slash', () => {
  const result = parseRepoUrl('https://github.com/anthropics/claude-code/');
  assert.deepEqual(result, { owner: 'anthropics', repo: 'claude-code' });
});

test('parseRepoUrl: throws on invalid URL', () => {
  assert.throws(() => parseRepoUrl('not-a-url'), /invalid/i);
});

test('parseRepoUrl: throws on non-github URL', () => {
  assert.throws(() => parseRepoUrl('https://gitlab.com/foo/bar'), /github\.com/i);
});

test('readState: returns lastDigestAt from existing file', async () => {
  const dir = join(tmpdir(), `digest-test-${Date.now()}`);
  await mkdir(dir);
  await writeFile(
    join(dir, 'myorg-myrepo.json'),
    JSON.stringify({ lastDigestAt: '2026-03-01T00:00:00.000Z' })
  );
  const result = await readState(dir, 'myorg', 'myrepo');
  assert.equal(result, '2026-03-01T00:00:00.000Z');
  await rm(dir, { recursive: true });
});

test('readState: returns 30-days-ago default when file is missing', async () => {
  const dir = join(tmpdir(), `digest-test-${Date.now()}`);
  await mkdir(dir);
  const before = Date.now();
  const result = await readState(dir, 'myorg', 'myrepo');
  const after = Date.now();
  const resultMs = new Date(result).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  // Should be ~30 days ago (within 5 seconds of test execution)
  assert.ok(resultMs >= before - thirtyDaysMs - 5000);
  assert.ok(resultMs <= after - thirtyDaysMs + 5000);
  await rm(dir, { recursive: true });
});

test('readState: returns 30-days-ago default when file has no lastDigestAt key', async () => {
  const dir = join(tmpdir(), `digest-test-${Date.now()}`);
  await mkdir(dir);
  await writeFile(join(dir, 'myorg-myrepo.json'), JSON.stringify({}));
  const result = await readState(dir, 'myorg', 'myrepo');
  assert.ok(typeof result === 'string');
  assert.ok(!isNaN(new Date(result).getTime())); // valid ISO date
  await rm(dir, { recursive: true });
});

// shouldFilter tests

const noiseTitle = (title) => ({ title, labels: [] });
const noiseLabel = (label) => ({ title: 'Some feature', labels: [{ name: label }] });

test('shouldFilter: filters dependabot PRs', () => {
  assert.equal(shouldFilter({ title: 'Bump lodash from 4.17.20 to 4.17.21', labels: [] }), true);
});

test('shouldFilter: filters renovate commits', () => {
  assert.equal(shouldFilter(noiseTitle('renovate: update eslint')), true);
});

test('shouldFilter: filters chore: prefix', () => {
  assert.equal(shouldFilter(noiseTitle('chore: update eslint')), true);
});

test('shouldFilter: filters chore( prefix', () => {
  assert.equal(shouldFilter(noiseTitle('chore(deps): update eslint')), true);
});

test('shouldFilter: filters deps: prefix', () => {
  assert.equal(shouldFilter(noiseTitle('deps: bump react')), true);
});

test('shouldFilter: filters ci: prefix', () => {
  assert.equal(shouldFilter(noiseTitle('ci: fix lint step')), true);
});

test('shouldFilter: filters test: prefix', () => {
  assert.equal(shouldFilter(noiseTitle('test: add unit tests')), true);
});

test('shouldFilter: filters docs: prefix', () => {
  assert.equal(shouldFilter(noiseTitle('docs: update README')), true);
});

test('shouldFilter: filters refactor: prefix', () => {
  assert.equal(shouldFilter(noiseTitle('refactor: extract helper function')), true);
});

test('shouldFilter: filters fix typo', () => {
  assert.equal(shouldFilter(noiseTitle('fix typo in README')), true);
});

test('shouldFilter: filters by label: dependencies', () => {
  assert.equal(shouldFilter(noiseLabel('dependencies')), true);
});

test('shouldFilter: filters by label: bot', () => {
  assert.equal(shouldFilter(noiseLabel('bot')), true);
});

test('shouldFilter: filters by label: automated', () => {
  assert.equal(shouldFilter(noiseLabel('automated')), true);
});

test('shouldFilter: filters by label: chore', () => {
  assert.equal(shouldFilter(noiseLabel('chore')), true);
});

test('shouldFilter: filters by label: maintenance', () => {
  assert.equal(shouldFilter(noiseLabel('maintenance')), true);
});

test('shouldFilter: works without labels field', () => {
  assert.equal(shouldFilter({ title: 'chore: bump deps' }), true);
});

// Commits that should NOT be filtered
test('shouldFilter: keeps feature commits', () => {
  assert.equal(shouldFilter({ title: 'Add dark mode support', labels: [] }), false);
});

test('shouldFilter: keeps feat: prefix commits', () => {
  assert.equal(shouldFilter({ title: 'feat: add search functionality', labels: [] }), false);
});

test('shouldFilter: keeps bugfix commits', () => {
  assert.equal(shouldFilter({ title: 'Fix crash on login when session expires', labels: [] }), false);
});

test('shouldFilter: keeps fix: prefix when not fix typo', () => {
  assert.equal(shouldFilter({ title: 'fix: handle null pointer in auth flow', labels: [] }), false);
});

// fetchCommits tests

function makeCommitsFetch(pages) {
  // pages: array of arrays of raw GitHub commit objects
  let page = 0;
  return async (url) => {
    const commits = pages[page] ?? [];
    const isLastPage = page >= pages.length - 1;
    page++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => {
          if (h === 'X-RateLimit-Remaining') return '100';
          if (h === 'Link') {
            return isLastPage ? null : `<https://api.github.com/next>; rel="next"`;
          }
          return null;
        },
      },
      json: async () => commits,
    };
  };
}

function makeRawCommit(overrides = {}) {
  return {
    sha: 'abc1234567890',
    commit: {
      message: overrides.message ?? 'feat: add something',
      author: { date: '2026-03-28T12:00:00Z', name: 'Alice' },
    },
    html_url: 'https://github.com/owner/repo/commit/abc1234',
    author: { login: overrides.login ?? 'alice' },
    ...overrides,
  };
}

test('fetchCommits: returns shaped commits from single page', async () => {
  const raw = [makeRawCommit({ sha: 'aaabbbccc111', message: 'feat: add search' })];
  const fakeFetch = makeCommitsFetch([raw]);
  const result = await fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result.length, 1);
  assert.equal(result[0].sha, 'aaabbbc');
  assert.equal(result[0].title, 'feat: add search');
  assert.equal(result[0].author, 'alice');
});

test('fetchCommits: paginates across multiple pages', async () => {
  const page1 = [makeRawCommit({ sha: 'aaa0000000000' }), makeRawCommit({ sha: 'bbb0000000000' })];
  const page2 = [makeRawCommit({ sha: 'ccc0000000000' })];
  const fakeFetch = makeCommitsFetch([page1, page2]);
  const result = await fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result.length, 3);
});

test('fetchCommits: splits commit message into title and body', async () => {
  const raw = [makeRawCommit({
    sha: 'abc0000000000',
    message: 'feat: add search\n\nThis PR adds full-text search support.\nIt uses elasticsearch.',
  })];
  const fakeFetch = makeCommitsFetch([raw]);
  const result = await fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result[0].title, 'feat: add search');
  assert.equal(result[0].body, 'This PR adds full-text search support.\nIt uses elasticsearch.');
});

test('fetchCommits: truncates body at 4000 chars', async () => {
  const raw = [makeRawCommit({
    sha: 'abc0000000000',
    message: 'feat: something\n\n' + 'x'.repeat(5000),
  })];
  const fakeFetch = makeCommitsFetch([raw]);
  const result = await fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result[0].body.length, 4000);
});

test('fetchCommits: falls back to commit author name when no login', async () => {
  const raw = [{
    sha: 'abc0000000000',
    commit: {
      message: 'feat: add something',
      author: { date: '2026-03-28T12:00:00Z', name: 'Jane Doe' },
    },
    html_url: 'https://github.com/owner/repo/commit/abc0000',
    author: null, // no GitHub user association
  }];
  const fakeFetch = makeCommitsFetch([raw]);
  const result = await fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result[0].author, 'Jane Doe');
});

test('fetchCommits: throws on rate limit (0 remaining)', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'X-RateLimit-Remaining' ? '0' : null) },
    json: async () => [makeRawCommit()],
  });
  await assert.rejects(
    () => fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch),
    /rate limit/i
  );
});

test('fetchCommits: throws on 401', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    json: async () => ({ message: 'Bad credentials' }),
  });
  await assert.rejects(
    () => fetchCommits('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch),
    /401/
  );
});

// runDigest tests

function makeDigestFetch(commits) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'X-RateLimit-Remaining' ? '100' : null) },
    json: async () => commits,
  });
}

test('runDigest: returns notable commits after heuristic filter', async () => {
  const stateDir = join(tmpdir(), `digest-orch-${Date.now()}`);
  await mkdir(stateDir);

  const rawCommits = [
    makeRawCommit({ sha: 'aaa0000000000', message: 'feat: add jq support', login: 'alice' }),
    makeRawCommit({ sha: 'bbb0000000000', message: 'chore: bump eslint', login: 'bot' }),
  ];

  const fakeFetch = makeDigestFetch(rawCommits);
  const result = await runDigest('o', 'r', stateDir, fakeFetch);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'feat: add jq support');

  await rm(stateDir, { recursive: true });
});

test('runDigest: returns empty array when all commits are filtered', async () => {
  const stateDir = join(tmpdir(), `digest-orch-${Date.now()}`);
  await mkdir(stateDir);

  const rawCommits = [
    makeRawCommit({ sha: 'aaa0000000000', message: 'chore: bump eslint' }),
    makeRawCommit({ sha: 'bbb0000000000', message: 'docs: update README' }),
  ];

  const fakeFetch = makeDigestFetch(rawCommits);
  const result = await runDigest('o', 'r', stateDir, fakeFetch);
  assert.equal(result.length, 0);

  await rm(stateDir, { recursive: true });
});
