/**
 * UNION CLUB GOVERNANCE
 *
 * Removing a club from a union is not a delete — it has to unwind live
 * exposure first. This surfaces fn_union_club_exit_blockers so the owner can
 * see exactly what is still open (seated players, live tournament entries,
 * unsettled rake, agent credit) before calling fn_union_expel_club.
 *
 * Force is offered only once the blockers have been read, and it is labelled
 * for what it is.
 */

import { useState } from 'react';
import { UnionOpsService, type ExitBlockers } from '../../services/UnionOpsService';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';

const money = (n: unknown) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);

interface Props {
  unionId: string;
  clubId: string;
  clubName: string;
  onExpelled?: (clubId: string) => void;
}

export default function UnionClubGovernance({ unionId, clubId, clubName, onExpelled }: Props) {
  const toast = useToast();
  const [blockers, setBlockers] = useState<ExitBlockers | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const check = async () => {
    setBusy(true);
    try {
      const b = await UnionOpsService.getClubExitBlockers(unionId, clubId);
      setBlockers(b);
      setOpen(true);
    } catch (e) {
      reportError(e, 'UnionClubGovernance.check');
      toast.error('Could not read exit status');
    } finally {
      setBusy(false);
    }
  };

  const expel = async (force: boolean) => {
    setBusy(true);
    try {
      const res = await UnionOpsService.expelClub(unionId, clubId, reason || undefined, force);
      if (res?.success) {
        toast.success(`${clubName} removed from the union`);
        setOpen(false);
        onExpelled?.(clubId);
      } else {
        toast.error(res?.error ?? 'Removal blocked');
        if (res?.blockers) setBlockers(res.blockers);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Removal failed';
      toast.error(msg);
      reportError(e, 'UnionClubGovernance.expel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => void check()}
        disabled={busy}
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          fontSize: '0.8rem',
          border: '1px solid #5a2020',
          background: 'transparent',
          color: '#ff9c9c',
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        Remove From Union
      </button>

      {open && (
        <div
          onClick={() => !busy && setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 460,
              borderRadius: 14,
              padding: 20,
              background: '#101a1f',
              border: '1px solid #24343d',
            }}
          >
            <h3 style={{ margin: '0 0 4px', color: '#e6f1f5' }}>Remove {clubName}</h3>
            <p style={{ color: '#7d919b', fontSize: '0.82rem', marginTop: 0 }}>
              The Club Keeps Its Own Private Games. Its Players Lose Access To Union Games.
            </p>

            {blockers && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '14px 0' }}>
                <Blocker
                  label="Players Seated In Union Games"
                  value={blockers.players_seated_in_union_games}
                />
                <Blocker label="Live Tournament Entries" value={blockers.live_tournament_entries} />
                <Blocker
                  label="Unsettled Rake This Period"
                  value={money(blockers.unsettled_rake_this_period)}
                  bad={Number(blockers.unsettled_rake_this_period) > 0}
                />
                <Blocker
                  label="Agent Credit Outstanding"
                  value={money(blockers.agent_credit_outstanding)}
                  bad={Number(blockers.agent_credit_outstanding) > 0}
                />
                <div
                  style={{
                    marginTop: 6,
                    padding: 10,
                    borderRadius: 8,
                    fontSize: '0.82rem',
                    color: blockers.clear_to_exit ? '#37e7c7' : '#ffb347',
                    background: blockers.clear_to_exit
                      ? 'rgba(55,231,199,0.08)'
                      : 'rgba(255,179,71,0.08)',
                  }}
                >
                  {blockers.clear_to_exit
                    ? 'Clear To Exit.'
                    : 'Open Exposure - Forcing Will Leave It Unsettled.'}
                </div>
              </div>
            )}

            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (Recorded In The Audit Log)"
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 8,
                marginBottom: 14,
                border: '1px solid #2a3a44',
                background: 'rgba(255,255,255,0.04)',
                color: '#e6f1f5',
              }}
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                style={{
                  padding: '9px 14px',
                  borderRadius: 8,
                  border: '1px solid #2a3a44',
                  background: 'transparent',
                  color: '#8fa3ad',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              {blockers && !blockers.clear_to_exit && (
                <button
                  onClick={() => void expel(true)}
                  disabled={busy}
                  style={{
                    padding: '9px 14px',
                    borderRadius: 8,
                    border: '1px solid #5a2020',
                    background: 'rgba(255,118,118,0.1)',
                    color: '#ff9c9c',
                    cursor: busy ? 'wait' : 'pointer',
                  }}
                >
                  Force Remove
                </button>
              )}
              <button
                onClick={() => void expel(false)}
                disabled={busy || (blockers ? !blockers.clear_to_exit : false)}
                style={{
                  padding: '9px 14px',
                  borderRadius: 8,
                  border: '1px solid #37e7c7',
                  background: 'rgba(55,231,199,0.12)',
                  color: '#37e7c7',
                  fontWeight: 700,
                  opacity: blockers && !blockers.clear_to_exit ? 0.4 : 1,
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                {busy ? 'Working…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Blocker({ label, value, bad }: { label: string; value: React.ReactNode; bad?: boolean }) {
  const flagged = bad ?? Number(value) > 0;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
      <span style={{ color: '#8fa3ad' }}>{label}</span>
      <strong style={{ color: flagged ? '#ffb347' : '#37e7c7' }}>{value}</strong>
    </div>
  );
}
