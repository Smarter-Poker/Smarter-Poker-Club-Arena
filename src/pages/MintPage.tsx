/**
 * THE MINT
 *
 * The only place chips and diamonds are created.
 *
 * Every other way chips have appeared on this platform - provisioning scripts,
 * direct balance writes, restores - could only be reported after the fact as
 * "unexplained supply" or "unclassified flow", because creation had no front
 * door and so could not be told apart from a leak.
 *
 * This page is that front door. It calls fn_ca_mint, which declares
 * issuance_reserve as the counterparty before it writes, so the movement lands
 * in chip_ledger as issuance_reserve -> the destination wallet and the supply
 * watcher counts it as ledgered issuance in the same interval the balance
 * moves. Supply reconciles by construction. Nothing to explain later.
 *
 * Authorisation is the database's job, not this page's: fn_ca_mint refuses
 * anyone who is not an admin or god. The page only reports what it says.
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './MintPage.module.css';
import { supabase } from '@/lib/supabase';
import { useAuthUser } from '@/hooks/useAuthUser';
import { useToast } from '@/components/common/Toast';

type Asset = 'chips' | 'diamonds';
type Destination = 'player' | 'club' | 'agent' | 'union';

interface TargetOption {
  id: string;
  label: string;
  sub?: string;
}

interface MintResult {
  ok: boolean;
  reason?: string;
  replayed?: boolean;
  asset?: string;
  destination?: string;
  amount?: number;
  balance_before?: number;
  balance_after?: number;
}

interface RecentMint {
  id: string;
  at: string;
  what: string;
  amount: number;
  detail: string;
}

const DESTINATION_LABEL: Record<Destination, string> = {
  player: 'Player Wallet',
  club: 'Club Treasury',
  agent: 'Agent Wallet',
  union: 'Union Bank',
};

function money(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '0.00';
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function MintPage() {
  const { user } = useAuthUser();
  const toast = useToast();

  const [asset, setAsset] = useState<Asset>('chips');
  const [destination, setDestination] = useState<Destination>('club');

  const [targetQuery, setTargetQuery] = useState('');
  const [targetOptions, setTargetOptions] = useState<TargetOption[]>([]);
  const [target, setTarget] = useState<TargetOption | null>(null);

  const [clubQuery, setClubQuery] = useState('');
  const [clubOptions, setClubOptions] = useState<TargetOption[]>([]);
  const [club, setClub] = useState<TargetOption | null>(null);

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MintResult | null>(null);
  const [recent, setRecent] = useState<RecentMint[]>([]);

  // Diamonds only ever belong to a player.
  useEffect(() => {
    if (asset === 'diamonds' && destination !== 'player') {
      setDestination('player');
      setTarget(null);
      setTargetOptions([]);
    }
  }, [asset, destination]);

  const needsClub = asset === 'chips' && (destination === 'player' || destination === 'agent');

  const searchTargets = useCallback(
    async (q: string) => {
      const term = q.trim();
      if (term.length < 2) {
        setTargetOptions([]);
        return;
      }
      try {
        if (destination === 'club') {
          const { data } = await supabase
            .from('clubs')
            .select('id, name, club_id')
            .ilike('name', `%${term}%`)
            .limit(8);
          setTargetOptions(
            (data ?? []).map((c: { id: string; name: string; club_id: number }) => ({
              id: c.id,
              label: c.name ?? 'Unnamed Club',
              sub: `Club ${c.club_id}`,
            }))
          );
          return;
        }
        if (destination === 'union') {
          const { data } = await supabase
            .from('unions')
            .select('id, name')
            .ilike('name', `%${term}%`)
            .limit(8);
          setTargetOptions(
            (data ?? []).map((u: { id: string; name: string }) => ({
              id: u.id,
              label: u.name ?? 'Unnamed Union',
            }))
          );
          return;
        }
        const { data } = await supabase
          .from('profiles')
          .select('id, username, display_name')
          .ilike('username', `%${term}%`)
          .limit(8);
        setTargetOptions(
          (data ?? []).map((p: { id: string; username: string; display_name: string }) => ({
            id: p.id,
            label: p.username ?? 'Unnamed Player',
            sub: p.display_name ?? undefined,
          }))
        );
      } catch {
        setTargetOptions([]);
      }
    },
    [destination]
  );

  const searchClubs = useCallback(async (q: string) => {
    const term = q.trim();
    if (term.length < 2) {
      setClubOptions([]);
      return;
    }
    try {
      const { data } = await supabase
        .from('clubs')
        .select('id, name, club_id')
        .ilike('name', `%${term}%`)
        .limit(8);
      setClubOptions(
        (data ?? []).map((c: { id: string; name: string; club_id: number }) => ({
          id: c.id,
          label: c.name ?? 'Unnamed Club',
          sub: `Club ${c.club_id}`,
        }))
      );
    } catch {
      setClubOptions([]);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const { data: chips } = await supabase
        .from('chip_ledger')
        .select('id, created_at, amount, to_type, description')
        .eq('from_type', 'issuance_reserve')
        .eq('category', 'mint')
        .order('created_at', { ascending: false })
        .limit(10);

      const { data: gems } = await supabase
        .from('diamond_transactions')
        .select('id, created_at, amount, description')
        .eq('source', 'the_mint')
        .order('created_at', { ascending: false })
        .limit(10);

      const rows: RecentMint[] = [
        ...(chips ?? []).map(
          (r: {
            id: string;
            created_at: string;
            amount: number;
            to_type: string;
            description: string;
          }) => ({
            id: r.id,
            at: r.created_at,
            what: 'Chips',
            amount: Number(r.amount),
            detail: r.to_type ?? '',
          })
        ),
        ...(gems ?? []).map(
          (r: { id: string; created_at: string; amount: number; description: string }) => ({
            id: r.id,
            at: r.created_at,
            what: 'Diamonds',
            amount: Number(r.amount),
            detail: r.description ?? '',
          })
        ),
      ]
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, 12);

      setRecent(rows);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const reasonTooShort = reason.trim().length > 0 && reason.trim().length < 10;
  const canMint =
    !busy && !!target && (!needsClub || !!club) && Number(amount) > 0 && reason.trim().length >= 10;

  async function handleMint() {
    if (!canMint || !target) return;
    setBusy(true);
    setResult(null);
    try {
      const { data, error } = await supabase.rpc('fn_ca_mint', {
        p_asset: asset,
        p_destination: destination,
        p_target_id: target.id,
        p_amount: Number(Number(amount).toFixed(2)),
        p_reason: reason.trim(),
        p_op_id:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `mint-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        p_club_id: needsClub && club ? club.id : null,
      });

      if (error) {
        toast.error('The Mint Could Not Complete That');
        setResult({ ok: false, reason: error.message });
        return;
      }

      const res = (data ?? {}) as MintResult;
      setResult(res);

      if (res.ok) {
        toast.success(res.replayed ? 'Already Minted With That Key' : 'Minted And Recorded');
        setAmount('');
        setReason('');
        void loadRecent();
      } else {
        toast.error('The Mint Refused That Request');
      }
    } catch (err) {
      toast.error('The Mint Could Not Complete That');
      setResult({ ok: false, reason: err instanceof Error ? err.message : 'Unknown Error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>The Mint</h1>
        <p className={styles.blurb}>
          The only place chips and diamonds are created. Every mint is journalled against the
          issuance reserve as it happens, so it never turns up later as drift.
        </p>
      </header>

      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.label}>Asset</span>
          <div className={styles.segmented}>
            {(['chips', 'diamonds'] as Asset[]).map((a) => (
              <button
                key={a}
                type="button"
                className={asset === a ? styles.segOn : styles.seg}
                onClick={() => {
                  setAsset(a);
                  setTarget(null);
                  setTargetOptions([]);
                }}
              >
                {a === 'chips' ? 'Chips' : 'Diamonds'}
              </button>
            ))}
          </div>
        </div>

        {asset === 'chips' && (
          <div className={styles.fieldRow}>
            <span className={styles.label}>Send To</span>
            <div className={styles.segmented}>
              {(['player', 'club', 'agent', 'union'] as Destination[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={destination === d ? styles.segOn : styles.seg}
                  onClick={() => {
                    setDestination(d);
                    setTarget(null);
                    setTargetOptions([]);
                    setTargetQuery('');
                  }}
                >
                  {DESTINATION_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={styles.fieldRow}>
          <span className={styles.label}>
            {destination === 'club' ? 'Club' : destination === 'union' ? 'Union' : 'Player'}
          </span>
          {target ? (
            <div className={styles.chosen}>
              <span className={styles.chosenName}>{target.label}</span>
              {target.sub && <span className={styles.chosenSub}>{target.sub}</span>}
              <button type="button" className={styles.clear} onClick={() => setTarget(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                className={styles.input}
                value={targetQuery}
                placeholder="Type At Least Two Characters"
                onChange={(e) => {
                  setTargetQuery(e.target.value);
                  void searchTargets(e.target.value);
                }}
              />
              {targetOptions.length > 0 && (
                <ul className={styles.options}>
                  {targetOptions.map((o) => (
                    <li key={o.id}>
                      <button type="button" className={styles.option} onClick={() => setTarget(o)}>
                        <span className={styles.optName}>{o.label}</span>
                        {o.sub && <span className={styles.optSub}>{o.sub}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {needsClub && (
          <div className={styles.fieldRow}>
            <span className={styles.label}>Which Club Wallet</span>
            {club ? (
              <div className={styles.chosen}>
                <span className={styles.chosenName}>{club.label}</span>
                {club.sub && <span className={styles.chosenSub}>{club.sub}</span>}
                <button type="button" className={styles.clear} onClick={() => setClub(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  className={styles.input}
                  value={clubQuery}
                  placeholder="Search Clubs"
                  onChange={(e) => {
                    setClubQuery(e.target.value);
                    void searchClubs(e.target.value);
                  }}
                />
                {clubOptions.length > 0 && (
                  <ul className={styles.options}>
                    {clubOptions.map((o) => (
                      <li key={o.id}>
                        <button type="button" className={styles.option} onClick={() => setClub(o)}>
                          <span className={styles.optName}>{o.label}</span>
                          {o.sub && <span className={styles.optSub}>{o.sub}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <div className={styles.fieldRow}>
          <span className={styles.label}>Amount</span>
          <input
            className={styles.input}
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.label}>Reason</span>
          <input
            className={styles.input}
            value={reason}
            placeholder="Why These Are Being Created"
            onChange={(e) => setReason(e.target.value)}
          />
          {reasonTooShort && (
            <span className={styles.hint}>A reason of at least ten characters is required.</span>
          )}
        </div>

        <button type="button" className={styles.mintBtn} disabled={!canMint} onClick={handleMint}>
          {busy ? 'Minting' : `Mint ${asset === 'chips' ? 'Chips' : 'Diamonds'}`}
        </button>

        {result && (
          <div className={result.ok ? styles.resultOk : styles.resultBad}>
            {result.ok ? (
              <>
                <strong>
                  {result.replayed ? 'Already Minted With That Key' : 'Minted And Recorded'}
                </strong>
                <span>
                  {money(result.amount)} {result.asset === 'diamonds' ? 'diamonds' : 'chips'} into{' '}
                  {DESTINATION_LABEL[(result.destination as Destination) ?? 'club']}
                </span>
                <span>
                  Balance {money(result.balance_before)} to {money(result.balance_after)}
                </span>
              </>
            ) : (
              <>
                <strong>Refused.</strong>
                <span>{result.reason}</span>
              </>
            )}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.subTitle}>Recently Minted</h2>
        {recent.length === 0 ? (
          <p className={styles.empty}>Nothing has been minted yet.</p>
        ) : (
          <ul className={styles.recent}>
            {recent.map((r) => (
              <li key={r.id} className={styles.recentRow}>
                <span className={styles.recentWhat}>{r.what}</span>
                <span className={styles.recentAmount}>{money(r.amount)}</span>
                <span className={styles.recentDetail}>{r.detail}</span>
                <span className={styles.recentAt}>{new Date(r.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!user && <p className={styles.empty}>Sign in as an administrator to use The Mint.</p>}
    </div>
  );
}
