import { execFileSync } from 'node:child_process';

// Only messages created here may reach the status reader's diagnostics. Child
// errors can contain stdout, stderr, headers, or credentials; never expose them.
export class GitHubReadError extends Error {}

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
const QUOTA_HEADERS = new Set([
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'retry-after',
]);

function cliResponse(output) {
  if (typeof output !== 'string') return null;
  for (let frame = 0; frame < 10; frame++) {
    const boundary = /\r?\n\r?\n/.exec(output);
    if (!boundary) return null;
    const lines = output.slice(0, boundary.index).split(/\r?\n/);
    const status = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(lines.shift());
    if (!status || Number(status[1]) < 200 || Number(status[1]) > 599) return null;
    const code = Number(status[1]);
    const body = output.slice(boundary.index + boundary[0].length);
    // Current gh prints only the final response after a log-storage redirect.
    // Also accept explicitly framed redirect chains, without reading/following
    // Location ourselves. Never strip an HTTP-looking line from a 200 log body.
    if ([301, 302, 303, 307, 308].includes(code) && /^HTTP\/\S+\s+\d{3}/.test(body)) {
      output = body;
      continue;
    }
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).trim().toLowerCase();
      if (colon > 0 && QUOTA_HEADERS.has(name)) headers.set(name, line.slice(colon + 1).trim());
    }
    return new Response([204, 205, 304].includes(code) ? null : body, { status: code, headers });
  }
  return null;
}

/** Read-only transport. Explicit environment auth wins, even if it is rejected. */
export function createGitHubReader({
  env = process.env,
  platform = process.platform,
  execute = execFileSync,
  fetchImpl = fetch,
} = {}) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  let executable = 'gh';
  return async (url) => {
    const endpoint = new URL(url);
    if (endpoint.origin !== 'https://api.github.com' || endpoint.username || endpoint.password) {
      throw new GitHubReadError('refusing a GitHub status read outside https://api.github.com.');
    }
    if (token) {
      try {
        return await fetchImpl(endpoint.href, {
          headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new GitHubReadError(
          'GitHub API request failed or timed out; no status was observed.'
        );
      }
    }

    // gh owns its credential store. Do not export a token with `gh auth token`,
    // source .env, switch accounts, or place a credential in argv/diagnostics.
    const argv = [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      '--include',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
      endpoint.href,
    ];
    const options = {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...env,
        GH_DEBUG: '',
        DEBUG: '',
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
      },
    };
    for (;;) {
      let output;
      try {
        output = execute(executable, argv, options);
      } catch (error) {
        // A missing PATH entry is not missing authentication. Only ENOENT may
        // select the known Mac install; a running client's failure never does.
        if (error?.code === 'ENOENT' && executable === 'gh' && platform === 'darwin') {
          executable = '/opt/homebrew/bin/gh';
          continue;
        }
        // gh exits 1 for HTTP errors, while --include keeps the response on
        // stdout. Preserve only complete non-success responses for 403/429 and
        // allowed-404 handling. A partial 200 after a process failure is UNKNOWN.
        const response = error?.status === 1 ? cliResponse(error.stdout) : null;
        if (response && !response.ok) return response;
        throw new GitHubReadError(
          error?.code === 'ENOENT'
            ? 'GitHub CLI is unavailable; configure gh or provide GH_TOKEN / GITHUB_TOKEN.'
            : 'configured GitHub CLI could not complete an authenticated read; no status was observed.'
        );
      }
      const response = cliResponse(output);
      if (!response) throw new GitHubReadError('GitHub CLI returned no readable HTTP response.');
      return response;
    }
  };
}
