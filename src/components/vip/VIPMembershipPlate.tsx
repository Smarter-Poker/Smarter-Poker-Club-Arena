/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  VIP MEMBERSHIP PLATE — what the membership IS, and what it actually gives
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Replaces three components deleted on 2026-09-05: VIPStatsHeader,
 * TierProgressionCard and VIPBenefitsGrid. All three were built on
 * `src/constants/vipTiers.ts`, a six-rung ladder - bronze, silver, gold,
 * platinum, diamond, royal - with rakeback percentages, point multipliers and
 * monthly tournament tickets attached to each rung.
 *
 * Dan, 2026-09-04, verbatim: "THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW.
 * JUST VIP, AND LIFETIME VIP."
 *
 * Nothing on the platform implemented any rung of it. The page told a player
 * with 150,000 points that they were ROYAL, on 30% rakeback and a 10x
 * multiplier, with access to private high-stakes tables and 24/7 dedicated
 * support. None of those exist. The one number on this plate that is not
 * server-enforced is none of them: every allowance below is metered by a
 * function named in the comment beside it.
 *
 * VIP points are real - 1,005 players hold them and vip_points_ledger has 5.1
 * million rows - so they stay. What they are NOT is a ladder: they buy things
 * in the rewards marketplace, and they do not confer a tier.
 */
import React from 'react';
import { VIP_MONTHLY_ALLOWANCES } from '../../services/VIPService';
import type { VIPMonthlyLimits } from '../../services/VIPService';
import type { VipStatus } from '../../utils/vipStatus';
import './VIPMembershipPlate.css';

interface VIPMembershipPlateProps {
  status: VipStatus;
  expiresAt: Date | null;
  limits: VIPMonthlyLimits;
  points: { current: number; lifetime: number; monthly: number; activeStreak: number };
}

const MEMBERSHIP_LABEL: Record<VipStatus, string> = {
  none: 'Not A Member',
  vip: 'VIP',
  lifetime: 'Lifetime VIP',
};

/** Zero rounding, per the house rule. A part-used allowance never reads full. */
const pct = (used: number, limit: number) =>
  limit <= 0 ? 0 : Math.min(100, Math.trunc((used / limit) * 100));

const fmt = (n: number) => Math.trunc(n).toLocaleString();

export const VIPMembershipPlate: React.FC<VIPMembershipPlateProps> = ({
  status,
  expiresAt,
  limits,
  points,
}) => {
  const isMember = status !== 'none';

  const allowances = [
    {
      id: 'rabbit',
      label: 'Rabbit Hunts',
      // fn_consume_rabbit_hunt, v_vip_monthly_cap = 100. 5 diamonds from the 101st.
      used: limits.rabbitHunts.used,
      limit: limits.rabbitHunts.limit || VIP_MONTHLY_ALLOWANCES.rabbitHunts,
      unit: '',
    },
    {
      id: 'timebank',
      label: 'Time Bank',
      // fn_time_bank_allowance returns 120 minus the month's use; the engine
      // seeds the bank from it in ServerTableEngineDealing.
      used: limits.timeBankSeconds.used,
      limit: limits.timeBankSeconds.limit || VIP_MONTHLY_ALLOWANCES.timeBankSeconds,
      unit: 's',
    },
    {
      id: 'emojis',
      label: 'Emojis',
      // fn_increment_vip_usage counts 'emoji_pack'.
      used: limits.emojis.used,
      limit: limits.emojis.limit || VIP_MONTHLY_ALLOWANCES.emojis,
      unit: '',
    },
    {
      id: 'tags',
      label: 'Player Tags',
      // fn_increment_vip_usage counts 'tag_pack'.
      used: limits.tags.used,
      limit: limits.tags.limit || VIP_MONTHLY_ALLOWANCES.tags,
      unit: '',
    },
  ];

  /* Included, not metered. Each is a per-session or per-use diamond charge a
     member does not pay. "Included" and never "Unlimited" - Dan struck that
     word: "THERE IS NOTHING UNLIMITED LIKE THROWABLES OR TIME BANKS." */
  const included = [
    { id: 'stack', label: 'Show Stack In Big Blinds', otherwise: '5 Diamonds Per Session' },
    { id: 'offline', label: 'Offline Protection', otherwise: '10 Diamonds Per Session' },
    { id: 'autobank', label: 'Auto Time Bank', otherwise: '5 Diamonds Per Activation' },
  ];

  return (
    <section className="vmp" aria-label="VIP Membership">
      <header className="vmp__head">
        <div className="vmp__identity">
          <span className="vmp__eyebrow">Membership</span>
          <strong className="vmp__grade" data-status={status}>
            {MEMBERSHIP_LABEL[status]}
          </strong>
          <span className="vmp__term">
            {status === 'lifetime'
              ? 'Never Expires'
              : status === 'vip'
                ? expiresAt
                  ? `Renews ${expiresAt.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}`
                  : 'Active'
                : 'Features Are Purchased Individually With Diamonds'}
          </span>
        </div>

        <dl className="vmp__points" aria-label="VIP Points">
          <div>
            <dt>Points</dt>
            <dd>{fmt(points.current)}</dd>
          </div>
          <div>
            <dt>This Month</dt>
            <dd>{fmt(points.monthly)}</dd>
          </div>
          <div>
            <dt>Lifetime</dt>
            <dd>{fmt(points.lifetime)}</dd>
          </div>
          <div>
            <dt>Active Streak</dt>
            <dd>
              {fmt(points.activeStreak)} <span className="vmp__unit">Days</span>
            </dd>
          </div>
        </dl>
      </header>

      {isMember && (
        <>
          <div className="vmp__section">
            <h3 className="vmp__title">Included Each Month</h3>
            <ul className="vmp__allowances">
              {allowances.map((a) => {
                const remaining = Math.max(0, a.limit - a.used);
                return (
                  <li key={a.id} className="vmp__allowance">
                    <span className="vmp__allowanceLabel">{a.label}</span>
                    <strong className="vmp__allowanceValue">
                      {fmt(remaining)}
                      {a.unit}
                      <span className="vmp__allowanceOf">
                        {' '}
                        Of {fmt(a.limit)}
                        {a.unit} Left
                      </span>
                    </strong>
                    <span
                      className="vmp__meter"
                      role="meter"
                      aria-valuenow={a.used}
                      aria-valuemin={0}
                      aria-valuemax={a.limit}
                      aria-label={`${a.label} Used This Month`}
                    >
                      <span
                        className="vmp__meterFill"
                        style={{ width: `${pct(a.used, a.limit)}%` }}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="vmp__section">
            <h3 className="vmp__title">Included, Not Metered</h3>
            <ul className="vmp__included">
              {included.map((i) => (
                <li key={i.id}>
                  <span className="vmp__includedLabel">{i.label}</span>
                  <span className="vmp__includedOtherwise">Otherwise {i.otherwise}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
};

export default VIPMembershipPlate;
