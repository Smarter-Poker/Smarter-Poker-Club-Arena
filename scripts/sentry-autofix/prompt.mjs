// Prompt construction for the autofix Claude call.
//
// Contract v2 (2026-04-20): Claude returns WHOLE file contents in JSON, not a diff.
// Unified-diff output was failing `git apply` with "corrupt patch at line N" too often
// because Claude's hunk math isn't perfectly reliable. Structured file replacement
// removes the whole class of parse failures.
//
// We tell Claude:
//   - What the bug is (Sentry issue summary + stack).
//   - The source files it's allowed to read (we supply the content).
//   - The hard rules (never touch denylisted paths, must include a test,
//     must respond in the structured JSON block).
//
// We force a structured XML response so the parser is trivial and we
// never eval or guess where the response ends.

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
    - middleware.ts, **/auth/**, **/ledger/**, **/wallet/**, **/rake/**,
      **/purchase/**, **/diamonds/**, **/payouts/**, **/kyc/**, **/mfa/**,
      **/step-up/**
    - pages/api/admin/**, pages/api/debug/**, pages/api/emergency/**,
      pages/api/webhooks/**, pages/api/cron/**
    - vercel.json, next.config.*, .github/workflows/**, .husky/**,
      package.json, yarn.lock, package-lock.json, .env*
    - lib/supabaseAdmin*, lib/serviceRole*, lib/stripe*
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

<files_updated>
[
  {
    "path": "relative/path/from/repo/root.ext",
    "content": "ENTIRE NEW FILE CONTENTS — every line. Not a diff. Not a partial.\\nJSON-escape special chars. Use \\\\n for line breaks inside the JSON string."
  }
]
</files_updated>

<test_note>
One sentence naming the test you added/updated and what it guards
against. Or "none-possible" with reason.
</test_note>

<confidence>
A single word: high | medium | low.
</confidence>

Rules for the <files_updated> block:
- You MUST return the ENTIRE file content, not a diff.
- Include EVERY line — imports, comments, exports — exactly as the final file should look.
- If you changed 3 lines in a 200-line file, you still return all 200 lines with those 3 changes applied.
- JSON must be valid — escape all backslashes (\\\\), quotes (\\"), and newlines (\\n) inside string values.
- Only include files you are actually changing. Do not list files you only read.
- At least 1 file must be present. Multiple files are fine.
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
