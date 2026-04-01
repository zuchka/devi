import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoUrl, readState, shouldFilter, fetchMergedPRs, fetchPRDetail } from './digest.js';

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

test('shouldFilter: filters renovate PRs', () => {
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

// PRs that should NOT be filtered
test('shouldFilter: keeps feature PRs', () => {
  assert.equal(shouldFilter({ title: 'Add dark mode support', labels: [] }), false);
});

test('shouldFilter: keeps bugfix PRs', () => {
  assert.equal(shouldFilter({ title: 'Fix crash on login when session expires', labels: [] }), false);
});

test('shouldFilter: keeps PRs with feature label', () => {
  assert.equal(shouldFilter({ title: 'New dashboard', labels: [{ name: 'feature' }] }), false);
});

// fetchMergedPRs tests

function makeFakeFetch(pages) {
  // pages: array of arrays of PR search items
  let page = 0;
  return async (url) => {
    const items = pages[page] ?? [];
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
      json: async () => ({ items, total_count: items.length }),
    };
  };
}

test('fetchMergedPRs: returns items from single page', async () => {
  const fakeFetch = makeFakeFetch([[{ number: 1 }, { number: 2 }]]);
  const result = await fetchMergedPRs('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result.length, 2);
  assert.equal(result[0].number, 1);
});

test('fetchMergedPRs: paginates across multiple pages', async () => {
  const fakeFetch = makeFakeFetch([
    [{ number: 1 }, { number: 2 }],
    [{ number: 3 }],
  ]);
  const result = await fetchMergedPRs('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch);
  assert.equal(result.length, 3);
});

test('fetchMergedPRs: throws on rate limit (0 remaining)', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'X-RateLimit-Remaining' ? '0' : null) },
    json: async () => ({ items: [{ number: 1 }], total_count: 1 }),
  });
  await assert.rejects(
    () => fetchMergedPRs('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch),
    /rate limit/i
  );
});

test('fetchMergedPRs: throws on 401', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    json: async () => ({ message: 'Bad credentials' }),
  });
  await assert.rejects(
    () => fetchMergedPRs('owner', 'repo', '2026-01-01T00:00:00Z', fakeFetch),
    /401/
  );
});

// fetchPRDetail tests

function makePRDetailFetch(prData) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => prData,
  });
}

test('fetchPRDetail: returns shaped PR object', async () => {
  const raw = {
    number: 42,
    title: 'Add dark mode',
    body: 'Implements dark mode toggle',
    html_url: 'https://github.com/owner/repo/pull/42',
    merged_at: '2026-03-28T14:00:00Z',
    user: { login: 'alice' },
    labels: [{ name: 'feature' }],
    additions: 100,
    deletions: 20,
    changed_files: 5,
  };
  const fakeFetch = makePRDetailFetch(raw);
  const result = await fetchPRDetail('owner', 'repo', 42, fakeFetch);
  assert.deepEqual(result, {
    number: 42,
    title: 'Add dark mode',
    body: 'Implements dark mode toggle',
    url: 'https://github.com/owner/repo/pull/42',
    mergedAt: '2026-03-28T14:00:00Z',
    author: 'alice',
    labels: [{ name: 'feature' }],
    additions: 100,
    deletions: 20,
    changedFiles: 5,
  });
});

test('fetchPRDetail: truncates body at 4000 chars', async () => {
  const raw = {
    number: 1,
    title: 'Big PR',
    body: 'x'.repeat(5000),
    html_url: 'https://github.com/owner/repo/pull/1',
    merged_at: '2026-03-28T14:00:00Z',
    user: { login: 'bob' },
    labels: [],
    additions: 1,
    deletions: 0,
    changed_files: 1,
  };
  const result = await fetchPRDetail('owner', 'repo', 1, makePRDetailFetch(raw));
  assert.equal(result.body.length, 4000);
});

test('fetchPRDetail: handles null body', async () => {
  const raw = {
    number: 1,
    title: 'No description',
    body: null,
    html_url: 'https://github.com/owner/repo/pull/1',
    merged_at: '2026-03-28T14:00:00Z',
    user: { login: 'bob' },
    labels: [],
    additions: 1,
    deletions: 0,
    changed_files: 1,
  };
  const result = await fetchPRDetail('owner', 'repo', 1, makePRDetailFetch(raw));
  assert.equal(result.body, '');
});
