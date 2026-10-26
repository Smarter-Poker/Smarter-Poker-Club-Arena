import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createReplacementSubjectClient } from './supabase/client.js';

export const REPLACEMENT_BOARD = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
export const REPLACEMENT_OWNER = '47965354-0e56-43ef-931c-ddaab82af765';
const BATCH = 'patterned-retirement-20261006';
type Mapping = { retiredHorseId: string; horseId: string };
export interface BoardingAdapter {
  plan(): Promise<any>;
  referralAgent(): Promise<string | null>;
  verify(row: Mapping): Promise<void>;
  board(): Promise<{ count: number; maximum: number }>;
  member(id: string): Promise<any>;
  receipt(id: string, request: string): Promise<any>;
  join(row: Mapping, request: string): Promise<any>;
}
export function boardingRequest(row: Mapping): string {
  const b = createHash('sha256')
    .update(`${BATCH}:dss-boarding-v1:${row.retiredHorseId}:${row.horseId}:${REPLACEMENT_BOARD}`)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function memberScope(m: any, id: string, agent: string | null) {
  if (
    !m ||
    m.user_id !== id ||
    m.club_id !== REPLACEMENT_BOARD ||
    m.role !== 'player' ||
    !['active', 'approved'].includes(m.status) ||
    m.is_active !== true ||
    m.membership_lifecycle_status !== 'active' ||
    m.invited_by !== REPLACEMENT_OWNER ||
    m.agent_id !== agent
  )
    throw Error('Original DSS membership scope changed; no membership was overwritten');
}
function receiptScope(r: any, id: string, agent: string | null) {
  if (
    r?.success !== true ||
    r.club?.id !== REPLACEMENT_BOARD ||
    !['active', 'approved'].includes(r.status)
  )
    throw Error('Original join refused or receipt scope changed');
  memberScope(r.membership, id, agent);
}
/** One finite manual invocation. Unknown outcomes retain the same original request. */
export async function boardReplacementHorses(execute: boolean, a: BoardingAdapter) {
  const p = await a.plan();
  if (
    p?.batch !== BATCH ||
    p.completed_replacements !== 62 ||
    !Array.isArray(p.replacements) ||
    p.replacements.length !== 62 ||
    !Number.isInteger(p.eligible_active) ||
    !Number.isInteger(p.active_roster) ||
    p.eligible_active < 1000 ||
    p.active_roster < 1000
  )
    throw Error('Complete canonical replacement births and roster first');
  const rows: Mapping[] = p.replacements;
  if (
    createHash('md5')
      .update(
        rows
          .map((r) => r.retiredHorseId)
          .sort()
          .join(',')
      )
      .digest('hex') !== 'cd746293f12b88be4f1a42cfa7a28316'
  )
    throw Error('Original retirement cohort changed');
  if (
    new Set(rows.map((r) => r.horseId)).size !== 62 ||
    new Set(rows.map((r) => r.retiredHorseId)).size !== 62 ||
    rows.some(
      (r) =>
        !/^[-0-9a-f]{36}$/i.test(r.retiredHorseId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.horseId) ||
        /^(00000000|face0000)-/i.test(r.horseId)
    )
  )
    throw Error('Replacement mapping identity changed');
  const agent = await a.referralAgent();
  if (agent !== REPLACEMENT_OWNER) throw Error('Original Kingfish referral authority unavailable');
  const verifyAuthority = async () => {
    if ((await a.referralAgent()) !== agent)
      throw Error('Original Kingfish referral authority changed; accepted joins retained');
  };
  // Validate the entire cohort before the first session or join operation.
  const missing: Mapping[] = [];
  let seventy = 0;
  for (const r of rows) {
    await a.verify(r);
    const m = await a.member(r.horseId);
    if (m) {
      memberScope(m, r.horseId, agent);
      const receipt = await a.receipt(r.horseId, boardingRequest(r));
      receiptScope(receipt, r.horseId, agent);
      if (Number(m.player_rakeback_pct) === 0.7 && m.player_rakeback_explicit === true) seventy++;
    } else missing.push(r);
  }
  const initial = await a.board();
  if (initial.count + missing.length > initial.maximum)
    throw Error('DSS headroom is insufficient; no joins attempted');
  if (!execute)
    return {
      mode: 'inspect',
      eligible: 62,
      already_boarded: 62 - missing.length,
      remaining: missing.length,
      current_members: initial.count,
      maximum: initial.maximum,
      seventy_percent: seventy,
      funded: false,
      seated: false,
    };
  let added = 0;
  for (const r of missing) {
    await verifyAuthority();
    await a.verify(r);
    const current = await a.board();
    if (
      current.count !== initial.count + added ||
      current.maximum !== initial.maximum ||
      current.count + missing.length - added > current.maximum
    )
      throw Error('DSS capacity changed; original joins retained, inspect before resuming');
    const request = boardingRequest(r);
    let receipt = await a.receipt(r.horseId, request);
    if (!receipt) {
      try {
        receipt = await a.join(r, request);
      } catch (e) {
        if (e instanceof Error && e.message === 'Original subject local cleanup unknown') throw e;
        try {
          receipt = await a.receipt(r.horseId, request);
        } catch {
          throw Error(`Join outcome unknown for ${r.horseId}; retain original request ${request}`);
        }
        if (!receipt)
          throw Error(`Join outcome unknown for ${r.horseId}; retain original request ${request}`);
      }
    }
    receiptScope(receipt, r.horseId, agent);
    memberScope(await a.member(r.horseId), r.horseId, agent);
    added++;
  }
  await verifyAuthority();
  const final = await a.board();
  if (final.count !== initial.count + added || final.count > final.maximum)
    throw Error('DSS population changed after joins; actual membership requires inspection');
  const finalPlan = await a.plan();
  if (JSON.stringify(finalPlan.replacements) !== JSON.stringify(p.replacements))
    throw Error('Original replacement mapping changed during boarding');
  seventy = 0;
  for (const r of rows) {
    await a.verify(r);
    const m = await a.member(r.horseId);
    memberScope(m, r.horseId, agent);
    if (Number(m.player_rakeback_pct) === 0.7 && m.player_rakeback_explicit === true) seventy++;
  }
  // Rakeback is an existing staff agreement door, never a service-role raw write.
  return {
    mode: 'execute',
    boarded: 62,
    members: final.count,
    maximum: final.maximum,
    canonical_eligible_active: finalPlan.eligible_active,
    canonical_active_roster: finalPlan.active_roster,
    seventy_percent: seventy,
    staff_rakeback_terms_pending: 62 - seventy,
    funded: false,
    seated: false,
    capacity_concurrency:
      'observed preflight/readback; ordinary joins do not share a club-capacity lock',
  };
}

function value(r: any) {
  if (r.error) throw r.error;
  return r.data;
}
export function replacementBoardingAdapter(admin: SupabaseClient, url: string): BoardingAdapter {
  return {
    async plan() {
      return value(
        await admin.rpc('fn_reserve_patterned_horse_replacements', { p_reserve: false })
      );
    },
    async referralAgent() {
      // The normal join owner places a player directly under the club owner,
      // including when that owner has no separate active agents row.
      const club = value(
        await admin.from('clubs').select('id,owner_id').eq('id', REPLACEMENT_BOARD).maybeSingle()
      );
      const profile = value(
        await admin
          .from('profiles')
          .select('id,player_number')
          .eq('id', REPLACEMENT_OWNER)
          .maybeSingle()
      );
      const member = value(
        await admin
          .from('club_members')
          .select('club_id,user_id,status,agent_id')
          .eq('club_id', REPLACEMENT_BOARD)
          .eq('user_id', REPLACEMENT_OWNER)
          .maybeSingle()
      );
      if (
        club?.id !== REPLACEMENT_BOARD ||
        club.owner_id !== REPLACEMENT_OWNER ||
        profile?.id !== REPLACEMENT_OWNER ||
        String(profile.player_number) !== '1' ||
        member?.club_id !== REPLACEMENT_BOARD ||
        member.user_id !== REPLACEMENT_OWNER ||
        !['active', 'approved', 'automatic'].includes(member.status) ||
        member.agent_id !== null
      )
        throw Error('Original Kingfish referral authority unavailable');
      return REPLACEMENT_OWNER;
    },
    async verify(r) {
      const u = value(await admin.auth.admin.getUserById(r.horseId)).user;
      if (
        u?.id !== r.horseId ||
        !u.email ||
        u.user_metadata?.horse_creation_operation !== BATCH ||
        u.user_metadata?.retired_horse_id !== r.retiredHorseId
      )
        throw Error('Original replacement Auth metadata changed');
      const p = value(
        await admin
          .from('profiles')
          .select('id,is_horse,status,horse_status')
          .eq('id', r.horseId)
          .maybeSingle()
      );
      if (
        !p ||
        p.id !== r.horseId ||
        p.is_horse !== true ||
        p.status === 'deleted' ||
        p.horse_status === 'disabled'
      )
        throw Error('Original horse is not eligible');
      const registered = value(
        await admin
          .from('ca_horse_fleet_register')
          .select('horse_id,retired_at')
          .eq('horse_id', r.horseId)
          .maybeSingle()
      );
      const roster = value(
        await admin
          .from('ca_horse_active_roster')
          .select('horse_id')
          .eq('horse_id', r.horseId)
          .maybeSingle()
      );
      if (!registered || !roster || registered.retired_at !== null || roster.horse_id !== r.horseId)
        throw Error('Original horse is absent from canonical active roster');
    },
    async board() {
      const c = value(
        await admin
          .from('clubs')
          .select(
            'id,owner_id,requires_approval,status,lifecycle_status,max_members,settlement_locked'
          )
          .eq('id', REPLACEMENT_BOARD)
          .maybeSingle()
      );
      if (
        !c ||
        c.owner_id !== REPLACEMENT_OWNER ||
        c.requires_approval !== false ||
        c.status !== 'active' ||
        c.lifecycle_status !== 'active' ||
        c.settlement_locked !== false ||
        !Number.isInteger(c.max_members)
      )
        throw Error('DSS admission settings changed');
      const count = await admin
        .from('club_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('club_id', REPLACEMENT_BOARD)
        .in('status', ['active', 'approved', 'pending']);
      if (count.error || count.count === null) throw Error('DSS capacity read unavailable');
      return { count: count.count, maximum: c.max_members };
    },
    async member(id) {
      return value(
        await admin
          .from('club_members')
          .select(
            'club_id,user_id,role,status,is_active,membership_lifecycle_status,agent_id,invited_by,player_rakeback_pct,player_rakeback_explicit'
          )
          .eq('club_id', REPLACEMENT_BOARD)
          .eq('user_id', id)
          .maybeSingle()
      );
    },
    async receipt(id, request) {
      const r = value(
        await admin
          .from('club_join_idempotency')
          .select('club_id,result')
          .eq('user_id', id)
          .eq('request_id', request)
          .maybeSingle()
      );
      if (r && r.club_id !== REPLACEMENT_BOARD) throw Error('Original join request scope changed');
      return r?.result ?? null;
    },
    async join(r, request) {
      const u = value(await admin.auth.admin.getUserById(r.horseId)).user;
      if (
        u?.id !== r.horseId ||
        u.user_metadata?.horse_creation_operation !== BATCH ||
        u.user_metadata?.retired_horse_id !== r.retiredHorseId
      )
        throw Error('Original subject changed');
      const link = value(
        await admin.auth.admin.generateLink({ type: 'magiclink', email: u.email })
      );
      if (link.user?.id !== r.horseId || !link.properties?.hashed_token)
        throw Error('Original subject link mismatch');
      const subject = createReplacementSubjectClient(url);
      try {
        const login = value(
          await subject.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
        );
        if (
          login.user?.id !== r.horseId ||
          login.session?.user?.id !== r.horseId ||
          value(await subject.auth.getUser()).user?.id !== r.horseId
        )
          throw Error('Original subject session mismatch');
        return value(
          await subject.rpc('fn_join_club_atomic', {
            p_identifier: REPLACEMENT_BOARD,
            p_request_id: request,
            p_referral_code: 'kingfish',
          })
        );
      } finally {
        const out = await subject.auth.signOut({ scope: 'local' });
        if (out.error) throw Error('Original subject local cleanup unknown');
      }
    },
  };
}
