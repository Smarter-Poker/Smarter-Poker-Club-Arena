/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ☰ TABLE MENU ICONS — Premium SVG Icons for Hamburger Menu
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Inline SVG icons designed for the dark glassmorphic table menu.
 * Each icon is 18x18 with 1.5px strokes for a clean, premium feel.
 */

import React from 'react';

const iconStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  flexShrink: 0,
};

/** ⏸ Sit Out — pause icon */
export const SitOutIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="3" width="3" height="12" rx="1" fill="currentColor" opacity="0.85" />
    <rect x="11" y="3" width="3" height="12" rx="1" fill="currentColor" opacity="0.85" />
  </svg>
);

/** 💰 Add Chips / Rebuy — stack of chips icon */
export const RebuyIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="9" cy="13" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="9" cy="10" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="9" cy="7" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <path d="M3 7v3M15 7v3" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3 10v3M15 10v3" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** 📜 Hand History — document/scroll icon */
export const HandHistoryIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="2" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <line
      x1="6"
      y1="6"
      x2="12"
      y2="6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="6"
      y1="9"
      x2="12"
      y2="9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="6"
      y1="12"
      x2="9"
      y2="12"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

/** 🏆 Leaderboard — trophy icon */
export const LeaderboardIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M5 3h8v5a4 4 0 01-8 0V3z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path d="M5 5H3a1 1 0 00-1 1v1a2 2 0 002 2h1" stroke="currentColor" strokeWidth="1.5" />
    <path d="M13 5h2a1 1 0 011 1v1a2 2 0 01-2 2h-1" stroke="currentColor" strokeWidth="1.5" />
    <line x1="9" y1="12" x2="9" y2="14" stroke="currentColor" strokeWidth="1.5" />
    <path d="M6 14h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="5" y="15" width="8" height="1.5" rx="0.75" fill="currentColor" opacity="0.6" />
  </svg>
);

/** ⚙️ Settings — gear icon */
export const SettingsIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.4 3.4l1.4 1.4M13.2 13.2l1.4 1.4M3.4 14.6l1.4-1.4M13.2 4.8l1.4-1.4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

/** 📊 Session Stats — bar chart icon */
export const SessionStatsIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="10" width="3" height="6" rx="0.75" fill="currentColor" opacity="0.5" />
    <rect x="7.5" y="6" width="3" height="10" rx="0.75" fill="currentColor" opacity="0.7" />
    <rect x="13" y="2" width="3" height="14" rx="0.75" fill="currentColor" opacity="0.85" />
  </svg>
);

/** ❓ Help & Rules — question mark circle icon */
export const HelpIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M7 7a2 2 0 113 1.73c-.5.29-1 .77-1 1.27v.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="9" cy="13" r="0.75" fill="currentColor" />
  </svg>
);

/** 🚪 Leave Table — exit/door icon */
export const LeaveTableIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M6 3h7a2 2 0 012 2v8a2 2 0 01-2 2H6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M10 9H2M2 9l2.5-2.5M2 9l2.5 2.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** ➕ Add-On — plus circle icon */
export const AddOnIcon = () => (
  <svg style={iconStyle} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
    <line
      x1="9"
      y1="5.5"
      x2="9"
      y2="12.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="5.5"
      y1="9"
      x2="12.5"
      y2="9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);
