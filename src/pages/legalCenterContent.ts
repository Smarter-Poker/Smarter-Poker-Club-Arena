/**
 * The Legal Center's words, in one importable module.
 *
 * GSC FIX (2026-09-22). /hub/club-arena/legal is linked from the Help Center
 * and from every legal document, but it was the one indexable route the
 * prerender skipped: LegalWorkspacePage lives in
 * pages/workspaces/ArenaWorkspacePages, whose module graph creates the
 * Supabase client at import time. A reader without JavaScript got the
 * landing page's HTML and its canonical, and Google filed /legal as an
 * alternate of the arena root. The app page (LegalWorkspacePage) and the
 * static page (src/prerender/LegalPrerender.tsx) now render these same
 * entries: edit the copy here and both change.
 */
export interface LegalCenterEntry {
  label: string;
  description: string;
  /** One sentence on what the document covers, drawn from its own sections. */
  summary: string;
  path: string;
}

export const LEGAL_CENTER = {
  eyebrow: 'Trust & Rules',
  title: 'Legal Center',
  description:
    'The Current Platform Rules, Privacy Commitments, Integrity Standards, And Promotion Terms.',
  art: 'images/bg-vault.jpg',
} as const;

export const LEGAL_CENTER_ENTRIES: readonly LegalCenterEntry[] = [
  {
    label: 'Fair Gaming',
    description: 'Integrity, Security, And Reporting',
    summary:
      'How Poker Arena Keeps Every Game Fair: Card Randomness, Game Integrity Records, Prohibited Conduct, Detection And Review, Player Reporting, Enforcement, And Disputes.',
    path: '/legal/fair-gaming',
  },
  {
    label: 'Terms Of Service',
    description: 'Platform And Account Terms',
    summary:
      'The Agreement For Using Poker Arena: Account Responsibilities, Why Chips Are Club Play Credits, Fair Play, Content And Conduct, Termination, And Limitation Of Liability.',
    path: '/legal/tos',
  },
  {
    label: 'Privacy Policy',
    description: 'Data Use, Retention, And Controls',
    summary:
      'What Information Smarter.Poker Collects And Why, How It Is Used And Shared, The Services Involved, Data Security, Cookies, Retention, And Your Privacy Rights.',
    path: '/legal/privacy',
  },
  {
    label: 'Promotion Rules',
    description: 'Eligibility And Campaign Terms',
    summary:
      'The Rules Behind Every Promotion: Eligibility, Why Live Offer Terms Are Authoritative, Tournament And Club Promotions, Promotion Abuse, Changes, And Cancellation.',
    path: '/legal/promotions',
  },
  {
    label: 'Help Center',
    description: 'Product Help And Support Paths',
    summary:
      'Answers About Accounts, Clubs, Cash Games, Tournaments, Rewards, And Player Safety, Plus A Direct Way To Reach Support.',
    path: '/help',
  },
];
