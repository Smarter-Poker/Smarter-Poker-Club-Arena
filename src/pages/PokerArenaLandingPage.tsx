/**
 * Poker Arena public landing page, on the #ClubArenaConsole master art.
 *
 * Until 2026-09-16 an anonymous visit to /hub/club-arena was a JavaScript
 * redirect to the World Hub login, and index.html said `noindex, nofollow`.
 * Google therefore had nothing to index for Poker Arena at all: a crawler
 * that rendered the page saw a login form, and one that did not was told to
 * go away.
 *
 * This page is what a signed-out visitor (and Googlebot) now gets at the
 * arena root: a real, static description of the product with its own title,
 * description, canonical and JSON-LD (see src/lib/seo.ts), and two ways in.
 * Signed-in players never see it; AuthGuard renders HomePage for them exactly
 * as before. Nothing here fetches, so it renders identically for a crawler
 * and a person.
 *
 * THE FRONT DOOR IS PAINTED, NOT STYLED (2026-09-22). Until today this was
 * the last page in the arena still drawing its own chrome: rounded cards, a
 * blue gradient pill for the call to action, a coloured disc behind each step
 * number. It is now five SpadeConsole frames cut from Dan's approved masters,
 * one per section, wearing a different crest each (spade, club, diamond, vip,
 * flat) so no two frames are the same picture. Nothing on this page is drawn:
 * the frames, the plates and the closing caps are the art, and every word is
 * live DOM text printed into a zone measured on it.
 *
 * WHAT IS DIFFERENT HERE FROM EVERY OTHER CONSOLE SURFACE. This route is
 * PRERENDERED (src/prerender/entry-server.tsx maps '/' to this component, and
 * scripts/prerender-public-routes.mjs writes the result into dist/index.html),
 * so the markup below is also the static HTML that reaches a crawler which
 * never runs the bundle. Two consequences:
 *
 *   1. the heading has to survive without JavaScript, so the hero console
 *      prints its title as the document's h1 (`titleAs="h1"`). The prerender
 *      refuses to publish a page with no h1;
 *   2. both ways in are real anchors, on painted plates (PlateButton with an
 *      href), never buttons that call location. A crawler follows an href;
 *      it does not click.
 *
 * useFitText runs in a layout effect, so the static HTML ships each label at
 * its designed size and the browser fits it on mount. Nothing here reads
 * layout, `window` or a browser API while rendering.
 *
 * EVERY CONSOLE HERE CARRIES A PILL, AND THAT IS NOT DECORATION. The master
 * head PAINTS the pill slot whether or not a word is printed into it, so an
 * empty one reads as a frame with a piece missing, and a title rendered
 * without one runs into its rim: "HOW POKER ARENA WORKS" had its last letter
 * sitting on the chrome, which is the defect SPADE_CONSOLE_ZONES.
 * titleBesidePill exists for and which the console selects the moment a pill
 * is present. Each word is a fact the section already states: the account is
 * free, there are six things a club gets, there are three steps, the rules
 * are public.
 *
 * Copy is Title Case (repo rule, scripts/ci/check-title-case.mjs).
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import styles from './PokerArenaLandingPage.module.css';
import { SpadeConsole, type PlateButtonProps } from '../components/console/SpadeConsole';
import { signInUrl } from '../lib/signIn';
import { WEB_ORIGIN } from '../lib/appBase';
import { capture } from '../lib/analytics';

const SIGN_UP_URL = `${WEB_ORIGIN}/auth/signup?redirect=${encodeURIComponent('/hub/club-arena')}`;

const FEATURES = [
  {
    title: 'Private Poker Clubs',
    body: 'Create A Club, Set Your Own Stakes And Rules, Invite Your Players And Keep Every Game Inside Your Own Walls.',
  },
  {
    title: 'Real Time Cash Games',
    body: "Hold'em, Omaha, Short Deck And Pineapple At Tables That Deal In Real Time, With Straddles, Bomb Pots, Run It Twice And Insurance.",
  },
  {
    title: 'Tournaments',
    body: 'Schedule Multi Table Tournaments With Custom Blind Structures, Rebuys, Bounties And Automatic Payouts.',
  },
  {
    title: 'Hand Histories And Stats',
    body: 'Every Hand Is Recorded. Replay It, Share It And Study Player Statistics And Leaderboards Across Your Club.',
  },
  {
    title: 'Club Management',
    body: 'A Cashier, Chip Ledger, Agent System, Rake Settings, Reports And Settlement Tools Built For Club Owners.',
  },
  {
    title: 'Unions And Diamond Arena',
    body: 'Link Clubs Into Unions For Shared Player Pools, And Play Diamond Denominated Games Inside The Same Arena.',
  },
];

const STEPS = [
  {
    title: 'Create Your Free Account',
    body: 'One Smarter.Poker Account Opens Poker Arena And Every Other Feature On The Platform.',
  },
  {
    title: 'Create Or Join A Club',
    body: 'Start Your Own Club In Minutes Or Join One With An Invite Code From Its Owner.',
  },
  {
    title: 'Sit Down And Play',
    body: 'Open The Lobby, Pick A Table Or Tournament And Play From Your Browser Or The Mobile App.',
  },
];

const RESOURCES = [
  { label: 'Help Center', to: '/help' },
  { label: 'Fair Gaming', to: '/legal/fair-gaming' },
  { label: 'Terms Of Service', to: '/legal/tos' },
  { label: 'Privacy Policy', to: '/legal/privacy' },
  { label: 'Promotion Rules', to: '/legal/promotions' },
];

/**
 * DISCOVERABILITY PHASE 5 (2026-09-17). The landing page is the top of the
 * activation funnel (signup -> first_login -> first_table_seat ..., see
 * src/lib/analytics.ts), and until now nothing recorded that a visitor saw
 * it or which button took them out of it. Two events, through the same
 * consent-gated PostHog path as every other event in the arena: a view on
 * mount, and a click on each way in, named by placement so the hero and the
 * closing call to action can be compared. The page itself still fetches
 * nothing; capture() is a no-op until the visitor has consented.
 */
