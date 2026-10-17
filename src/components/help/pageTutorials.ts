/**
 * Curated tours for the pages a player meets most.
 *
 * Every page gets a tour without being listed here: PageHelp builds one from
 * the page's own explanation and its section headings. A page is listed here
 * when the generic tour would not point at the controls that matter, and each
 * step can name a CSS selector for the part of the page it is talking about.
 *
 * Copy rules bind every string: Title Case on every word, no em dashes.
 * Paths are router paths, without the /hub/club-arena basename.
 */

export interface TutorialStep {
  title: string;
  body: string;
  /** A selector, or an element, to scroll to and light while this step shows. */
  target?: string | Element;
}

interface TourEntry {
  match: RegExp;
  steps: TutorialStep[];
}

const TOURS: TourEntry[] = [
  {
    match: /^\/notifications\/?$/,
    steps: [
      {
        title: 'All Or Unread',
        body: 'Switch Between Every Signal And Only The Ones You Have Not Opened Yet.',
        target: '.ca-notif__filters',
      },
      {
        title: 'Alert Controls',
        body: 'Choose Which Alerts Reach Your Phone, Or Mark Everything As Read In One Tap.',
        target: '.ca-notif__actions',
      },
      {
        title: 'Your Signals',
        body: 'Seat Calls, Tournament Starts, Settlements, Messages And Club Announcements Land Here. Tap One To Go Straight To It.',
        target: '.ca-notif__list',
      },
    ],
  },
  {
    match: /^\/clubs\/[^/]+\/cashier\/?$/,
    steps: [
      {
        title: 'Simple Or Advanced',
        body: 'Simple Shows Who You Can Send Chips To. Advanced Adds Requests, Tickets And The Full Ledger.',
        target: '[aria-pressed][class*="modeToggle"]',
      },
      {
        title: 'Your Balances',
        body: 'Your Club Chips And Your Agent Wallet, Read From The Ledger.',
        target: '[aria-label="Current Cashier Balances"]',
      },
      {
        title: 'Cash Out',
        body: 'Ask Your Agent Or The Club To Cash You Out. The Button Shows The Chips You Hold Here.',
        target: '[aria-label="Request Cash Out"]',
      },
      {
        title: 'Cashier Actions',
        body: 'Send Chips, Answer Requests, Redeem Tickets And Read Every Ledger Entry From These Tabs.',
        target: '[aria-label="Cashier Actions"]',
      },
    ],
  },
  {
    match: /^\/hand-history\/?$/,
    steps: [
      {
        title: 'Find A Hand',
        body: 'Search By Hand Number, Opponent, Tag Or Note, Or Narrow To One Game And A Date Range.',
        target: '.hh-search',
      },
      {
        title: 'Filter The List',
        body: 'Show Only Hands You Won Or Lost, Big Pots, Showdowns, All-Ins, Or Hands With Notes.',
        target: '[aria-label="Filter Loaded Hands"]',
      },
      {
        title: 'Open A Hand',
        body: 'Expand Any Hand For The Full Rundown, Replay It, Share It, Or Send It To Jarvis.',
      },
    ],
  },
  {
    match: /^\/tournaments\/?$/,
    steps: [
      {
        title: 'By State',
        body: 'Show Upcoming Events, Events Open For Registration, Live Events Or Completed Ones.',
        target: '[aria-label="Filter By State"]',
      },
      {
        title: 'By Format',
        body: 'Narrow The Lobby To Multi-Table Tournaments, Sit And Gos, Spins Or Bounty Events.',
        target: '[aria-label="Filter By Format"]',
      },
      {
        title: 'Register',
        body: 'Open An Event To See Its Buy-In, Structure And Prize Pool, Then Register From There.',
      },
    ],
  },
  {
    match: /^\/friends\/?$/,
    steps: [
      {
        title: 'Your Views',
        body: 'Your Friends, Requests Waiting On You, What Your Friends Have Been Doing, And Friendly Challenges.',
        target: '[aria-label="Connection Views"]',
      },
      {
        title: 'Find Players',
        body: 'Search The Network For Someone To Add, Or Open Messenger To Talk To A Friend.',
        target: '.friends-hero-action',
      },
    ],
  },
];

export function tutorialForPath(pathname: string): TutorialStep[] | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const tour of TOURS) {
    if (tour.match.test(path)) return tour.steps;
  }
  return null;
}
