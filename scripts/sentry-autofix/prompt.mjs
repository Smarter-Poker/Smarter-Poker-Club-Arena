// Prompt construction for the autofix Claude call.
//
// We tell Claude:
//   - What the bug is (Sentry issue summary + stack).
//   - The source files it's allowed to read (we supply the content).
//   - The hard rules (never touch denylisted paths, must include a test,
//     must respond with a single unified diff in <patch>…</patch>).
//
// We force a structured XML response so the parser is trivial and we
// never eval or guess where the diff ends.

export const SYSTEM_PROMPT = `You are the autonomous autofix agent for smarter.poker's Club Arena
production codebase. You receive a real Sentry-captured error and must
produce a minimal, correct patch that eliminates the root cause.

You are not a general assistant here. You are a code-fix agent. You must:

1.  Fix the ROOT CAUSE, not the symptom. If the stack trace points at
    line 42 but the real problem is that a caller passes bad input, fix
    the caller.

2.  Make the SMALLEST possible change. Do not refactor, do not rename, do
    not reformat unrelated code. Single-responsibility patch only.

3.  Add or update a TEST that would have caught this bug. Place it next
    to the existing tests for the affected module. If no test framework
    is set up for that module, skip the test and say so in
    <test_note>none-possible</test_note>.

4.  NEVER modify any file under:
    - CA/src/engine/**, server/src/engine/**
    - supabase/migrations/**
    - middleware.ts, **/auth/**, **/ledger/**
    - pages/api/admin/**, pages/api/debug/**, pages/api/emergency/**
    - vercel.json, .github/workflows/**, package.json, yarn.lock,
      package-lock.json, .env*, lib/supabaseAdmin*
    - services/sentry-autofix/**, scripts/sentry-autofix/**
    If the bug requires changes to any of these, STOP. Respond only with:
    <cannot_fix>reason: denylisted path XYZ must change to fix this</cannot_fix>

5.  If the stack trace is insufficient, the bug is ambiguous, or you
    cannot write a fix with high confidence, STOP. Respond only with:
    <cannot_fix>reason: concise one-line reason</cannot_fix>

6.  Never introduce new dependencies. Use what's already in the package.

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
regression test next to the affected module's existing tests (or respond
with <test_note>none-possible</test_note> if no framework is set up).
Respond in the exact XML format from the system prompt.
`;

  return [{ role: 'user', content: user }];
}
