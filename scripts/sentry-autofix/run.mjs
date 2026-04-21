// Entry point for the Club Arena GH Action step. Orchestrates the full loop:
//
//   1. Load Sentry issue + latest event.
//   2. Extract stack + in_app source files + symbol hints (NEW).
//   3. Resolve those to real files on disk via the shared resolver (NEW module).
//   4. Call Claude with the structured prompt.
//   5. Parse response; either <cannot_fix> or apply <files_updated>.
//   6. Post-apply denylist check.
//   7. Open PR with labels, link Sentry issue.
//   8. Update Supabase autofix_attempts row.
//
// Hardening (Phase 5.2.0 bug-hunt):
//   * resolveFiles moved to ./resolve.mjs with (a) recursive basename fallback
//     so symbol hints like "CreditService" still map to real files, (b) 500KB
//     size ceiling (was 200KB — real culprits were getting excluded).
//   * extractStack is now called with issue.title so reportError-captured errors
//     (top frame = errorReporter.ts helper) still produce usable source_files
//     via the class-name symbol extractor.
//   * main().catch now writes `errored` to the ledger before exit so a mid-run
//     crash cannot leave a row stranded in `running`. This runs in addition to
//     the workflow's mark-errored step (belt + suspenders).

import fs from 'node:fs';
import path from 'node:path';
import { fetchIssue, fetchLatestEvent, extractStack } from './fetch-issue.mjs';
import { resolveFiles } from './resolve.mjs';
import { callClaude } from './claude.mjs';
import { buildMessages, SYSTEM_PROMPT } from './prompt.mjs';
import { parseClaudeResponse, applyPatch } from './patch.mjs';
import { assessPaths, DENYLIST } from './policy.mjs';
import { openAutofixPR } from './pr.mjs';
import { createClient } from '@supabase/supabase-js';

// Club Arena repo layout. Ordering matters — the resolver tries these in
// order and takes the first hit (then falls back to a recursive basename
// walk). Most-specific first so src/engine/... wins over src/.
const SUBDIRS = [
  "",
  "src",
  "CA/src",
  "server/src",
  "src/engine",
  "src/services",
  "src/utils",
  "src/components",
  "src/hooks",
  "src/pages",
  "src/lib",
  "src/store",
  "src/context",
];

function log(o) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...o })); }

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function updateAttempt(attemptId, fields) {
  if (!attemptId) return;
  const s = sb(); if (!s) return;
  const { error } = await s.from('autofix_attempts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', attemptId);
  if (error) log({ level: 'warn', msg: 'updateAttempt failed', err: error.message });
}

function repoRoot() {
  // The checkout action lands us at GITHUB_WORKSPACE; the runner script
  // itself lives at scripts/sentry-autofix/ — cwd might be either.
  const here = process.cwd();
  const up = path.resolve(here, '..', '..');
  if (fs.existsSync(path.join(up, '.git'))) return up;
  return process.env.GITHUB_WORKSPACE || here;
}

