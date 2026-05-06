// GitHub repository_dispatch client.
//
// Fires a repository_dispatch event which a workflow in the target repo
// listens on. Payload caps at 10 top-level keys and 64 KB total per
// GitHub API limits — we stay well under by sending issue IDs and URLs,
// not full event bodies.

/**
 * @param {object} args
 * @param {string} args.repo       "Owner/Name"
 * @param {string} args.eventType  event_type consumed by workflow on: repository_dispatch
 * @param {object} args.payload    client_payload body (<=10 keys, <=64KB)
 * @param {string} args.token      fine-grained PAT with repository_dispatch: write
 */
export async function dispatch({ repo, eventType, payload, token }) {
  const url = `https://api.github.com/repos/${repo}/dispatches`;
  const body = JSON.stringify({ event_type: eventType, client_payload: payload });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'smarter-poker-sentry-autofix/1.0',
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
  }
  return { status: res.status };
}
