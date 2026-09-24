/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ENFORCED ADMISSION REFUSAL READS AS THE SERVER WROTE IT (20260924102056)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Once staff enforce commerce admission, four owner doors refuse a NEW action
 * with a Title Case sentence from fn_ca_commerce_admission_message, each in
 * its own shape:
 *
 *   fn_review_join_request         { success: false, error: <sentence>, code: 'operating_access_required' }
 *   fn_create_tournament           { success: false, error: 'operating_access_required', message: <sentence> }
 *   fn_upsert_tournament_schedule  { error: 'operating_access_required', message: <sentence> }
 *   fn_cash_game_create            RAISE EXCEPTION <sentence> USING HINT = 'operating_access_required'
 *
 * This file reads every sentence out of the migration and proves each surface
 * shows it verbatim, so an owner is told WHY (and that nothing running is
 * affected) instead of "Failed To Approve Member" or a fallback line.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/GameAccessService', () => ({
  fetchGameCreationAccess: async () => ({ allowed: true }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (value: string) => value,
}));

import { supabase } from '../../src/lib/supabase';
import {
  OPERATING_ACCESS_FALLBACK,
  operatingAccessRefusal,
} from '../../src/services/CommerceDeskService';
import {
  TOURNAMENT_CREATE_ERRORS,
  tournamentCreateErrorMessage,
} from '../../src/lib/tournamentCreationRules';
import { cashGameCreateRefusalText } from '../../src/config/cashGames';
import { tournamentService, type TournamentConfig } from '../../src/services/TournamentService';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import { BLIND_STRUCTURES, newTournamentPlayingLevels } from '../../src/config/blindStructures';

afterEach(() => vi.restoreAllMocks());

const ROOT = resolve(__dirname, '../..');
const SQL = readFileSync(
  resolve(
    ROOT,
    'supabase/migrations/20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql'
  ),
  'utf8'
);
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** fn_ca_commerce_admission_message: action -> sentence (ELSE under 'else'). */
function admissionSentences(): Map<string, string[]> {
  const fn = SQL.match(
    /CREATE FUNCTION public\.fn_ca_commerce_admission_message[\s\S]*?\$\$([\s\S]*?)\$\$;/
  );
  expect(fn, 'fn_ca_commerce_admission_message').not.toBeNull();
  const out = new Map<string, string[]>();
  for (const m of fn![1].matchAll(/WHEN p_action = '([a-z_]+)'[^\n]*\n\s*THEN '([^']+)'/g)) {
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  const otherwise = fn![1].match(/ELSE '([^']+)'/);
  if (otherwise) out.set('else', [otherwise[1]]);
  return out;
}
const SENTENCES = admissionSentences();
const sentences = (action: string) => SENTENCES.get(action) ?? [];

describe('the sentences are read from the migration', () => {
  it('finds every action the gate names', () => {
    for (const action of ['approve_member', 'open_table', 'create_tournament', 'club_insurance'])
      expect(sentences(action).length, action).toBeGreaterThan(0);
    // approve_member has two: capacity reached, and no operating access.
    expect(sentences('approve_member')).toHaveLength(2);
    expect(sentences('else')).toEqual([OPERATING_ACCESS_FALLBACK]);
  });

  it('pins the four refusal shapes the doors answer with', () => {
    expect(SQL).toMatch(
      /RETURN jsonb_build_object\('success', false, 'error', v_ca_admission->>'message',\s*'code', 'operating_access_required'/
    );
    expect(SQL).toMatch(
      /RETURN jsonb_build_object\('success', false, 'error', 'operating_access_required',\s*'message', v_ca_admission->>'message'/
    );
    expect(SQL).toMatch(
      /RETURN jsonb_build_object\('error', 'operating_access_required',\s*'message', v_ca_admission->>'message'/
    );
    expect(SQL).toMatch(
      /RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required'/
    );
  });
});

describe('member approval shows the refusal sentence', () => {
  it.each(sentences('approve_member'))('%s', (sentence) => {
    expect(
      operatingAccessRefusal({
        success: false,
        error: sentence,
        code: 'operating_access_required',
        reason: 'capacity_reached',
      })
    ).toBe(sentence);
  });

  it('ClubDetailPage reads it before the generic toast', () => {
    const page = read('src/pages/ClubDetailPage.tsx');
    const at = page.indexOf("supabase.rpc('fn_review_join_request'");
    const refusal = page.indexOf('operatingAccessRefusal(res)', at);
    const generic = page.indexOf('throw new Error(res?.error ||', at);
    expect(at).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(at);
    expect(refusal).toBeLessThan(generic);
  });

  it('is not fooled by any other refusal', () => {
    expect(operatingAccessRefusal({ success: false, error: 'not_authorised' })).toBeNull();
    expect(operatingAccessRefusal(null)).toBeNull();
    expect(
      operatingAccessRefusal({ success: false, code: 'operating_access_required', error: '' })
    ).toBe(OPERATING_ACCESS_FALLBACK);
  });
});

const mtt: TournamentConfig = {
  name: 'Admission Probe',
  type: 'mtt',
  buyIn: 20,
  rake: 2,
  startingStack: 10000,
  maxPlayers: null,
  minPlayers: 3,
  tableSize: 9,
  gameVariant: 'NLH',
  blindStructure: newTournamentPlayingLevels(BLIND_STRUCTURES.regular),
  payoutStructure: [{ place: 1, percentage: 100 }],
  payoutPercent: 10,
  lateRegistrationLevels: 6,
  isRebuy: false,
  addOnAvailable: false,
};

describe('tournament creation shows the server message', () => {
  const [sentence] = sentences('create_tournament');

  it('the house line for the code is the same sentence', () => {
    expect(TOURNAMENT_CREATE_ERRORS.operating_access_required).toBe(sentence);
    expect(tournamentCreateErrorMessage('operating_access_required', sentence)).toBe(sentence);
    expect(tournamentCreateErrorMessage('operating_access_required', null)).toBe(sentence);
    // A message never overrides any other code's own sentence.
    expect(tournamentCreateErrorMessage('payouts_must_total_100', 'Server Words')).toBe(
      TOURNAMENT_CREATE_ERRORS.payouts_must_total_100
    );
  });

  it('createTournament throws the message the server sent', async () => {
    const said =
      'This Club Needs Active Operating Access To Create A New Tournament. Words From The Server.';
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: {
        success: false,
        error: 'operating_access_required',
        message: said,
        reason: 'no_effective_entitlement',
      },
      error: null,
    } as never);
    await expect(tournamentService.createTournament('club', mtt)).rejects.toThrow(said);
  });

  it('a recurring schedule shows it too', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: {
        error: 'operating_access_required',
        message: sentence,
        reason: 'no_effective_entitlement',
      },
      error: null,
    } as never);
    await expect(
      tournamentScheduleService.upsert({
        clubId: 'club',
        name: 'Weekly',
        daysOfWeek: [0],
        startTimesUtc: ['18:00'],
        config: { type: 'satellite', satelliteTargetName: 'Sunday' },
      })
    ).rejects.toThrow(sentence);
  });
});

describe('cash game creation shows the raised sentence as written', () => {
  it.each([
    ...sentences('open_table'),
    ...sentences('club_insurance'),
    ...sentences('union_insurance'),
  ])('%s', (sentence) => {
    expect(cashGameCreateRefusalText(new Error(sentence))).toBe(sentence);
    // As supabase-js hands it over: message plus the HINT.
    expect(
      cashGameCreateRefusalText({
        message: sentence,
        hint: 'operating_access_required',
        code: 'P0001',
      })
    ).toBe(sentence);
  });
});
