/**
 * PAGE HELP - THE "?" IN THE TOP RIGHT OF EVERY PAGE (Dan, 2026-10-17)
 *
 * Dan, verbatim: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL DESCRIPTIONS
 * THAT EXIST LIKE THIS ON ANY AND ALL PAGES. ADD A ? MARK ICON INSTEAD IN THE
 * UPPER RIGHT CORNER OF THE PAGES THAT CAN EXPLAIN ANYTHING AND ALSO LAUNCH A
 * TUTORIAL AT THE BOTTOM WHEN CLICKED. ALL THESE WORDS ARE DISTRACTING AND
 * MAKES IT HARDER TO USE THE SITE, WE NEED TO SIMPLY PAGES."
 *
 * Every page hero used to print an eyebrow, a giant title and a paragraph that
 * explained the page before the player could reach anything on it. The words
 * moved in here. The page shows its live controls; the explanation is one tap
 * away and never in the way.
 *
 * THE ICON IS PAINTED, NOT DRAWN. `header-help-v4.png` is the approved chrome
 * "?" in a ring from the global header family. A glyph or a CSS circle would
 * be the floating-icon overlay the #ClubArenaConsole standard forbids.
 *
 * THE TUTORIAL LIVES AT THE BOTTOM. Step one explains the page. "Start
 * Tutorial" walks the rest: each step can name a part of the page, which is
 * scrolled into view and lit while its step is showing, so the tour points at
 * the real control rather than describing it from a distance.
 *
 * Steps come from, in order: a curated tour for the route (pageTutorials.ts),
 * the steps the page passed in, or a tour built from the page itself - the
 * sentences of its explanation, then each section heading on the page.
 */
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { mediaUrl } from '../../utils/mediaBase';
import { titleCase } from '../../utils/titleCase';
import { tutorialForPath, type TutorialStep } from './pageTutorials';
import './PageHelp.css';

export type { TutorialStep } from './pageTutorials';

export interface PageHelpProps {
  /** The page's name. Shown on the first step, never on the page itself. */
  title: string;
  /** What the page is for. This is the text the hero used to print. */
  summary?: string;
  /** Hand-written steps for this page, used when no curated tour exists. */
  steps?: TutorialStep[];
  /** Extra class for positioning when the help sits outside a PageBar. */
  className?: string;
}

const FOCUS_ATTR = 'data-tutorial-focus';
const MAX_SECTION_STEPS = 6;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (!html.isConnected) return false;
  const rect = html.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * A tour built from the page in front of the player: its section headings, in
 * reading order. Headings inside a list row, a dialog or the help itself are
 * row labels, not sections, and are skipped.
 */
function sectionSteps(root: Element | null, pageTitle: string): TutorialStep[] {
  if (!root) return [];
  const seen = new Set<string>([pageTitle.trim().toLowerCase()]);
  const steps: TutorialStep[] = [];
  for (const heading of Array.from(root.querySelectorAll('h2, h3'))) {
    if (steps.length >= MAX_SECTION_STEPS) break;
    if (heading.closest('li, [role="dialog"], [data-page-help], .ca-page-bar')) continue;
    if (!isVisible(heading)) continue;
    const text = (heading.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 48) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const section = heading.closest('section, article, [class*="section"], [class*="panel"]');
    const lead = section?.querySelector('p');
    const leadText = (lead?.textContent || '').replace(/\s+/g, ' ').trim();
    const body =
      leadText.length >= 20 && leadText.length <= 200
        ? leadText
        : `This Is Where You Find ${titleCase(text)}.`;

    steps.push({ title: titleCase(text), body: titleCase(body), target: heading });
  }
  return steps;
}

function resolveTarget(target: TutorialStep['target']): Element | null {
  if (!target) return null;
  if (typeof target !== 'string') return target.isConnected ? target : null;
  try {
    const found = Array.from(document.querySelectorAll(target)).find(isVisible);
    return found ?? null;
  } catch {
    return null;
  }
}

/**
 * The route, read without demanding a router. The help also renders on the
 * prerendered static pages and in isolated component renders, where there is
 * no router and useLocation() would throw; there it reads the address bar.
 */
