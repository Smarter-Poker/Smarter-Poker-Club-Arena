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
 * in the rewards marketplace, and they do not confer a tier. Exact Lifetime
 * entitlements are rendered separately from ordinary VIP monthly meters.
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
  const isLifetime = status === 'lifetime';

  const allowances = [
    {
      id: 'rabbit',
      label: 'Rabbit Hunts',
      // Ordinary VIP: fn_consume_rabbit_hunt meters 100, then charges 5 Diamonds.
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
    {
      id: 'throwables',
      label: 'Throwables',
      /* fn_use_throwable counts this calendar month's rows in `throw_usage`
         and charges 1 diamond only from the 501st. RESTORED 2026-09-05 - it
         was cut from this list the same morning on the strength of an empty
         `feature_pricing.throwable.vip_tiers_included`, a column nothing
         reads. The function was the enforcement all along. */
      used: limits.throwables.used,
      limit: limits.throwables.limit || VIP_MONTHLY_ALLOWANCES.throwables,
      unit: '',
    },
  ].filter(
    (allowance) =>
      !isLifetime || !['rabbit', 'timebank', 'emojis', 'tags', 'throwables'].includes(allowance.id)
  );

  /* Ordinary VIP keeps every existing cap. The exact Lifetime membership adds
     the newer unmetered gameplay and cataloged digital-cosmetic contract. */
  const included = [
    ...(isLifetime
      ? [
          {
            id: 'lifetime-rabbit',
            label: 'Rabbit Hunts',
            detail: 'Unlimited With Lifetime VIP',
          },
          {
            id: 'lifetime-throwables',
            label: 'Throwables',
            detail: 'Unlimited With Lifetime VIP',
          },
          {
            id: 'lifetime-timebank',
            label: 'Standard 20-Second Time Bank Activations',
            detail: 'Unlimited With Lifetime VIP',
          },
          {
            id: 'lifetime-emojis',
            label: 'Digital Emoji Packs',
            detail: 'All Digital Options Included',
          },
          {
            id: 'lifetime-tags',
            label: 'Player Tags',
            detail: 'All Digital Options Included',
          },
          {
            id: 'lifetime-table-art',
            label: 'Cataloged Table Skins And Backgrounds',
            detail: 'All Digital Options Included',
          },
          {
            id: 'lifetime-card-art',
            label: 'Cataloged Card Backs And Dealer Buttons',
            detail: 'All Digital Options Included',
          },
          {
            id: 'lifetime-avatar-art',
            label: 'VIP Avatars, Frames, And Auras',
            detail: 'All VIP-Only Digital Options Included',
          },
        ]
      : []),
    { id: 'stack', label: 'Show Stack In Big Blinds', otherwise: '5 Diamonds Per Session' },
    { id: 'offline', label: 'Offline Protection', otherwise: '10 Diamonds Per Session' },
    { id: 'autobank', label: 'Auto Time Bank', otherwise: '5 Diamonds Per Activation' },
  ].map((item) => ({
    ...item,
    detail: 'detail' in item ? item.detail : `Otherwise ${item.otherwise}`,
  }));

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
          {allowances.length > 0 && (
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
          )}

          <div className="vmp__section">
            <h3 className="vmp__title">Included, Not Metered</h3>
            <ul className="vmp__included">
              {included.map((i) => (
                <li key={i.id}>
                  <span className="vmp__includedLabel">{i.label}</span>
                  <span className="vmp__includedOtherwise">{i.detail}</span>
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