async function main() {
  const issueId = process.env.SENTRY_ISSUE_ID;
  const attemptId = process.env.AUTOFIX_ATTEMPT_ID || '';
  const mode = process.env.AUTOFIX_MODE || 'dry-run';
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
  const root = repoRoot();
  const repoEnv = process.env.GITHUB_REPOSITORY || 'Smarter-Poker/Smarter-Poker-Club-Arena';
  const [owner, repo] = repoEnv.split('/');
  const baseBranch = process.env.GITHUB_REF_NAME || 'main';

  if (!issueId) { log({ level: 'error', msg: 'SENTRY_ISSUE_ID not set' }); process.exit(2); }

  log({ level: 'info', msg: 'autofix start', issueId, attemptId, mode, model, root, repo: repoEnv });

  await updateAttempt(attemptId, { status: 'running', run_id: process.env.GITHUB_RUN_ID || null });

  const issue = await fetchIssue(issueId);
  const event = await fetchLatestEvent(issueId);
  // Thread the issue title into extractStack so the symbol-hint extractor has
  // access to "[CreditService.getAgentInvoices]" style context even when the
  // exception.value omits it.
  const stack = extractStack(event, issue.title);
  log({
    level: 'info', msg: 'issue fetched',
    short_id: issue.shortId, culprit: issue.culprit,
    frames: stack.frames.length,
    files: stack.source_files,
    symbol_hints: stack.symbol_hints || [],
  });

  // Pre-gate: does the stack point at any denylisted file?
  // NOTE: symbol-only hints (bare identifiers) don't match denylist substrings,
  //       so the pre-gate is unchanged; the post-apply gate is what enforces.
  const prePaths = stack.source_files.map(f => f.replace(/^\.?\//, ''));
  const preAssess = assessPaths(prePaths);
  if (!preAssess.ok) {
    log({ level: 'info', msg: 'issue originates in denylist — opening diagnostic PR', denied: preAssess.denied });
  }

  const files = resolveFiles(root, stack.source_files, SUBDIRS, { maxFiles: 8, maxSize: 500_000 });
  if (files.length === 0) {
    log({ level: 'warn', msg: 'no in-app source files resolved — Claude cannot propose a diff', tried: stack.source_files });
    await updateAttempt(attemptId, { status: 'rejected', error_message: 'no in-app source files to show Claude' });
    process.exit(0);
  }

  const messages = buildMessages({
    issue, stack, files,
    repoName: repoEnv,
  });
  log({ level: 'info', msg: 'calling Claude', model, files: files.map(f => f.path) });

  const t0 = Date.now();
  const reply = await callClaude({ model, system: SYSTEM_PROMPT, messages, maxTokens: 8192, temperature: 0 });
  log({ level: 'info', msg: 'Claude responded', elapsed_ms: Date.now() - t0, stop: reply.stopReason, tokens_in: reply.usage?.input_tokens, tokens_out: reply.usage?.output_tokens });

  let parsed;
  try { parsed = parseClaudeResponse(reply.text); }
  catch (err) {
    log({ level: 'error', msg: 'parse failed', err: String(err), text_head: reply.text.slice(0, 500) });
    await updateAttempt(attemptId, { status: 'errored', error_message: `parse: ${err.message}`.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    process.exit(3);
  }

  if (parsed.cannotFix) {
    log({ level: 'info', msg: 'Claude declined', reason: parsed.reason });
    await updateAttempt(attemptId, { status: 'rejected', error_message: parsed.reason.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    return;
  }

  // Apply patch.
  let changed;
  try { changed = applyPatch(root, parsed.filesUpdated); }
  catch (err) {
    log({ level: 'error', msg: 'apply failed', err: String(err).slice(0, 500) });
    await updateAttempt(attemptId, { status: 'errored', error_message: `apply: ${err.message}`.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    process.exit(4);
  }
  log({ level: 'info', msg: 'patch applied', files: changed });

  // Post-apply denylist check — belt + suspenders.
  const postAssess = assessPaths(changed);
  if (!postAssess.ok) {
    log({ level: 'warn', msg: 'post-apply denylist hit — aborting', denied: postAssess.denied });
    await updateAttempt(attemptId, { status: 'rejected', error_message: `denylisted paths: ${postAssess.denied.join(',')}`.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    process.exit(0);
  }

  // Open PR (draft in dry-run).
  const pr = await openAutofixPR({
    owner, repo, baseBranch, issue,
    parsed, attemptId, mode, repoRoot: root,
  });
  log({ level: 'info', msg: 'PR opened', url: pr.url, number: pr.number, labels: pr.labels });

  await updateAttempt(attemptId, {
    status: 'pr_opened',
    fix_branch: pr.branch,
    fix_pr_url: pr.url,
    fix_pr_number: pr.number,
    claude_tokens_in: reply.usage?.input_tokens || null,
    claude_tokens_out: reply.usage?.output_tokens || null,
    claude_confidence: parsed.confidence,
    changed_files: changed,
  });
}

main().catch(async (err) => {
  const attemptId = process.env.AUTOFIX_ATTEMPT_ID || '';
  log({ level: 'error', msg: 'fatal', err: String(err?.stack || err).slice(0, 1500) });
  // Belt-and-suspenders: write `errored` to the ledger BEFORE exit so the row
  // can't be stranded in `running` if the workflow's mark-errored step itself
  // fails (e.g. network hiccup during cleanup).
  try {
    await updateAttempt(attemptId, {
      status: 'errored',
      error_message: `fatal: ${String(err?.message || err)}`.slice(0, 500),
    });
  } catch (e) {
    log({ level: 'warn', msg: 'fatal-handler updateAttempt also failed', err: String(e) });
  }
  process.exit(1);
});
