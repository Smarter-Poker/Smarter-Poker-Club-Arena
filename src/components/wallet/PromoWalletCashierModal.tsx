import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import './WalletCashierModal.css'; // Reuse existing styles
import { useAuthUser } from '../../hooks/useAuthUser';

interface PromoWalletCashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  clubId: string;
}

type DestinationWallet = 'agent_wallet' | 'promo_wallet' | 'player_wallet' | 'club_bank';
type RecipientType = 'member' | 'club';

interface Member {
  user_id: string;
  name: string;
  role: string;
  status: string;
  chip_balance: number;
}

interface Club {
  id: string;
  name: string;
}

export function PromoWalletCashierModal({ isOpen, onClose, clubId }: PromoWalletCashierModalProps) {
  const { user } = useAuthUser();
  const [promoBalance, setPromoBalance] = useState<number>(0);
  const [unionId, setUnionId] = useState<string | null>(null);
  const [recipientType, setRecipientType] = useState<RecipientType>('member');

  const [destination, setDestination] = useState<DestinationWallet>('player_wallet');
  const [members, setMembers] = useState<Member[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);

  const [search, setSearch] = useState('');
  const [recipientMember, setRecipientMember] = useState<Member | null>(null);
  const [recipientClub, setRecipientClub] = useState<Club | null>(null);

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !user?.id) return;

    // Load agent's promo balance and club's union
    const loadState = async () => {
      const { data: c } = await supabase.from('clubs').select('union_id').eq('id', clubId).single();
      setUnionId(c?.union_id || null);

      const { data: a } = await supabase
        .from('club_agents')
        .select('promo_wallet_balance')
        .eq('club_id', clubId)
        .eq('user_id', user.id)
        .single();
      setPromoBalance(Number(a?.promo_wallet_balance) || 0);

      // Load clubs if in union
      if (c?.union_id) {
        const { data: uClubs } = await supabase
          .from('clubs')
          .select('id, name')
          .eq('union_id', c.union_id);
        setClubs(uClubs || []);
      }

      // Load members
      if (c?.union_id) {
        // Load all union members
        const { data: unionMembers } = await supabase
          .from('club_members')
          .select(
            'user_id, role, status, chip_balance, profiles(display_name, username, full_name), clubs!inner(union_id)'
          )
          .eq('clubs.union_id', c.union_id)
          .in('status', ['active', 'approved']);

        if (unionMembers) {
          const mapped = unionMembers.map((m: any) => ({
            user_id: m.user_id,
            name:
              m.profiles?.display_name ||
              m.profiles?.username ||
              m.profiles?.full_name ||
              'Unknown',
            role: m.role,
            status: m.status,
            chip_balance: Number(m.chip_balance) || 0,
          }));
          setMembers(mapped);
        }
      } else {
        // Load standalone club members
        const { data: clubMembers } = await supabase
          .from('club_members')
          .select(
            'user_id, role, status, chip_balance, profiles(display_name, username, full_name)'
          )
          .eq('club_id', clubId)
          .in('status', ['active', 'approved']);

        if (clubMembers) {
          const mapped = clubMembers.map((m: any) => ({
            user_id: m.user_id,
            name:
              m.profiles?.display_name ||
              m.profiles?.username ||
              m.profiles?.full_name ||
              'Unknown',
            role: m.role,
            status: m.status,
            chip_balance: Number(m.chip_balance) || 0,
          }));
          setMembers(mapped);
        }
      }
    };

    loadState();
  }, [isOpen, clubId, user?.id]);

  const filteredMembers = useMemo(() => {
    if (!search) return members;
    const q = search.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, search]);

  const filteredClubs = useMemo(() => {
    if (!search) return clubs;
    const q = search.toLowerCase();
    return clubs.filter((c) => c.name.toLowerCase().includes(q));
  }, [clubs, search]);

  if (!isOpen) return null;

  const onSend = async () => {
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount <= 0) return setError('Enter a valid amount');
    if (numAmount > promoBalance) return setError('Insufficient Promo Balance');

    if (recipientType === 'member' && !recipientMember) return setError('Select a member');
    if (recipientType === 'club' && !recipientClub) return setError('Select a club');

    setSending(true);
    setError(null);

    const { data, error: rpcErr } = await supabase.rpc('fn_promo_wallet_send', {
      p_club_id: clubId,
      p_to_user_id: recipientType === 'member' ? recipientMember?.user_id : null,
      p_to_club_id: recipientType === 'club' ? recipientClub?.id : null,
      p_amount: numAmount,
      p_destination: destination,
      p_reason: reason || 'Promo Distribution',
    });

    setSending(false);

    if (rpcErr) {
      setError(rpcErr.message);
    } else if (data && !data.success) {
      setError(data.error);
    } else {
      setPromoBalance(data.balance_after);
      setAmount('');
      setRecipientMember(null);
      setRecipientClub(null);
      setSearch('');
      onClose();
    }
  };

  return (
    <div
      className="cbc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Promo Wallet Cashier"
      onClick={() => !sending && onClose()}
    >
      <div className="cbc-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cbc-head">
          <div className="cbc-title">PROMO WALLET CASHIER</div>
          <button className="cbc-x" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="cbc-bank">
          <span>Promo Wallet Balance</span>
          <strong>
            {promoBalance === null
              ? '...'
              : promoBalance.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
          </strong>
        </div>

        <div className="cbc-body">
          <div className="cbc-field">
            <label className="cbc-label">Recipient Type</label>
            <div className="cbc-seg">
              <button
                className={
                  recipientType === 'member' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'
                }
                onClick={() => {
                  setRecipientType('member');
                  setDestination('player_wallet');
                }}
              >
                Member
              </button>
              {unionId && (
                <button
                  className={
                    recipientType === 'club' ? 'cbc-seg-btn cbc-seg-btn--active' : 'cbc-seg-btn'
                  }
                  onClick={() => {
                    setRecipientType('club');
                    setDestination('club_bank');
                  }}
                >
                  Club
                </button>
              )}
            </div>
          </div>

          {recipientType === 'member' && (
            <div className="cbc-field">
              <label className="cbc-label">Destination Wallet</label>
              <div className="cbc-seg">
                <button
                  className={
                    destination === 'player_wallet'
                      ? 'cbc-seg-btn cbc-seg-btn--active'
                      : 'cbc-seg-btn'
                  }
                  onClick={() => setDestination('player_wallet')}
                >
                  Player Wallet
                </button>
                <button
                  className={
                    destination === 'agent_wallet'
                      ? 'cbc-seg-btn cbc-seg-btn--active'
                      : 'cbc-seg-btn'
                  }
                  onClick={() => setDestination('agent_wallet')}
                >
                  Agent Wallet
                </button>
                <button
                  className={
                    destination === 'promo_wallet'
                      ? 'cbc-seg-btn cbc-seg-btn--active'
                      : 'cbc-seg-btn'
                  }
                  onClick={() => setDestination('promo_wallet')}
                >
                  Promo Wallet
                </button>
              </div>
            </div>
          )}

          <div className="cbc-field">
            <label className="cbc-label">Search</label>
            <input
              type="text"
              placeholder={`Search ${recipientType === 'member' ? 'members' : 'clubs'}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="cbc-input"
            />
            <div className="cbc-list" style={{ maxHeight: '150px' }}>
              {recipientType === 'member'
                ? filteredMembers.map((m) => (
                    <div
                      key={m.user_id}
                      className="cbc-member"
                      style={{
                        background: recipientMember?.user_id === m.user_id ? 'var(--blue-dim)' : '',
                      }}
                      onClick={() => setRecipientMember(m)}
                    >
                      <div className="cbc-member-info">
                        <span className="cbc-member-name">{m.name}</span>
                        <span className="cbc-member-role">{m.role}</span>
                      </div>
                    </div>
                  ))
                : filteredClubs.map((c) => (
                    <div
                      key={c.id}
                      className="cbc-member"
                      style={{ background: recipientClub?.id === c.id ? 'var(--blue-dim)' : '' }}
                      onClick={() => setRecipientClub(c)}
                    >
                      <div className="cbc-member-info">
                        <span className="cbc-member-name">{c.name}</span>
                      </div>
                    </div>
                  ))}
            </div>
          </div>

          <div className="cbc-field">
            <label className="cbc-label">Amount</label>
            <input
              type="number"
              min="0.01"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="cbc-input"
            />
          </div>

          <div className="cbc-field">
            <label className="cbc-label">Reason (Optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Promo Distribution"
              className="cbc-input"
            />
          </div>

          {error && <div className="cbc-empty cbc-empty--bad">{error}</div>}

          <div className="cbc-actions">
            <button
              className="cbc-confirm"
              onClick={onSend}
              disabled={
                sending ||
                !amount ||
                (recipientType === 'member' ? !recipientMember : !recipientClub)
              }
            >
              {sending ? 'Sending...' : 'Send Promo Chips'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
