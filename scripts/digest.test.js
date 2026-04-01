import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoUrl, readState, shouldFilter } from './digest.js';

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
