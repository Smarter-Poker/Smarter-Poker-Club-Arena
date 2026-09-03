/**
 * WHO IS ALLOWED TO BUILD A GAME (2026-08-19).
 *
 * The rule Dan set: a standalone club's owner and admins build its own cash
 * games and tournaments; for a club inside a union, the union owner and union
 * admins build them and the club does not.
 *
 * Before this, the create-table page asked a DIFFERENT question — "is this club
 * in a union?" — and bounced every visitor if so. That refused the union owner,
 * the one person the rule says must be able to build for a union's clubs, and
 * there was no other path in the UI.
 *
 * This file pins the part of the answer the UI is responsible for: reading the
 * database's verdict without ever turning a broken or partial answer into a
 * "yes". The verdict itself is proved against production data in SQL; what can
 * go wrong HERE is the parsing, and every failure mode must fail CLOSED.
 */
import { describe, it, expect } from 'vitest';
import {
  parseGameCreationAccess,
  gameCreationDeniedMessage,
  GAME_CREATION_DENIED_MESSAGES,
  type GameCreationAccess,
} from '../../src/lib/gameCreationAccess';
// NOTE: imported from src/lib (pure) and NOT from services/GameAccessService —
// that module constructs the Supabase client at import time, which would make
// this suite depend on env vars it has no business needing.

const UNION = 'ddd00000-0000-0000-0000-0000000000a1';

describe('parseGameCreationAccess — the allowed cases', () => {
  it('lets a standalone club owner through with no union stamp', () => {
    expect(parseGameCreationAccess({ allowed: true, union_id: null, reason: 'ok' })).toEqual({
      allowed: true,
      unionId: null,
      reason: 'ok',
    });
  });

  it('lets the union owner through AND reports the union to stamp on the row', () => {
    // This is the case the old code got wrong: the club is in a union, and the
    // answer is still yes because of WHO is asking.
    expect(parseGameCreationAccess({ allowed: true, union_id: UNION, reason: 'ok' })).toEqual({
      allowed: true,
      unionId: UNION,
      reason: 'ok',
    });
  });
});

describe('parseGameCreationAccess — the refusals keep their reason', () => {
  it('a club inside a union is refused with union_only, and still reports the union', () => {
    expect(
      parseGameCreationAccess({ allowed: false, union_id: UNION, reason: 'union_only' })
    ).toEqual({ allowed: false, unionId: UNION, reason: 'union_only' });
  });

  it.each(['not_owner_or_admin', 'unknown_club', 'not_signed_in'] as const)(
    'passes %s through unchanged',
    (reason) => {
      const out = parseGameCreationAccess({ allowed: false, union_id: null, reason });
      expect(out.allowed).toBe(false);
      expect(out.reason).toBe(reason);
    }
  );
});

describe('parseGameCreationAccess — every malformed answer fails CLOSED', () => {
  const junk: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'allowed'],
    ['a number', 1],
    ['an array', [{ allowed: true }]],
    ['an empty object', {}],
    ['the string "true"', { allowed: 'true', union_id: null, reason: 'ok' }],
    ['the number 1', { allowed: 1, union_id: null, reason: 'ok' }],
    ['allowed missing', { union_id: null, reason: 'ok' }],
  ];

  it.each(junk)('%s is a refusal', (_label, value) => {
    expect(parseGameCreationAccess(value).allowed).toBe(false);
  });

  it('a self-contradictory answer — allowed with a denial reason — is refused', () => {
    // If the two halves disagree, there is no safe way to pick a winner.
    expect(
      parseGameCreationAccess({ allowed: true, union_id: UNION, reason: 'union_only' })
    ).toEqual({ allowed: false, unionId: null, reason: 'check_failed' });
  });

  it('a refusal labelled "ok" is also refused', () => {
    expect(parseGameCreationAccess({ allowed: false, union_id: null, reason: 'ok' }).allowed).toBe(
      false
    );
  });

  it('an unrecognised reason on a refusal becomes check_failed rather than leaking through', () => {
    const out = parseGameCreationAccess({ allowed: false, union_id: null, reason: 'banana' });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('check_failed');
  });
});

describe('parseGameCreationAccess — the union id it hands back', () => {
  it('an empty-string union id becomes null, never an empty stamp on the row', () => {
    // `union_id: ''` written to the table would be rejected by the uuid column;
    // NULL is the correct "no union".
    expect(
      parseGameCreationAccess({ allowed: true, union_id: '', reason: 'ok' }).unionId
    ).toBeNull();
  });

  it('a non-string union id is ignored', () => {
    expect(
      parseGameCreationAccess({ allowed: true, union_id: 12345, reason: 'ok' }).unionId
    ).toBeNull();
  });
});

describe('gameCreationDeniedMessage', () => {
  it('explains a union club to its own owner without blaming them', () => {
    const msg = gameCreationDeniedMessage({
      allowed: false,
      unionId: UNION,
      reason: 'union_only',
    });
    expect(msg).toBe(GAME_CREATION_DENIED_MESSAGES.union_only);
    expect(msg).toMatch(/union/i);
  });

  it('has a real sentence for every refusal reason — no undefined toasts', () => {
    const reasons = Object.keys(GAME_CREATION_DENIED_MESSAGES) as Array<
      keyof typeof GAME_CREATION_DENIED_MESSAGES
    >;
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      const msg = gameCreationDeniedMessage({ allowed: false, unionId: null, reason });
      expect(typeof msg).toBe('string');
      expect(msg.trim().length).toBeGreaterThan(10);
    }
  });

  it('falls back to a sentence rather than undefined if reason is somehow "ok" while denied', () => {
    const weird = { allowed: false, unionId: null, reason: 'ok' } as unknown as GameCreationAccess;
    expect(gameCreationDeniedMessage(weird)).toBe(GAME_CREATION_DENIED_MESSAGES.check_failed);
  });

  it('says nothing when access was granted', () => {
    expect(gameCreationDeniedMessage({ allowed: true, unionId: null, reason: 'ok' })).toBe('');
  });
});
