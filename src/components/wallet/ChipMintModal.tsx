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
 *   - standalone club  -> owner/admin mints into clubs.chip_pool;
 *   - club in a union  -> mint REVOKED unless the caller owns/administers the
 *     union, in which case chips land in union_wallets.chip_balance.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
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

export default function ChipMintModal({ isOpen, onClose, clubId, onMinted }: ChipMintModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [diamonds, setDiamonds] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    let live = true;
    setDiamonds('');
    supabase
      .from('profiles')
      .select('diamonds')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (live) setBalance(Number(data?.diamonds) || 0);
      });
    return () => {
      live = false;
    };
  }, [isOpen, user?.id]);

  if (!isOpen) return null;

  const d = Math.floor(Number(diamonds) || 0);
  const chips = d * CHIPS_PER_DIAMOND;
  const valid = d > 0 && (balance === null || d <= balance);

  const mint = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('fn_mint_chips_from_diamonds', {
        p_club_id: clubId,
        p_diamonds: d,
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
      setBalance(Number(res.diamonds_after) || 0);
      toast?.success?.(
        `Minted ${fmt(Number(res.chips) || chips)} Chips Into The ${
          res.scope === 'union' ? 'Union Bank' : 'Club Pool'
        }`
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'chip_mint', userId: user?.id || '' });
      onMinted?.();
      onClose();
    } catch (e) {
      reportError(e, 'ChipMintModal.mint');
      toast?.error?.((e as Error).message || 'Mint Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cmm-overlay" role="dialog" aria-label="Chip Mint" onClick={() => !busy && onClose()}>
      <div className="cmm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmm-title">CHIP MINT</div>
        <div className="cmm-rate">100 Diamonds = 10,000 Chips</div>

        <div className="cmm-balance">
          <span>Your Diamonds</span>
          <strong>{balance === null ? '...' : fmt(balance)}</strong>
        </div>

        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={100}
          value={diamonds}
          onChange={(e) => setDiamonds(e.target.value)}
          placeholder="Diamonds to convert"
          aria-label="Diamonds to convert"
          autoFocus
        />

        <div className="cmm-quick">
          {[100, 500, 1000, 10000].map((q) => (
            <button key={q} onClick={() => setDiamonds(String(q))}>
              {fmt(q)}
            </button>
          ))}
        </div>

        <div className={`cmm-preview ${valid ? '' : 'cmm-preview--dim'}`}>
          <span>You Receive</span>
          <strong>{fmt(chips)} Chips</strong>
        </div>

        <div className="cmm-actions">
          <button disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="cmm-confirm" disabled={!valid || busy} onClick={mint}>
            {busy ? 'Minting...' : 'Mint Chips'}
          </button>
        </div>
      </div>
    </div>
  );
}