const LANDING_VIEWED = 'landing_viewed';
const LANDING_CTA_CLICKED = 'landing_cta_clicked';

function trackCta(cta: 'sign_up' | 'sign_in', placement: 'hero' | 'closing'): void {
  capture(LANDING_CTA_CLICKED, { cta, placement, product: 'poker_arena' });
}

/**
 * The two ways in, as the painted plates of a console foot: the steel plate
 * on the left for a player who already has an account, the lit blue glass on
 * the right for a new one.
 *
 * Each caller passes its own handler rather than a placement string, so the
 * four `trackCta(...)` calls stay LITERAL in this file. The law that keeps
 * the activation funnel honest reads this source for them by name
 * (tests/the-public-arena-is-indexable-and-the-private-arena-is-not.law), and
 * a helper that assembles the arguments is exactly the clever indirection the
 * console standard's trap 7.6 warns about: it reads better and it makes the
 * pin unreadable.
 */
function signInPlate(onClick: () => void): PlateButtonProps {
  return { label: 'Sign In', ink: 'silver', href: signInUrl('/'), onClick };
}

function createAccountPlate(onClick: () => void): PlateButtonProps {
  return { label: 'Create Account', ink: 'white', href: SIGN_UP_URL, onClick };
}

export default function PokerArenaLandingPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
    capture(LANDING_VIEWED, { product: 'poker_arena', referrer: document.referrer || null });
  }, []);

  return (
    <main className={styles.page} id="main-content" tabIndex={-1}>
      <SpadeConsole
        className={styles.console}
        crest="spade"
        eyebrow="Smarter.Poker"
        title="Poker Arena"
        titleAs="h1"
        subtitle="Private Online Poker Clubs"
        pill="Free"
        foot="plates"
        plates={{
          secondary: signInPlate(() => trackCta('sign_in', 'hero')),
          primary: createAccountPlate(() => trackCta('sign_up', 'hero')),
        }}
      >
        <p className="sc-copy">
          Create Or Join A Private Poker Club, Play Real Time Cash Games And Tournaments With Your
          Own Players, And Run The Whole Club From One Dashboard.
        </p>
        <p className="sc-copy">
          A Free Smarter.Poker Account Opens Every Club, Table And Tournament In The Arena.
        </p>
      </SpadeConsole>

      <SpadeConsole
        className={styles.console}
        crest="club"
        eyebrow="What You Get"
        title="Everything A Club Needs"
        pill="Six"
        titleId="features-heading"
        aria-labelledby="features-heading"
        foot="foot"
      >
        <ul className={styles.rows}>
          {FEATURES.map((feature) => (
            <li key={feature.title} className={styles.row}>
              <h3 className={`${styles.rowTitle} sc-ink--blue`}>{feature.title}</h3>
              <p className="sc-copy">{feature.body}</p>
            </li>
          ))}
        </ul>
      </SpadeConsole>

      <SpadeConsole
        className={styles.console}
        crest="diamond"
        eyebrow="Getting Started"
        title="How Poker Arena Works"
        pill="Three"
        titleId="steps-heading"
        aria-labelledby="steps-heading"
        foot="foot"
      >
        <ol className={styles.steps}>
          {STEPS.map((step, index) => (
            <li key={step.title} className={styles.step}>
              <span className={`${styles.stepNumber} sc-ink--blue`} aria-hidden="true">
                {index + 1}
              </span>
              <div className={styles.stepBody}>
                <h3 className={`${styles.rowTitle} sc-ink--silver`}>{step.title}</h3>
                <p className="sc-copy">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </SpadeConsole>

      <SpadeConsole
        className={styles.console}
        crest="vip"
        eyebrow="Fair Gaming"
        title="Fair Play, In Writing"
        pill="Public"
        titleId="trust-heading"
        aria-labelledby="trust-heading"
        foot="foot"
      >
        <p className="sc-copy">
          Every Table Runs On A Server Side Shuffle With Collusion Detection And Anti Cheat
          Monitoring. The Rules Are Public: Read The Fair Gaming Standards, The Terms Of Service And
          The Privacy Policy Before You Sit Down.
        </p>
        <nav className={styles.links} aria-label="Poker Arena Resources">
          {RESOURCES.map((resource) => (
            <Link key={resource.to} className={`${styles.link} sc-ink--blue`} to={resource.to}>
              {resource.label}
            </Link>
          ))}
          <a className={`${styles.link} sc-ink--blue`} href={`${WEB_ORIGIN}/hub`}>
            Smarter.Poker World Hub
          </a>
        </nav>
      </SpadeConsole>

      <SpadeConsole
        className={styles.console}
        crest="flat"
        eyebrow="Poker Arena"
        title="Ready To Deal?"
        pill="Free"
        titleId="closing-heading"
        aria-labelledby="closing-heading"
        foot="plates"
        plates={{
          secondary: signInPlate(() => trackCta('sign_in', 'closing')),
          primary: createAccountPlate(() => trackCta('sign_up', 'closing')),
        }}
      >
        <p className="sc-copy sc-copy--center">
          Sign In To Poker Arena, Or Create A Free Account And Open Your First Club In Minutes.
        </p>
      </SpadeConsole>
    </main>
  );
}
