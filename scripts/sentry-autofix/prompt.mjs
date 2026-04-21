// Prompt construction for the autofix Claude call (Club Arena variant).
//
// Club Arena is the Vite + React 19 poker SPA. The V8 Bible governs the
// engine surface — engine + server + money paths are denylisted and Claude
// is told explicitly to decline if a fix would require touching them.
//
// We force a structured XML response so the parser is trivial.

export const SYSTEM_PROMPT = `You are the autonomous autofix agent for smarter.poker's Club Arena (the Vite + React 19
poker SPA, dist is hosted under the World Hub at /hub/club-arena/). You receive a real Sentry-captured
error and must produce a minimal, correct patch that eliminates the root cause.

You are not a general assistant here. You are a code-fix agent. You must:

1.  Fix the ROOT CAUSE, not the symptom. If the stack trace points at
    a render but the real problem is a bad service call, fix the service.

2.  Make the SMALLEST possible change. Do not refactor, do not rename, do
    not reformat unrelated code. Single-responsibility patch only.

3.  Add or update a TEST that would have caught this bug. Club Arena uses
    vitest; tests live next to source or under tests/ and e2e/. If no test
    framework covers the affected module, respond with
    <test_note>none-possible</test_note> and explain why.

4.  NEVER modify any file under:
    - server/src/engine/**, server/src/transport/**, server/src/services/**
    - src/engine/**, src/engines/**, src/sim/**
      (all of these are V8 Bible-governed — engine changes require human review per V8 Migration Law)
    - any path containing /ledger/, /wallet/, /rake/, /purchase/,
      /diamonds/, /payouts/, /kyc/, /mfa/
    - src/services/auth*, src/lib/auth*, src/lib/supabaseAdmin*,
      src/lib/supabase-admin*, src/lib/serviceRole*
    - supabase/migrations/**, sql/**
    - vite.config*, vitest.config*, tsconfig*, .github/workflows/**, .husky/**, infra/**
    - package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, .env*
    - scripts/sentry-autofix/**
    - skills/**, AGENT_SKILLS/**
    - dist/**, dist-fix/**, dist-fix2/**

    If the bug requires changes to any of these, STOP. Respond only with:
    <cannot_fix>reason: denylisted path XYZ must change to fix this</cannot_fix>

5.  If the stack trace is insufficient, the bug is ambiguous, or you
    cannot write a fix with high confidence, STOP. Respond only with:
    <cannot_fix>reason: concise one-line reason</cannot_fix>

6.  Never introduce new dependencies. Use what's already in the package.

7.  React 19 is in use — prefer idiomatic hooks, avoid class components,
    prefer optional chaining + null-safety over try/catch for simple guards.

Response format — REQUIRED, any deviation is a failure:

<explanation>
2–4 sentences. Root cause + what the patch changes + why.
</explanation>

<patch>
[A single unified diff suitable for 'git apply' from the repo root.
 Use standard diff format: "diff --git a/PATH b/PATH" headers,
 "--- a/PATH", "+++ b/PATH", "@@ hunk @@" markers. Nothing else in
 this block.]
</patch>

<test_note>
One sentence naming the test you added/updated and what it guards
against. Or "none-possible" with reason.
</test_note>

<confidence>
A single word: high | medium | low.
</confidence>
`;

/**
 * Render source files as a readable block. We clip to 400 lines per file
 * to stay under the model's context ceiling; the stack trace has the
 * actual hot spot we care about.
 */
function renderFiles(files) {
  return files.map(({ path, content }) => {
    const lines = content.split('\n');
    const clipped = lines.length > 400
      ? [...lines.slice(0, 200), '// ... (file truncated; ' + (lines.length - 400) + ' lines omitted) ...', ...lines.slice(-200)]
      : lines;
    return '--- FILE: ' + path + ' ---\n' + clipped.join('\n');
  }).join('\n\n');
}

function renderStack(stack) {
  const { exception, frames } = stack;
  const head = `EXCEPTION: ${exception.type}: ${exception.value}`;
  const body = frames.map((f, i) => {
    const loc = `${f.filename || '?'}:${f.lineno || '?'}${f.colno ? ':' + f.colno : ''}`;
    const fn = f.function ? ` in ${f.function}` : '';
    const context = [
      ...(f.pre_context || []).map(l => '    ' + l),
      '>>> ' + (f.context_line || ''),
      ...(f.post_context || []).map(l => '    ' + l),
    ].join('\n');
    return `#${i} ${loc}${fn}${context ? '\n' + context : ''}`;
  }).join('\n');
  return head + '\n' + body;
}

/**
 * @param {object} args
 * @param {object} args.issue   Sentry issue JSON
 * @param {object} args.stack   result of extractStack(event)
 * @param {Array<{path,content}>} args.files  source files to include
 * @param {string} args.repoName  repo slug ("Smarter-Poker/Smarter-Poker-Club-Arena")
 */
export function buildMessages({ issue, stack, files, repoName }) {
  const user = `# Sentry issue

- Repo: ${repoName}
- Title: ${issue.title || '(no title)'}
- Short ID: ${issue.shortId || issue.short_id || '(unknown)'}
- Level: ${issue.level || '(unknown)'}
- Count: ${issue.count || '?'}  users: ${issue.userCount || '?'}
- First seen: ${issue.firstSeen || '?'}
- Last seen: ${issue.lastSeen || '?'}
- Permalink: ${issue.permalink || '(unknown)'}
- Culprit: ${issue.culprit || '(unknown)'}

# Stack trace (innermost first)

${renderStack(stack)}

# Relevant source files from the repo

${renderFiles(files)}

# Task

Fix this bug at its root cause with the smallest possible change. Add a
regression test next to the affected module (Club Arena uses vitest).
Respond with <test_note>none-possible</test_note> if no test framework
covers the module. Respond in the exact XML format from the system prompt.
`;

  return [{ role: 'user', content: user }];
}
