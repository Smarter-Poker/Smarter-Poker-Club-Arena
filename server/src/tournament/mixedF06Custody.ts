import { supabase } from '../services/supabase.js';
import {
  bindToProcessRoot,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';

export interface MixedF06Transfer {
  readonly transferId: string;
  readonly successorGeneration: string;
  readonly local: Readonly<Record<string, unknown>>;
  readonly canonical: unknown;
  readonly receipt: unknown;
}
export interface MixedF06Proposal {
  readonly transferId: string;
  readonly successorGeneration: string;
  readonly local: Readonly<Record<string, unknown>>;
  canonical: unknown;
}
/** Detach and freeze nested DTOs before a possible durable write. */
export function immutableCustody<T>(value: T): T {
  const copy = JSON.parse(custodyJSON(value)) as T;
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const custodyJSON = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );

/** The original operation retains this proposal before its first possible write. */
export const prepareMixedF06Transfer = bindToProcessRoot(
  async (
    tournamentId: string,
    originGeneration: string,
    proposal: MixedF06Proposal,
    current: () => boolean
  ): Promise<MixedF06Transfer> => {
    const invoke = async () => {
      if (!current()) throw new Error('f06_mixed_physical_custody_changed');
      const { data, error } = await supabase.rpc('fn_f06_prepare_mixed_manager_custody', {
        p_transfer_id: proposal.transferId,
        p_tournament_id: tournamentId,
        p_origin_generation: originGeneration,
        p_successor_generation: proposal.successorGeneration,
        p_local: proposal.local,
        p_expected: proposal.canonical,
      });
      if (
        error ||
        !data ||
        data.ok !== true ||
        data.transfer_id !== proposal.transferId ||
        data.tournament_id !== tournamentId ||
        data.origin_generation !== originGeneration ||
        data.successor_generation !== proposal.successorGeneration ||
        custodyJSON(data.local) !== custodyJSON(proposal.local) ||
        !data.canonical ||
        !current()
      )
        throw new Error('f06_mixed_transfer_unproven');
      return data;
    };
    if (proposal.canonical === null) {
      const observed = await invoke();
      if (observed.receipt !== null) throw new Error('f06_mixed_capture_protocol_changed');
      proposal.canonical = immutableCustody(observed.canonical);
    }
    const committed = await invoke();
    const receipt = committed.receipt;
    if (
      !receipt ||
      receipt.transfer_id !== proposal.transferId ||
      receipt.tournament_id !== tournamentId ||
      receipt.origin_generation !== originGeneration ||
      receipt.successor_generation !== proposal.successorGeneration ||
      custodyJSON(receipt.local_proof) !== custodyJSON(proposal.local) ||
      custodyJSON(receipt.canonical_proof) !== custodyJSON(proposal.canonical) ||
      typeof receipt.created_at !== 'string' ||
      !Number.isFinite(Date.parse(receipt.created_at)) ||
      custodyJSON(committed.canonical) !== custodyJSON(proposal.canonical)
    )
      throw new Error('f06_mixed_transfer_receipt_unproven');
    return Object.freeze({
      transferId: proposal.transferId,
      successorGeneration: proposal.successorGeneration,
      local: proposal.local,
      canonical: proposal.canonical,
      receipt: immutableCustody(committed.receipt),
    });
  }
);

/** New authority owns custody only. No hand/move submission is made here. */
export const admitMixedF06Transfer = bindToProcessRoot(
  async (tournamentId: string, leaseGeneration: string, transfer: MixedF06Transfer) => {
    if (leaseGeneration !== transfer.successorGeneration)
      throw new Error('f06_mixed_successor_generation_changed');
    const { data, error } = await runWithTournamentDataAuthority(
      { tournamentId, leaseGeneration },
      () =>
        supabase.rpc('fn_f06_admit_mixed_manager_custody', {
          p_tournament_id: tournamentId,
          p_lease_generation: leaseGeneration,
          p_transfer_id: transfer.transferId,
          p_expected: transfer.receipt,
        })
    );
    if (
      error ||
      !data ||
      data.ok !== true ||
      data.transfer_id !== transfer.transferId ||
      data.tournament_id !== tournamentId ||
      data.lease_generation !== leaseGeneration ||
      data.custody_only !== true ||
      custodyJSON(data.receipt) !== custodyJSON(transfer.receipt) ||
      !data.admission ||
      data.admission.transfer_id !== transfer.transferId ||
      data.admission.generation !== leaseGeneration ||
      !Array.isArray(data.admission.terminal_proof) ||
      data.admission.terminal_proof.some((item: { evidence?: unknown }) => !item.evidence)
    )
      throw new Error('f06_mixed_successor_custody_unproven');
    const originals = (transfer.local.engines as { permit: { binding: unknown } | null }[])
      .filter((engine) => engine.permit !== null)
      .map((engine) => engine.permit!.binding);
    const proven = data.admission.terminal_proof as { binding: unknown; evidence: unknown }[];
    if (
      proven.length !== originals.length ||
      originals.some(
        (binding) =>
          proven.filter(
            (item) => custodyJSON(item.binding) === custodyJSON(binding) && item.evidence
          ).length !== 1
      )
    )
      throw new Error('f06_mixed_terminal_original_coverage_changed');
    return { recoveryRequired: true, terminalProof: immutableCustody(data.admission) };
  }
);

/** Read the immutable selected successor before any ordinary lease claim. */
export const findMixedF06Transfer = bindToProcessRoot(
  async (tournamentId: string): Promise<MixedF06Transfer | null> => {
    const { data, error } = await supabase.rpc('fn_f06_find_mixed_manager_custody', {
      p_tournament_id: tournamentId,
    });
    if (
      error ||
      !data ||
      data.ok !== true ||
      data.tournament_id !== tournamentId ||
      !('receipt' in data)
    )
      throw new Error('f06_mixed_transfer_discovery_unproven');
    if (data.receipt === null) return null;
    const r = data.receipt;
    if (
      r.tournament_id !== tournamentId ||
      !uuid.test(r.transfer_id) ||
      !uuid.test(r.origin_generation) ||
      !uuid.test(r.successor_generation) ||
      r.origin_generation === r.successor_generation ||
      !r.local_proof ||
      !r.canonical_proof ||
      !Array.isArray(r.canonical_proof.pending_original_tables) ||
      r.canonical_proof.pending_original_tables.some(
        (id: unknown) => typeof id !== 'string' || !uuid.test(id)
      ) ||
      typeof r.created_at !== 'string' ||
      !Number.isFinite(Date.parse(r.created_at))
    )
      throw new Error('f06_mixed_transfer_discovery_unproven');
    return Object.freeze({
      transferId: r.transfer_id,
      successorGeneration: r.successor_generation,
      local: immutableCustody(r.local_proof),
      canonical: immutableCustody(r.canonical_proof),
      receipt: immutableCustody(r),
    });
  }
);

export function mixedF06PendingOriginals(transfer: MixedF06Transfer): readonly string[] {
  const canonical = transfer.canonical as { pending_original_tables?: unknown };
  if (
    !Array.isArray(canonical.pending_original_tables) ||
    canonical.pending_original_tables.some((id: unknown) => typeof id !== 'string')
  )
    throw new Error('f06_mixed_original_coverage_unavailable');
  return canonical.pending_original_tables as string[];
}

/** Each intent is durable before the corresponding first business submission. */
export async function retainMixedF06Intent(
  tournamentId: string,
  generation: string,
  transfer: MixedF06Transfer,
  key: string,
  payload: unknown,
  current: () => void
): Promise<void> {
  current();
  const { data, error } = await supabase.rpc('fn_f06_mixed_custody_intent', {
    p_tournament_id: tournamentId,
    p_lease_generation: generation,
    p_transfer_id: transfer.transferId,
    p_key: key,
    p_payload: payload,
  });
  current();
  if (
    error ||
    data?.ok !== true ||
    data.transfer_id !== transfer.transferId ||
    data.key !== key ||
    custodyJSON(data.payload) !== custodyJSON(payload)
  )
    throw new Error('f06_mixed_intent_unproven');
}

export async function completeMixedF06Transfer(
  tournamentId: string,
  generation: string,
  transfer: MixedF06Transfer,
  current: () => void
): Promise<Readonly<Record<string, unknown>>> {
  current();
  const { data, error } = await supabase.rpc('fn_f06_complete_mixed_manager_custody', {
    p_tournament_id: tournamentId,
    p_lease_generation: generation,
    p_transfer_id: transfer.transferId,
    p_expected: transfer.receipt,
  });
  current();
  if (
    error ||
    data?.ok !== true ||
    data.transfer_id !== transfer.transferId ||
    data.tournament_id !== tournamentId ||
    data.lease_generation !== generation ||
    data.completion?.transfer_id !== transfer.transferId ||
    data.completion?.generation !== generation ||
    !Array.isArray(data.completion?.operation_receipts)
  )
    throw new Error('f06_mixed_completion_unproven');
  return immutableCustody(data.completion);
}
