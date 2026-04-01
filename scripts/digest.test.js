import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoUrl, readState } from './digest.js';

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
