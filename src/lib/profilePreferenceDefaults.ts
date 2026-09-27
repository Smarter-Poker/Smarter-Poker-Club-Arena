/** Defaults shared by the lazy Settings page and the always-mounted account reader. */
export const PROFILE_PREFERENCE_DEFAULTS = {
  theme: 'dark' as 'dark' | 'light' | 'auto',
  achievementNotifications: true,
  settlementAlerts: true,
} as const;
