/**
 * The Help Center's words, in one importable module.
 *
 * AEO PHASE 1 (2026-09-17). HelpPage renders these with search, a toggle and
 * the support form, which need React state and the app's providers. The
 * prerender (src/prerender/HelpPrerender.tsx) renders the same questions and
 * answers as static HTML for readers and crawlers that never run the bundle.
 * One source, two renderers: edit the copy here and both pages change.
 */
export interface FAQItem {
  category: 'Account' | 'Clubs' | 'Play' | 'Rewards' | 'Safety';
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FAQItem[] = [
  {
    category: 'Account',
    question: 'How Do I Customize My Profile?',
    answer:
      'Open My Profile To Update Your Avatar, Display Name, Bio, And Player Identity. Account And Device Controls Remain In Settings.',
  },
  {
    category: 'Account',
    question: 'How Do I Change My Password?',
    answer:
      'Open Settings, Find Account, And Choose Change Password. Poker Arena Sends The Reset Through Your Verified Account Email.',
  },
  {
    category: 'Account',
    // 2026-08-28: this said 2FA was "Coming Soon" for a feature that SHIPPED —
    // SettingsPage implements enrol / challenge / verify / unenrol against
    // Supabase MFA, with a QR modal. Telling a player a security feature does
    // not exist yet, while it sits two taps away, is a false statement about
    // their account security.
    question: 'Is Two-Factor Authentication Available?',
    answer:
      'Yes. Go To Settings → Account → Account Security And Choose Enable Two-Factor Authentication. Scan The QR Code With Your Authenticator App, Then Enter The Six-Digit Code To Confirm.',
  },
  {
    category: 'Account',
    question: 'How Do I Delete My Account?',
    answer:
      'Open Settings, Then Account Data And Closure, And Choose Close Account. After You Confirm, Smarter Poker Permanently Deletes The Account. Settle Every Club Chip Balance And Leave Any Table First, Or The Request Is Refused.',
  },
  {
    category: 'Clubs',
    question: 'How Do I Find Or Join A Club?',
    answer:
      'Use Find Players And Clubs From The Menu. Some Clubs Accept Requests Immediately; Private Clubs Require Approval Or An Invite.',
  },
  {
    category: 'Clubs',
    question: 'Where Do Club Operators Manage A Club?',
    answer:
      'Open The Club, Then Open Operations Center. Available People, Finance, Safety, And Control Tools Match Your Confirmed Club Role.',
  },
  {
    category: 'Play',
    question: 'How Do I Join A Tournament?',
    answer:
      'Open Tournaments, Select An Event, Review Its Live Structure And Entry Requirements, Then Choose Register When Registration Is Open.',
  },
  {
    category: 'Play',
    question: 'Where Can I Review A Hand?',
    answer:
      'Open Hand History To Find Completed Hands, Inspect The Action Record, And Launch The Hand Replayer When Replay Data Is Available.',
  },
  {
    category: 'Play',
    question: 'What Is The Bad Beat Jackpot?',
    answer:
      'Eligible Clubs Can Fund A Progressive Bad Beat Jackpot. The Live Club Rules And Jackpot Panel Show Qualification, Funding, And Payout Details.',
  },
  {
    category: 'Rewards',
    question: 'Where Can I See My Rewards?',
    answer:
      'Open Rewards Center For Wallet Balances, Transactions, VIP Status, Rakeback, Promotions, Bonuses, Achievements, And Challenges.',
  },
  {
    category: 'Rewards',
    question: 'Why Can A Bonus Or Rakeback Rate Change?',
    answer:
      'Reward Amounts Come From The Live Offer, Club, Or Rakeback Record. Review The Current Promotion And Claim Terms Before Participating.',
  },
  {
    category: 'Safety',
    question: 'How Do I Report Suspected Unfair Play?',
    answer:
      'Use Report Player From The Table Or Player Profile And Include The Hand Number And Specific Conduct. You Can Also Send A Support Request Here.',
  },
  {
    category: 'Safety',
    question: 'How Do I Report A Product Problem?',
    answer:
      'Choose Send Support Request, Select Bug, And Describe What Happened. The Form Only Confirms Success After The Request Reaches The Support Queue.',
  },
];

export const QUICK_LINKS = [
  { label: 'Find A Club', path: '/search' },
  { label: 'Hand History', path: '/hand-history' },
  { label: 'Rewards Center', path: '/rewards' },
  { label: 'Fair Gaming', path: '/legal/fair-gaming' },
];