function usePathname(): string {
  const routed = useContext(UNSAFE_LocationContext)?.location?.pathname;
  if (routed) return routed;
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

export default function PageHelp({ title, summary, steps, className }: PageHelpProps) {
  const pathname = usePathname();
  const panelId = useId();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [tour, setTour] = useState<TutorialStep[]>([]);

  const pageTitle = titleCase(title);

  /* The first step is always the explanation the hero used to print. */
  const intro = useMemo<TutorialStep>(() => {
    const sentences = summary ? splitSentences(summary) : [];
    return {
      title: pageTitle,
      body: titleCase(sentences[0] ?? `Here Is How ${pageTitle} Works.`),
    };
  }, [pageTitle, summary]);

  const buildTour = useCallback((): TutorialStep[] => {
    const curated = tutorialForPath(pathname);
    let body: TutorialStep[];
    if (curated && curated.length > 0) {
      body = curated;
    } else if (steps && steps.length > 0) {
      body = steps;
    } else {
      const rest = (summary ? splitSentences(summary) : [])
        .slice(1)
        .map((sentence) => ({ title: pageTitle, body: titleCase(sentence) }));
      const root =
        buttonRef.current?.closest('main, [data-page-root]') ??
        buttonRef.current?.closest('.ca-page-bar')?.parentElement ??
        null;
      body = [...rest, ...sectionSteps(root, pageTitle)];
    }
    return [
      intro,
      ...body,
      {
        title: 'You Are All Set',
        body: 'Tap The Question Mark In The Top Right Any Time To See This Again.',
      },
    ];
  }, [intro, pathname, pageTitle, steps, summary]);

  const clearFocus = useCallback(() => {
    document.querySelectorAll(`[${FOCUS_ATTR}]`).forEach((el) => el.removeAttribute(FOCUS_ATTR));
  }, []);

  const close = useCallback(() => {
    clearFocus();
    setOpen(false);
    setIndex(0);
    buttonRef.current?.focus({ preventScroll: true });
  }, [clearFocus]);

  const openHelp = useCallback(() => {
    setTour(buildTour());
    setIndex(0);
    setOpen(true);
  }, [buildTour]);

  /* Light the step's part of the page, and bring it into view. */
  useEffect(() => {
    if (!open) return;
    clearFocus();
    const el = resolveTarget(tour[index]?.target);
    if (!el) return;
    el.setAttribute(FOCUS_ATTR, '');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    (el as HTMLElement).scrollIntoView?.({
      block: 'center',
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [open, index, tour, clearFocus]);

  /* Escape closes; the panel takes focus so a keyboard can drive it. */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  /* Leaving the page ends the tour and never leaves a lit element behind. */
  useEffect(() => {
    setOpen(false);
    clearFocus();
  }, [pathname, clearFocus]);
  useEffect(() => clearFocus, [clearFocus]);

  const step = tour[index];
  const last = index >= tour.length - 1;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className ? `ca-page-help ${className}` : 'ca-page-help'}
        aria-label="Page Help"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : openHelp())}
        data-page-help=""
      >
        <img
          className="ca-page-help__icon"
          src={mediaUrl('images/header-help-v4.png')}
          alt=""
          width={36}
          height={37}
          draggable={false}
        />
      </button>
      {open &&
        step &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            className="ca-tutorial-popup"
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            tabIndex={-1}
            data-page-help=""
          >
            <div className="ca-tutorial-popup__meta">
              <span className="ca-tutorial-popup__count">
                {index === 0 ? 'About This Page' : `Step ${index} Of ${tour.length - 1}`}
              </span>
              <button
                type="button"
                className="ca-tutorial-popup__close"
                aria-label="Close Help"
                onClick={close}
              >
                Close
              </button>
            </div>
            <h2 id={titleId} className="ca-tutorial-popup__title">
              {step.title}
            </h2>
            <p className="ca-tutorial-popup__body">{step.body}</p>
            <div className="ca-tutorial-popup__dots" aria-hidden="true">
              {tour.map((s, i) => (
                <span
                  key={`${s.title}-${i}`}
                  className={
                    i === index
                      ? 'ca-tutorial-popup__dot ca-tutorial-popup__dot--on'
                      : 'ca-tutorial-popup__dot'
                  }
                />
              ))}
            </div>
            <div className="ca-tutorial-popup__actions">
              {index > 0 ? (
                <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))}>
                  Back
                </button>
              ) : (
                <button type="button" onClick={close}>
                  Got It
                </button>
              )}
              {last ? (
                <button
                  type="button"
                  className="ca-tutorial-popup__primary"
                  onClick={close}
                >
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  className="ca-tutorial-popup__primary"
                  onClick={() => setIndex((i) => Math.min(tour.length - 1, i + 1))}
                >
                  {index === 0 ? 'Start Tutorial' : 'Next'}
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
