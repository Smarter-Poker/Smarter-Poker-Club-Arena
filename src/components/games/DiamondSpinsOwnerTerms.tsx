import { useCallback, useEffect, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { SpadeConsole } from '../console/SpadeConsole';
import { reportError } from '../../utils/errorReporter';

/** The base agreement that gates play, unchanged since 2026-09-14. */
export const DIAMOND_SPINS_TERMS_VERSION = 'diamond-spins-2026-09-14-v1';
/** The daily settlement and profit burn addendum (owner ruling 2026-09-21, R14). */
export const DIAMOND_SPINS_ADDENDUM_VERSION = 'diamond-spins-2026-09-21-v2';

interface Addendum {
  version: string;
  text: string;
  accepted: boolean;
  accepted_at: string | null;
  profit_burn_bps: number;
}
interface Agreement {
  ok: true;
  is_owner: boolean;
  accepted: boolean;
  accepted_at: string | null;
  terms: string;
  terms_version: string;
  addendum: Addendum;
  acknowledged: boolean;
}
const acceptedAt = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const percent = (bps: number) => `${(bps / 100).toLocaleString()}%`;
export default function DiamondSpinsOwnerTerms({
  clubId,
  onAccepted,
}: {
  clubId: string | null;
  onAccepted?: () => void;
}) {
  const { user } = useAuthUser();
  return (
    <OwnerTerms key={`${user?.id ?? ''}:${clubId ?? ''}`} clubId={clubId} onAccepted={onAccepted} />
  );
}
function OwnerTerms({ clubId, onAccepted }: { clubId: string | null; onAccepted?: () => void }) {
  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const request = useCallback(
    async (agree: boolean) => {
      const { data, error: rpcError } = await supabase.rpc(
        'fn_diamond_spins_owner_terms' as never,
        { p_club_id: clubId, p_agree: agree } as never
      );
      if (rpcError) throw rpcError;
      const value = data as unknown as Agreement & { error?: string };
      if (!value || value.ok !== true)
        throw new Error(value?.error ?? 'The Agreement Could Not Be Loaded');
      const addendum = value.addendum;
      if (
        typeof value.accepted !== 'boolean' ||
        typeof value.is_owner !== 'boolean' ||
        typeof value.terms !== 'string' ||
        value.terms_version !== DIAMOND_SPINS_TERMS_VERSION ||
        (value.accepted && !acceptedAt(value.accepted_at)) ||
        !addendum ||
        addendum.version !== DIAMOND_SPINS_ADDENDUM_VERSION ||
        typeof addendum.text !== 'string' ||
        typeof addendum.accepted !== 'boolean' ||
        (addendum.accepted && !acceptedAt(addendum.accepted_at)) ||
        !Number.isSafeInteger(addendum.profit_burn_bps) ||
        addendum.profit_burn_bps < 0 ||
        addendum.profit_burn_bps > 10000 ||
        value.acknowledged !== (value.accepted && addendum.accepted)
      ) {
        throw new Error('The Agreement Could Not Be Verified');
      }
      return value;
    },
    [clubId]
  );
  useEffect(() => {
    if (!clubId) return;
    let cancelled = false;
    request(false)
      .then((value) => {
        if (!cancelled) setAgreement(value);
      })
      .catch((e) => {
        reportError(e, 'DiamondSpinsOwnerTerms.load');
        if (!cancelled) setError('The Agreement Could Not Be Loaded. Try Refresh.');
      });
    return () => {
      cancelled = true;
    };
  }, [clubId, reload, request]);
  // The base receipt opens the games; the addendum is a notice the owner
  // acknowledges. Both are permanent receipts, so nothing is re-accepted.
  const baseOpen = agreement?.accepted === true;
  const addendumOpen = agreement?.addendum.accepted === true;
  const pending = agreement ? !(baseOpen && addendumOpen) : false;
  const primaryLabel = busy ? 'Saving' : baseOpen ? 'Acknowledge Notice' : 'Accept Agreement';
  async function accept() {
    if (!checked || busy || !agreement?.is_owner || !pending) return;
    setBusy(true);
    setError(null);
    try {
      setAgreement(await request(true));
      onAccepted?.();
    } catch (e) {
      reportError(e, 'DiamondSpinsOwnerTerms.accept');
      setError('The Agreement Could Not Be Confirmed. Refresh To Check Before Trying Again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SpadeConsole
      title="Owner Agreement"
      eyebrow="Diamond Spins"
      pill={
        !agreement ? 'Required' : baseOpen ? (addendumOpen ? 'Accepted' : 'Notice') : 'Required'
      }
      plates={{
        secondary: {
          label: 'Refresh Agreement',
          onClick: () => {
            setError(null);
            setReload((n) => n + 1);
          },
          disabled: busy,
        },
        primary: {
          label: primaryLabel,
          onClick: () => void accept(),
          disabled: busy || !checked || !agreement?.is_owner || !pending,
        },
      }}
    >
      {agreement ? (
        <p className="sc-copy">{agreement.terms}</p>
      ) : (
        <p className="sc-copy">Loading The Host Wallet Agreement.</p>
      )}
      {agreement ? (
        <>
          <p className="sc-copy">
            <strong>
              Daily Profit Burn Notice ({percent(agreement.addendum.profit_burn_bps)})
            </strong>
          </p>
          <p className="sc-copy">{agreement.addendum.text}</p>
        </>
      ) : null}
      {agreement?.accepted ? (
        <p className="sc-copy">
          Accepted By The Wallet Owner On {new Date(agreement.accepted_at!).toLocaleString()}.
        </p>
      ) : null}
      {agreement?.addendum.accepted ? (
        <p className="sc-copy">
          Notice Acknowledged By The Wallet Owner On{' '}
          {new Date(agreement.addendum.accepted_at!).toLocaleString()}.
        </p>
      ) : null}
      {agreement && pending ? (
        agreement.is_owner ? (
          <label className="sc-copy">
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(e) => setChecked(e.target.checked)}
            />{' '}
            {baseOpen
              ? 'I Have Read The Daily Profit Burn Notice.'
              : 'I Have Read And Agree To These Wallet Obligations And The Daily Profit Burn Notice.'}
          </label>
        ) : (
          <p className="sc-copy">
            {baseOpen
              ? 'The Wallet Owner Acknowledges The Daily Profit Burn Notice. Play Stays Open Meanwhile.'
              : 'The Union Owner, Or Club Owner For A Standalone Club, Must Accept Before The Bonus Games Open.'}
          </p>
        )
      ) : null}
      {error ? (
        <p className="sc-copy sc-ink--red" role="alert">
          {error}
        </p>
      ) : null}
    </SpadeConsole>
  );
}
