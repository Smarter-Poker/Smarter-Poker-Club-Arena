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
];

export function tutorialForPath(pathname: string): TutorialStep[] | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const tour of TOURS) {
    if (tour.match.test(path)) return tour.steps;
  }
  return null;
}
