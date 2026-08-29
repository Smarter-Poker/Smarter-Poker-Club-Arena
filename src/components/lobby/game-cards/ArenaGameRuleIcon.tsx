import type { ReactNode } from 'react';
import type { RuleMedallion } from '../lobbyEntries';
import './ArenaGameCard.css';

const paths: Record<string, ReactNode> = {
  insurance: <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Zm-3 10 2 2 4-5" />,
  rit: <path d="M5 6h8l-2-2m2 2-2 2M19 18h-8l2 2m-2-2 2-2M7 6c-3 3-3 9 0 12m10-12c3 3 3 9 0 12" />,
  straddle: <path d="M7 7c0-2 2-3 5-3s5 1 5 3-2 3-5 3-5 1-5 3 2 4 5 4 5-2 5-4M12 2v20" />,
  bomb: (
    <path d="M9 6h6l1 3c3 1 5 4 5 7a9 9 0 1 1-18 0c0-3 2-6 5-7l1-3Zm3 5v5m0 3h.01M15 4l2-2m0 4h3" />
  ),
  vpip: <path d="M4 17a8 8 0 1 1 16 0M12 13l4-5M7 18h10" />,
  nit_game: <path d="M4 17a8 8 0 1 1 16 0M12 13l4-5M7 18h10" />,
  anonymous: <path d="M4 10c2-4 14-4 16 0l-2 7c-2 2-4 1-6-1-2 2-4 3-6 1l-2-7Zm3 1 3 1m7-1-3 1" />,
  double_board: <path d="M3 5h8v12H3V5Zm10 2h8v12h-8V7Z" />,
  pko: <path d="M12 2v4m0 12v4M2 12h4m12 0h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 3v4m-2-2h4" />,
  bounty: <path d="M12 3 5 6v5c0 4 3 7 7 10 4-3 7-6 7-10V6l-7-3Zm0 4v8m-4-4h8" />,
  mystery: <path d="m12 2 9 10-9 10L3 12 12 2Zm-2 7c0-2 4-3 5-1 1 3-3 3-3 6m0 3h.01" />,
  satellite: (
    <path d="M8 3h8v5c0 3-2 5-4 5S8 11 8 8V3ZM5 5H3c0 4 2 6 6 6m10-6h2c0 4-2 6-6 6m-3 2v4m-4 3h8" />
  ),
  rebuy: <path d="M20 7v5h-5M4 17v-5h5M6 8a7 7 0 0 1 12-1l2 5M18 16a7 7 0 0 1-12 1l-2-5" />,
  reentry: <path d="M4 4h9a6 6 0 0 1 0 12H7m0-4-4 4 4 4" />,
  addon: <path d="M12 4v16M4 12h16" />,
  freezeout: <path d="M12 2v20M4 7l16 10M20 7 4 17M8 4l4 3 4-3M8 20l4-3 4 3" />,
  turbo: <path d="m13 2-8 12h6l-1 8 9-13h-6V2Z" />,
  hyper: <path d="m10 2-6 10h5l-1 5 6-9h-4V2Zm7 4-4 7h4l-1 6 5-9h-4V6Z" />,
  deepstack: (
    <path d="M5 7c0 2 14 2 14 0S5 5 5 7Zm0 5c0 2 14 2 14 0m-14 5c0 2 14 2 14 0M5 7v10m14-10v10" />
  ),
  gtd: <path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z" />,
  latereg: <path d="M12 3a9 9 0 1 0 9 9M12 7v6l4 2M17 3v5h5" />,
  freeroll: <path d="M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V7Zm9 2v8" />,
  ante: <path d="M5 8c0 2 14 2 14 0S5 6 5 8Zm0 4c0 2 14 2 14 0m-14 4c0 2 14 2 14 0" />,
  seven_deuce: <path d="M4 4h7v10H4V4Zm9 6h7v10h-7V10ZM7 7h1m8 6h1" />,
  time_bank: <path d="M7 3h10M7 21h10M8 3c0 5 2 6 4 9-2 3-4 4-4 9m8-18c0 5-2 6-4 9 2 3 4 4 4 9" />,
  cap: <path d="M5 5h14v14H5zM8 12h8" />,
  no_rathole: <path d="M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5z" />,
  pineapple: <path d="M12 8c4 0 6 3 5 8-1 4-9 4-10 0-1-5 1-8 5-8Zm0 0V3m0 3L8 3m4 3 4-3" />,
  restrict_observers: (
    <path d="M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5Zm6 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM4 4l16 16" />
  ),
  all_in_or_fold: <path d="M6 3v18m12-18v18M6 8h5l-2-2m2 2-2 2m9 6h-5l2-2m-2 2 2 2" />,
};

const fallback = <path d="M12 3 3 8v8l9 5 9-5V8l-9-5Zm0 5v5m0 4h.01" />;

export function ArenaGameRuleIcon({ rule }: { rule: RuleMedallion }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths[rule.key] || fallback}
      </g>
    </svg>
  );
}

export function ArenaGameRuleBadge({ rule }: { rule: RuleMedallion }) {
  const displayLabel = rule.key === 'nit_game' ? 'VPIP' : rule.label;
  return (
    <span
      className={`agc-rule agc-rule--${rule.key}`}
      title={rule.tip}
      aria-label={`${displayLabel}${rule.detail ? `, ${rule.detail}` : ''}`}
    >
      <i className="agc-rule__icon">
        <ArenaGameRuleIcon rule={rule} />
      </i>
      <span className="agc-rule__copy">
        <b>{displayLabel}</b>
        {rule.detail && <small>{rule.detail}</small>}
      </span>
    </span>
  );
}
