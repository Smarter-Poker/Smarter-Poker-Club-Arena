import { useCallback, useEffect, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { SpadeConsole } from '../console/SpadeConsole';
import { reportError } from '../../utils/errorReporter';

interface Agreement {
  ok: true;
  is_owner: boolean;
  accepted: boolean;
  accepted_at: string | null;
  terms: string;
  terms_version: string;
}
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
      if (
        typeof value.accepted !== 'boolean' ||
        typeof value.is_owner !== 'boolean' ||
        typeof value.terms !== 'string' ||
        value.terms_version !== 'diamond-spins-2026-09-14-v1' ||
        (value.accepted &&
          (typeof value.accepted_at !== 'string' ||
            !Number.isFinite(Date.parse(value.accepted_at))))
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
  async function accept() {
    if (!checked || busy || !agreement?.is_owner || agreement.accepted) return;
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
      pill={agreement?.accepted ? 'Accepted' : 'Required'}
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
          label: busy ? 'Saving' : 'Accept Agreement',
          onClick: () => void accept(),
          disabled: busy || !checked || !agreement?.is_owner || agreement.accepted,
        },
      }}
    >
      {agreement ? (
        <p className="sc-copy">{agreement.terms}</p>
      ) : (
        <p className="sc-copy">Loading The Host Wallet Agreement.</p>
      )}
      {agreement?.accepted ? (
        <p className="sc-copy">
          Accepted By The Wallet Owner On {new Date(agreement.accepted_at!).toLocaleString()}.
        </p>
      ) : agreement?.is_owner ? (
        <label className="sc-copy">
          <input
            type="checkbox"
            checked={checked}
            disabled={busy}
            onChange={(e) => setChecked(e.target.checked)}
          />{' '}
          I Have Read And Agree To These Wallet Obligations.
        </label>
      ) : agreement ? (
        <p className="sc-copy">
          The Union Owner, Or Club Owner For A Standalone Club, Must Accept Before The Bonus Games
          Open.
        </p>
      ) : null}
      {error ? (
        <p className="sc-copy sc-ink--red" role="alert">
          {error}
        </p>
      ) : null}
    </SpadeConsole>
  );
}
