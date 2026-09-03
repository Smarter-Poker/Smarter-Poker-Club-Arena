import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260831150400_club_join_atomic_workflow.sql');
const service = read('src/services/ClubJoinService.ts');
const modal = read('src/components/modals/JoinClubModal.tsx');
const invitePage = read('src/pages/InvitePage.tsx');

describe('Phase 4 atomic Club Arena entry', () => {
  it('joins, redeems invitations, and records idempotency in one transaction', () => {
    expect(migration).toContain('fn_join_club_atomic');
    expect(migration).toContain('club_join_idempotency');
    expect(migration).toContain('public.fn_join_club(v_club.id)');
    expect(migration).toContain('public.fn_redeem_club_invite_code');
    expect(migration).toContain('pg_advisory_xact_lock(hashtextextended(v_uid::text, 77431))');
  });

  it('rolls an invalid invitation membership back inside a subtransaction', () => {
    expect(migration).toContain("RAISE EXCEPTION '%'");
    expect(migration).toContain("WHEN SQLSTATE 'P0003'");
    expect(migration).toContain("'invalid_invitation'");
  });

  it('rate limits lookup and join enumeration and tracks application lifecycle', () => {
    expect(migration).toContain("action='club_join_preview'");
    expect(migration).toContain("action='club_join'");
    expect(migration).toContain('trg_sync_club_join_request');
    expect(migration).toContain('fn_cancel_club_join_request');
  });
});

describe('Phase 4 join experience', () => {
  it('shows a verified preview before confirmation', () => {
    expect(modal).toContain('ClubJoinService.preview');
    expect(modal).toContain('Club Confirmation');
    expect(modal).toContain('Confirm Join');
  });

  it('accepts codes, invite links, clipboard content, and QR images', () => {
    expect(service).toContain('/\\/invite\\/([^/]+)/i');
    expect(service).toContain("url.searchParams.get('c')");
    expect(service).toContain('isClubJoinIdentifier');
    expect(modal).toContain('ClubJoinService.isValidIdentifier(initialCode)');
    expect(modal).toContain('navigator.clipboard.readText()');
    expect(modal).toContain('BarcodeDetector');
  });

  it('cannot confirm a stale preview after the code changes', () => {
    expect(modal).toContain('verifiedIdentifierRef.current !== clubCode.trim()');
    expect(modal).toContain('verifiedIdentifierRef.current = null');
    expect(modal).toContain('setPreview(null)');
  });

  it('persists interrupted requests and resumes with the same request ID', () => {
    expect(service).toContain('PENDING_JOIN_KEY');
    expect(service).toContain('requestId: pending.requestId');
    expect(modal).toContain("window.addEventListener('online', resume)");
  });

  it('routes both the modal and invite page through the same atomic service', () => {
    expect(modal).toContain('ClubJoinService.join');
    expect(invitePage).toContain('ClubJoinService.join');
  });
});
