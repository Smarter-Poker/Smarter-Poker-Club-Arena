import { F06HandPermit, type F06Rpc } from './F06HandPermit.js';
import type { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
import type { DecodedOriginalRoster } from './F06OriginalRosterTransport.js';
import type { SeatedPlayer } from '../types.js';
import type {
  captureMTTRosterBeforeReserve,
  MTTRosterObservation,
  MTTOriginalRosterAssociation,
} from '../engine/MTTPreReserveRoster.js';
import type { OriginalIntentIdentity } from './F06OriginalIntentSession.js';

// The exact existing admission signature is a contract of this adapter.
// Keep this foundation importable before the engine caller is composed.
export type OriginalRosterInstallation = [
  factory: (
    handNumber: string,
    roster?: ReturnType<typeof captureMTTRosterBeforeReserve>
  ) => F06HandPermit | Promise<F06HandPermit>,
  rosterBoundary?: {
    observe: (
      selected: readonly SeatedPlayer[],
      current: readonly SeatedPlayer[]
    ) => Promise<MTTRosterObservation>;
    saved: (permit: F06HandPermit) => {
      intent: OriginalIntentIdentity;
      association: MTTOriginalRosterAssociation;
    };
  },
];
type Installation = OriginalRosterInstallation;
export type OriginalRosterObservation = NonNullable<Installation[1]>['observe'];
/** Existing original Manager admission factory; observe is uninstalled until its
 * canonical read/profile is qualified. Saved evidence has no public setter. */
export function originalRosterAdmission(
  admitted: F06OriginalIntentSession,
  current: () => boolean,
  completionRpc: F06Rpc,
  observe?: OriginalRosterObservation
): Readonly<{ factory: Installation[0]; boundary: Installation[1] }> {
  const saved = new WeakMap<F06HandPermit, DecodedOriginalRoster>();
  const assertCurrent = () => {
    if (!current() || !admitted.canStart()) throw new Error('f06_roster_owner_changed');
  };
  const factory: Installation[0] = (handNumber, capture) => {
    assertCurrent();
    const intent = admitted.forHand(handNumber);
    if (!!capture !== !!observe) throw new Error('f06_roster_capture_boundary_mismatch');
    if (capture) admitted.bindOriginalRoster(capture.forOriginalIntent(intent));
    const permit = new F06HandPermit(
      {
        tournament_id: intent.tournament_id,
        lease_generation: intent.lease_generation,
        table_id: intent.table_id,
        lifecycle: intent.lifecycle,
        permit_id: intent.permit_id,
        hand_number: intent.hand_number,
        custody_id: intent.custody_id,
      },
      async (name, input) => {
        if (name !== 'fn_f06_begin_hand') return completionRpc(name, input);
        assertCurrent();
        const result = await admitted.begin(input);
        assertCurrent();
        if (capture) {
          // The existing permit alone classifies this explicit no-reservation reply.
          const row = result.data as Record<string, unknown> | null;
          if (!(row?.ok === false && row.reason === 'hand_number_already_used')) {
            if (!result.originalRoster) throw new Error('f06_saved_roster_missing');
            saved.set(permit, result.originalRoster);
          }
        }
        return result;
      },
      current,
      () => admitted.canStart()
    );
    return permit;
  };
  return Object.freeze({
    factory,
    boundary: observe
      ? {
          observe: async (selected, currentSeats) => {
            assertCurrent();
            const result = await observe(selected, currentSeats);
            assertCurrent();
            return result;
          },
          saved: (permit) => {
            assertCurrent();
            if (permit.recoveryState() !== 'reserved')
              throw new Error('f06_original_permit_not_reserved');
            const result = saved.get(permit);
            if (!result) throw new Error('f06_saved_roster_missing');
            const intent = admitted.forHand(permit.binding.hand_number);
            for (const key of Object.keys(result.association.intent) as (keyof typeof intent)[])
              if (result.association.intent[key] !== intent[key])
                throw new Error('f06_saved_roster_identity_changed');
            return { intent: result.association.intent, association: result.association };
          },
        }
      : undefined,
  });
}
