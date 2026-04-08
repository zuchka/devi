#!/usr/bin/env node
/**
 * Buffer GraphQL API client.
 *
 * Usage:
 *   node scripts/buffer-post.js channels
 *   node scripts/buffer-post.js post <channelId>   # reads post text from stdin
 *
 * Requires: BUFFER_API_KEY environment variable
 */

const ENDPOINT = 'https://api.buffer.com';
const TOKEN = process.env.BUFFER_API_KEY;

if (!TOKEN) {
  console.error('Error: BUFFER_API_KEY environment variable is required');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
  return data;
}

async function channels() {
  const { account } = await gql(`
    query {
      account {
        organizations { id }
      }
    }
  `);

  const orgId = account?.organizations?.[0]?.id;
  if (!orgId) throw new Error('No organization found on this account');

  const data = await gql(
    `query Channels($id: OrganizationId!) {
      channels(input: { organizationId: $id }) {
        id
        service
      }
    }`,
    { id: orgId }
  );

  console.log(JSON.stringify(data.channels, null, 2));
}

async function post(channelId) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new Error('No text provided on stdin');

  const data = await gql(
    `mutation Post($channelId: ChannelId!, $text: String!) {
      createPost(input: {
        channelId: $channelId
        text: $text
        schedulingType: automatic
        mode: addToQueue
      }) {
        ... on PostActionSuccess {
          post { id status dueAt }
        }
        ... on MutationError {
          message
        }
      }
    }`,
    { channelId, text }
  );

  const result = data.createPost;
  if (result.message) throw new Error(result.message);
  console.log(JSON.stringify(result.post));
}

const [, , cmd, ...args] = process.argv;

try {
  if (cmd === 'channels') {
    await channels();
  } else if (cmd === 'post') {
    const [channelId] = args;
    if (!channelId) {
      console.error('Usage: buffer-post.js post <channelId>');
      process.exit(1);
    }
    await post(channelId);
  } else {
    console.error('Usage: buffer-post.js channels | buffer-post.js post <channelId>');
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
