// Express server that receives Sentry webhooks.
//
// Endpoints:
//   GET  /health              — liveness (no auth)
//   POST /webhooks/sentry     — Sentry webhook receiver
//
// The receiver:
//   1. Reads the raw body (express.raw) — we need the exact bytes Sentry
//      signed. DO NOT use express.json here.
//   2. Verifies the HMAC signature (verify.mjs).
//   3. Runs the policy gate (policy.mjs).
//   4. Reserves an attempt row in Supabase (circuit-breaker.mjs).
//   5. Fires repository_dispatch (github.mjs).
//   6. Responds quickly — Sentry retries after 3 s.

import express from 'express';
import { verifySentrySignature } from './verify.mjs';
import { gate } from './policy.mjs';
import { reserveAttempt, markStatus } from './circuit-breaker.mjs';
import { dispatch } from './github.mjs';
import { resolveRepo } from './router.mjs';

function log(level, fields) {
  console.log(JSON.stringify({ level, ts: new Date().toISOString(), ...fields }));
}

export function createServer() {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'sentry-autofix-webhook',
      version: '1.0.0',
      enabled: process.env.AUTOFIX_ENABLED !== 'false',
      time: new Date().toISOString(),
    });
  });

  app.post(
    '/webhooks/sentry',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const start = Date.now();
      const raw = req.body?.toString('utf8') || '';
      const sig = req.get('sentry-hook-signature') || '';
      const secret = process.env.SENTRY_WEBHOOK_SECRET || '';

      if (!verifySentrySignature(raw, sig, secret)) {
        log('warn', { msg: 'bad signature', sig_len: sig.length });
        return res.status(401).json({ error: 'bad signature' });
      }

      let payload;
      try { payload = JSON.parse(raw); }
      catch { return res.status(400).json({ error: 'bad json' }); }

      const gateResult = gate(payload);
      if (!gateResult.ok) {
        log('info', { msg: 'gated', reason: gateResult.reason });
        return res.status(202).json({ ok: false, reason: gateResult.reason });
      }

      const issue = payload?.data?.issue || payload?.issue || {};
      const issueId = String(issue.id || payload?.data?.event?.issue_id || '');
      if (!issueId) {
        return res.status(400).json({ error: 'missing issue id' });
      }

      const projectSlug = payload?.project_slug || issue.project?.slug || '';
      const fingerprint = Array.isArray(issue.fingerprint) ? issue.fingerprint.join(':') : String(issue.fingerprint || '');
      const title = String(issue.title || issue.metadata?.type || '').slice(0, 500);
      const level = String(issue.level || '');

      const routed = resolveRepo(projectSlug);
      if (!routed.ok) {
        log('warn', { msg: 'no repo for project', project: projectSlug, reason: routed.reason });
        return res.status(202).json({ ok: false, reason: routed.reason });
      }
      const repo = routed.repo;
      const reservation = await reserveAttempt({
        repo, issueId, fingerprint, projectSlug, title, level,
      });

      if (!reservation.ok) {
        log('info', { msg: 'reservation declined', reason: reservation.reason, issueId });
        return res.status(202).json({ ok: false, reason: reservation.reason });
      }

      try {
        await dispatch({
          repo,
          eventType: process.env.GITHUB_DISPATCH_EVENT || 'sentry-autofix',
          token: process.env.GITHUB_DISPATCH_TOKEN,
          payload: {
            attempt_id: reservation.attemptId,
            sentry_org: process.env.SENTRY_ORG_SLUG || 'smarter-poker',
            sentry_project: projectSlug,
            issue_id: issueId,
            issue_url: issue.web_url || issue.permalink || null,
            issue_title: title,
            issue_level: level,
            fingerprint,
            // Short ID is stable human-readable ref like "CLUB-ARENA-42"
            short_id: issue.short_id || null,
          },
        });
      } catch (err) {
        log('error', { msg: 'dispatch failed', err: String(err).slice(0, 500), issueId });
        await markStatus(reservation.attemptId, 'errored', { error_message: String(err).slice(0, 500) });
        return res.status(500).json({ error: 'dispatch failed' });
      }

      log('info', {
        msg: 'dispatched',
        attempt_id: reservation.attemptId,
        issue_id: issueId,
        project: projectSlug,
        elapsed_ms: Date.now() - start,
      });
      return res.status(202).json({ ok: true, attempt_id: reservation.attemptId });
    }
  );

  // 404 for anything else (no path traversal clues).
  app.use((_req, res) => res.status(404).end());

  return app;
}
