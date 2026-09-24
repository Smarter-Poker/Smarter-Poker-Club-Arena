/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP MINT — diamonds -> chips (Dan 2026-08-21, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "UNIONS ARE WHERE ALL THE CHIPS FLOW FROM. EVERY UNION SHOULD HAVE ITS OWN
 *  MINT - CONVERT DIAMONDS INTO CHIPS, 100 DIAMONDS EQUALS 10,000 CHIPS.
 *  CREATE A CHIP MINT INSIDE OF ALL UNION WALLETS, AND ALL STANDALONE CLUBS.
 *  IF A CLUB EVER JOINS THE UNION, THEIR CHIP MINT GETS TURNED OFF AND
 *  REVOKED."
 *
 * The modal is a thin skin over fn_mint_chips_from_diamonds (migration
 * 20260821), which owns ALL of the law server-side:
 *   - rate locked at 1 diamond = 100 chips;
 *   - diamonds burned through the whitelisted deduct_diamonds();
 *   - standalone club  -> owner/co_owner/admin mints into the CLUB BANK
 *     (clubs.chip_treasury, migration 20260823170000);
 *   - club in a union  -> mint REVOKED unless the caller owns/administers the
 *     union, in which case chips land in union_wallets.chip_balance.
 *
 * Dan 2026-08-23: the only entry point is inside the Club Bank Cashier. It
 * used to be a "+" on the wallet panel, which put a money-creation control one
 * tap from a balance on every owner's lobby, and offered it on union clubs
 * where the server could only ever refuse it. Minting is a Club Bank action.
 *
 * The standalone mint credits clubs.chip_treasury, NOT clubs.chip_pool. Those
 * were two different accounts and the panel only ever showed the first, so
 * "mint inside your Club Bank" would have moved a figure nobody could see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONSOLE (#ClubArenaConsole). This was a rounded dark card with a border
 * and a shadow, a boxed balance strip, a bordered destination panel, a filled
 * input well, five rounded quick-amount pills, a boxed preview and two rounded
 * action lozenges.
 *
 * It is now Dan's approved spade master: CHIP MINT is engraved in the header
 * well with the rate as its subtitle, every figure prints as a ROW on the
 * black glass (label in the master's lit blue, figure in engraved silver), the
 * amount is a GROOVE cut in the glass, the five quick amounts are lit words,
 * and CANCEL / MINT CHIPS are the two plates painted into the foot. When the
 * server has already said this club may not mint there is only one thing to
 * do, so the foot becomes the flat closing cap and CLOSE is a lit word - the
 * foot never paints a plate with nothing on it.
 *
 * NOT ONE MONEY PATH MOVED. The busyRef double-tap guard, the per-amount
 * idempotency key held across a failure, the Escape guard, the body-scroll
 * lock, the destination pre-flight, the unmount guard and every figure's exact
 * `fmt` formatting are all exactly as they were. Nothing here abbreviates: the
 * diamonds burned and the chips created are the amounts about to move.
 */

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { uuid } from '../../utils/uuid';
import { compactChips } from '../../utils/format';
import { SpadeConsole } from '../console/SpadeConsole';
import './ChipMintModal.css';

const CHIPS_PER_DIAMOND = 100; // 100 diamonds = 10,000 chips

interface ChipMintModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The club whose money surface opened the mint. The RPC routes union
   *  clubs to the union bank and refuses non-union-owners there. */
  clubId: string;
  onMinted?: () => void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Where this mint will land, resolved before a single diamond is burned. */
type MintTarget =
  | { state: 'loading' }
  | { state: 'club'; clubUuid: string; label: string }
  | { state: 'union'; clubUuid: string; label: string }
  | { state: 'revoked'; label: string }
  | { state: 'denied'; label: string };

export default function ChipMintModal({ isOpen, onClose, clubId, onMinted }: ChipMintModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [diamonds, setDiamonds] = useState('');

  const [balance, setBalance] = useState<number | null>(null);
  // A diamond read that FAILED is not a balance of zero. The row prints
  // Unavailable and the presets stay disabled until a read succeeds.
  const [balanceFailed, setBalanceFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<MintTarget>({ state: 'loading' });
  /**
   * BEATS THE DOUBLE TAP THAT LANDS BEFORE `busy` RE-RENDERS.
   *
   * `if (!valid || busy) return` reads STATE, and React has not necessarily
   * re-rendered between the first tap and a second one 80ms later. This
   * function burns diamonds and creates chips. The ref flips synchronously
   * inside the handler, which is the only guard that can close the two-taps-
   * in-one-frame window from the client.
   */
  const busyRef = useRef(false);

  /**
   * The OTHER window is a response lost on the way back: the mint ran, the
   * client never heard, and the natural retry burns the diamonds again. A ref
   * guard cannot see that one - only a key the server recognises can.
   *
   * fn_mint_chips_from_diamonds now takes p_op_id (migration 20260826), takes
   * an advisory lock on it BEFORE deducting anything, and returns the original
   * result with replayed:true if it has seen the key. Proved against
   * production inside a rolled-back transaction: two calls with one key burned
   * 1 diamond and created 100 chips, with one ledger row.
   *
   * Held across a FAILURE - that is the whole point - and cleared only once a
   * mint actually succeeds or the amount changes, because either of those
   * makes the next press a different operation.
   */
  const opIdRef = useRef<string | null>(null);

  /**
   * Editing the amount makes the next press a different operation. Reusing
   * the key would make the server replay the ORIGINAL amount and report
   * success for a mint the user did not ask for.
   */
  const setDiamondsAndResetKey = (v: string) => {
    opIdRef.current = null;
    setDiamonds(v);
  };

  /** Same unmount guard the cashier uses: setState after await, never blind. */
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  /**
   * Escape closes and the page behind stops scrolling. Both are what a person
   * expects of a modal, WalletCashierModal (which is what stacks this one) has
   * had them since 2026-08-23, and neither was here - so on iOS the lobby
   * scrolled underneath the mint and a keyboard user had no way out but Cancel.
   * Guarded on busyRef so Escape can never abandon an in-flight mint.
   */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    let live = true;
    setDiamonds('');
    setBalanceFailed(false);
    setTarget({ state: 'loading' });

    (async () => {
      // Diamond balance.
      const { data: prof, error: profError } = await supabase
        .from('profiles')
        .select('diamonds')
        .eq('id', user.id)
        .maybeSingle();
      if (profError) {
        reportError(profError, 'ChipMintModal');
        if (live) {
          setBalance(null);
          setBalanceFailed(true);
        }
      } else if (live) {
        setBalance(Number(prof?.diamonds) || 0);
      }

      // ── Destination pre-flight ──
      // AUDIT 2026-08-21: the caller may hand us a 6-digit club CODE
      // (ClubHomePage passes `resolvedClubId || clubId`), but the RPC takes a
      // uuid — an unresolved code failed only AFTER the user hit Mint, with a
      // raw postgres error. Resolve here, and while we are at it work out
      // whether this mint is even permitted so the panel can say where the
      // chips land (club pool vs union bank) or that the mint is revoked.
      const uuidResolved = (await resolveClubUUID(clubId)) || clubId;
      const { data: club } = await supabase
        .from('clubs')
        .select('id, name, union_id, owner_id')
        .eq('id', uuidResolved)
        .maybeSingle();
      if (!live) return;
      if (!club) {
        setTarget({ state: 'denied', label: 'Club Not Found' });
        return;
      }

      if (club.union_id) {
        const [{ data: union }, { data: ua }] = await Promise.all([
          supabase.from('unions').select('name, owner_id').eq('id', club.union_id).maybeSingle(),
          supabase
            .from('union_admins')
            .select('user_id')
            .eq('union_id', club.union_id)
            .eq('user_id', user.id)
            .maybeSingle(),
        ]);
        if (!live) return;
        const mayMint = union?.owner_id === user.id || Boolean(ua);
        setTarget(
          mayMint
            ? { state: 'union', clubUuid: uuidResolved, label: `${union?.name || 'Union'} Bank` }
            : { state: 'revoked', label: union?.name || 'This Union' }
        );
        return;
      }

      // Standalone club — owner / co_owner / admin only.
      const { data: mem } = await supabase
        .from('club_members')
        .select('role')
        .eq('club_id', uuidResolved)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!live) return;
      const role = (mem?.role as string) || '';
      const mayMint = club.owner_id === user.id || ['owner', 'co_owner', 'admin'].includes(role);
      setTarget(
        mayMint
          ? { state: 'club', clubUuid: uuidResolved, label: `${club.name || 'Club'} Bank` }
          : { state: 'denied', label: 'Only A Club Owner Or Admin May Mint' }
      );
    })();

    return () => {
      live = false;
    };
  }, [isOpen, user?.id, clubId]);

  if (!isOpen) return null;

  const d = Math.floor(Number(diamonds) || 0);
  const chips = d * CHIPS_PER_DIAMOND;
  const canMintHere = target.state === 'club' || target.state === 'union';
  const overBalance = balance !== null && d > balance;
  // AUDIT: validity used to pass while `balance` was still null (loading), so
  // a fast tap could submit an amount the player does not hold.
  const valid = d > 0 && balance !== null && !overBalance && canMintHere;

  const mint = async () => {
    if (!valid || busy || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (!opIdRef.current) opIdRef.current = uuid();
      const { data, error } = await supabase.rpc('fn_mint_chips_from_diamonds', {
        // Resolved uuid from the pre-flight, never the raw route param.
        p_club_id: canMintHere ? (target as { clubUuid: string }).clubUuid : clubId,
        p_diamonds: d,
        p_op_id: opIdRef.current,
      });
      if (error) throw error;
      const res = data as {
        success?: boolean;
        error?: string;
        scope?: string;
        chips?: number;
        diamonds_after?: number;
      } | null;
      if (!res?.success) throw new Error(res?.error || 'Mint Refused');
      // Landed. The next press is a new mint, so it needs a new key.
      opIdRef.current = null;
      if (isMounted.current) setBalance(Number(res.diamonds_after) || 0);
      toast?.success?.(
        `Minted ${fmt(Number(res.chips) || chips)} Chips Into The ${
          res.scope === 'union' ? 'Union Bank' : 'Club Bank'
        }`
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'chip_mint', userId: user?.id || '' });
      onMinted?.();
      onClose();
    } catch (e) {
      reportError(e, 'ChipMintModal.mint');
      toast?.error?.((e as Error).message || 'Mint Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setBusy(false);
    }
  };

  return (
    <div
      className="cmm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Chip Mint"
      onClick={() => !busy && onClose()}
    >
      <div className="cmm-panel" onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          onClose={onClose}
          as="div"
          eyebrow="Club Bank"
          title="Chip Mint"
          subtitle={`100 Diamonds = ${compactChips(100 * CHIPS_PER_DIAMOND)} Chips`}
          // The pill slot is painted in the master: never leave it unlabelled.
          pill={
            target.state === 'loading'
              ? 'Checking'
              : busy
                ? 'Minting'
                : !canMintHere
                  ? 'Refused'
                  : balanceFailed || overBalance
                    ? 'Attention'
                    : 'Ready'
          }
          pillInk={
            target.state === 'loading' || busy
              ? 'gold'
              : !canMintHere || balanceFailed || overBalance
                ? 'red'
                : 'green'
          }
          {...(canMintHere
            ? {
                plates: {
                  secondary: {
                    label: 'Cancel',
                    onClick: onClose,
                    disabled: busy,
                    'aria-label': 'Cancel Chip Mint',
                  },
                  /* The blue glass carries the one thing this sheet exists to
                     do, and it is the only control that burns a diamond. */
                  primary: {
                    label: busy ? 'Minting...' : 'Mint Chips',
                    ink: 'white' as const,
                    onClick: mint,
                    disabled: !valid || busy,
                  },
                },
              }
            : { foot: 'foot' as const })}
        >
          <div className="cmm-rows">
            <div className="cmm-row">
              <span className="cmm-label sc-label sc-ink--blue">Your Diamonds</span>
              <span className="cmm-value sc-ink--silver">
                {balance === null ? (balanceFailed ? 'Unavailable' : '...') : fmt(balance)}
              </span>
            </div>

            {/* Where the chips land — resolved before anything is spent. */}
            {target.state === 'loading' && (
              <div className="cmm-row">
                <span className="cmm-label sc-label sc-ink--blue">Destination</span>
                <span className="cmm-value sc-ink--muted">Checking Mint Rights...</span>
              </div>
            )}
            {target.state === 'club' && (
              <div className="cmm-row">
                <span className="cmm-label sc-label sc-ink--blue">Minting Into</span>
                <span className="cmm-value sc-ink--silver">{target.label}</span>
              </div>
            )}
            {target.state === 'union' && (
              <div className="cmm-row">
                <span className="cmm-label sc-label sc-ink--blue">Minting Into</span>
                <span className="cmm-value sc-ink--gold">{target.label}</span>
              </div>
            )}
            {target.state === 'revoked' && (
              <div className="cmm-blocked sc-ink--red" role="alert">
                Chip Mint Is Revoked For Clubs Inside {target.label}. Chips Flow From The Union -
                Mint From The Union Instead.
              </div>
            )}
            {target.state === 'denied' && (
              <div className="cmm-blocked sc-ink--red" role="alert">
                {target.label}
              </div>
            )}
          </div>

          {canMintHere && (
            <>
              {/* The amount: a groove cut in the glass, no well and no rim. */}
              <input
                className="cmm-input"
                type="number"
                inputMode="numeric"
                min={1}
                step={100}
                value={diamonds}
                onChange={(e) => setDiamondsAndResetKey(e.target.value)}
                placeholder="Diamonds To Convert"
                aria-label="Diamonds To Convert"
                autoFocus
              />

              <div className="cmm-quick">
                {[100, 500, 1000, 10000].map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="cmm-quick-word"
                    disabled={balance === null || q > balance}
                    onClick={() => setDiamondsAndResetKey(String(q))}
                  >
                    {fmt(q)}
                  </button>
                ))}
                <button
                  type="button"
                  className="cmm-quick-word cmm-max"
                  disabled={!balance}
                  onClick={() => setDiamondsAndResetKey(String(balance ?? 0))}
                >
                  Max
                </button>
              </div>

              <div className="cmm-rows">
                <div className={`cmm-row ${valid ? '' : 'cmm-row-dim'}`}>
                  <span className="cmm-label sc-label sc-ink--blue">You Receive</span>
                  <span className="cmm-value sc-ink--green">{fmt(chips)} Chips</span>
                </div>

                {overBalance && (
                  <div className="cmm-blocked sc-ink--red" role="alert">
                    You Only Hold {fmt(balance ?? 0)} Diamonds.
                  </div>
                )}
              </div>
            </>
          )}

          {/* The refusal states have one thing to do, so the foot stays the
              flat cap and the action is a lit word on the glass. */}
          {!canMintHere && (
            <div className="cmm-close">
              <button type="button" className="cmm-close-word" disabled={busy} onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}
