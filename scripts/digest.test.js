import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoUrl } from './digest.js';

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
