import { supabase } from './supabase.js';
import { createHorse, type HorseCreationOperation } from './HorseOnboarding.js';

export const PATTERNED_REPLACEMENT_COUNT = 62;
export const PATTERNED_REPLACEMENT_BATCH = 'patterned-retirement-20261006';
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Rpc = (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
interface Dependencies {
  rpc: Rpc;
  create: typeof createHorse;
}

/** Explicit finite operator invocation. No startup hook, timer, seating or funding. */
export async function replacePatternedHorses(
  execute: boolean,
  deps: Dependencies = { rpc: (name, args) => supabase.rpc(name, args), create: createHorse }
) {
  const { data: plan, error } = await deps.rpc('fn_reserve_patterned_horse_replacements', {
    p_reserve: execute,
  });
  if (error) throw error;
  if (
    plan?.batch !== PATTERNED_REPLACEMENT_BATCH ||
    !Array.isArray(plan.replacements) ||
    plan.replacements.length !== PATTERNED_REPLACEMENT_COUNT
  )
    throw new Error('Replacement cohort changed; no accounts created');
  const oldIds = new Set<string>(),
    newIds = new Set<string>();
  const operations: HorseCreationOperation[] = [];
  for (const row of plan.replacements) {
    if (
      typeof row.retiredHorseId !== 'string' ||
      !/^(00000000|face0000)-0000-0000-0000-[0-9a-f]{12}$/i.test(row.retiredHorseId) ||
      oldIds.has(row.retiredHorseId)
    )
      throw new Error('Replacement original identity is duplicated');
    oldIds.add(row.retiredHorseId);
    if (row.horseId === null && !execute) continue;
    if (
      typeof row.horseId !== 'string' ||
      !uuid4.test(row.horseId) ||
      /^(00000000|face0000)-/i.test(row.horseId) ||
      newIds.has(row.horseId)
    )
      throw new Error('Replacement identity is absent, patterned or duplicated');
    newIds.add(row.horseId);
    operations.push({ horseId: row.horseId, retiredHorseId: row.retiredHorseId });
  }
  if (!execute)
    return {
      batch: plan.batch,
      mode: 'inspect',
      reserved: operations.length,
      replacements: plan.replacements,
      onboarded: 0,
      seated: false,
      club_funded: false,
    };
  // A failure stops this invocation. The next explicit invocation reads the
  // same private mappings and recovers every original auth operation.
  for (const operation of operations) {
    const horse = await deps.create({ operation });
    if (!horse || horse.id !== operation.horseId)
      throw new Error(
        `Original replacement ${operation.retiredHorseId} is incomplete; resume this batch`
      );
  }
  const registered = await deps.rpc('fn_ca_fleet_register_sync', { p_actor: null });
  if (registered.error || registered.data?.ok !== true)
    throw registered.error ?? new Error('Fleet registration not confirmed');
  const roster = await deps.rpc('fn_ca_horse_roster_refresh');
  if (roster.error) throw roster.error;
  const { data: proof, error: proofError } = await deps.rpc(
    'fn_reserve_patterned_horse_replacements',
    { p_reserve: false }
  );
  if (proofError) throw proofError;
  if (
    proof?.eligible_active !== 1000 ||
    proof?.active_roster !== 1000 ||
    proof?.completed_replacements !== 62
  )
    throw new Error(
      `Original replacement batch retained; canonical population target mismatch: eligible=${proof?.eligible_active}, roster=${proof?.active_roster}, completed=${proof?.completed_replacements}; no other identity was removed`
    );
  return {
    batch: plan.batch,
    mode: 'execute',
    onboarded: operations.length,
    eligible_active: proof.eligible_active,
    active_roster: proof.active_roster,
    initial_active_count: proof.initial_active_count,
    initial_active_md5: proof.initial_active_md5,
    population_changed: proof.population_changed,
    seated: false,
    club_funded: false,
  };
}
