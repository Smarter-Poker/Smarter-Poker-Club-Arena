/**
 * THE WHEEL NEVER SPINS TWICE UNATTENDED (2026-09-22).
 *
 * Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
 * ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY." So a won game starts itself,
 * plays itself and returns to the wheel, and the wheel's idle countdown spins
 * by itself after thirty seconds. Put together, an open tab with nobody at it
 * went round for ever: idle spin, won game, back to the wheel, the countdown
 * armed again on the new mount, another 100 diamonds, until the daily cap.
 * Observed live on 2026-09-21: the countdown re-armed after the auto-return.
 *
 * The rule: an automatic spin never follows an automatic spin with no player
 * input in between. Won games still start and play by themselves, the Spin
 * button and the Auto Spin run the player starts are untouched; the only thing
 * withheld is a second unattended idle spin of the wheel.
 *
 * This is the one fact that rule needs: "the last wheel spin was automatic, and
 * nobody has touched the page since". It lives in session storage so a reload
 * inside the same tab keeps it, with a copy in memory for a browser that will
 * not store it. Any real input anywhere in the document (pointer, key, touch)
 * clears it, whatever page the player is on at the time.
 */

const KEY = 'diamond-spins-unattended';

/** The answer, for when session storage cannot hold it. */
let memory = false;
/** Session storage took the last write, so it holds the answer. */
let stored = false;
let installed = false;
const listeners = new Set<() => void>();

function write(on: boolean): void {
  memory = on;
  try {
    if (on) window.sessionStorage.setItem(KEY, '1');
    else window.sessionStorage.removeItem(KEY);
    stored = true;
  } catch {
    stored = false;
  }
  listeners.forEach((listener) => listener());
}

function present(): void {
  if (unattended()) write(false);
}

/** One capture-phase listener per document, for as long as the app runs. */
function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const)
    document.addEventListener(type, present, { capture: true, passive: true });
}

/** The idle countdown just spun the wheel by itself. */
export function noteAutomaticSpin(): void {
  install();
  write(true);
}

/** The last wheel spin was automatic and nobody has touched the page since. */
export function unattended(): boolean {
  install();
  try {
    if (window.sessionStorage.getItem(KEY) === '1') return true;
    return stored ? false : memory;
  } catch {
    return memory;
  }
}

/** Called whenever unattended() may have changed. Returns the unsubscribe. */
export function onPresenceChange(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
