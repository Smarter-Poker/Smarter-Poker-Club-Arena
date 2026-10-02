/**
 * AN IN-APP NAVIGATION ASKS BEFORE IT DESTROYS UNSAVED WORK (2026-09-20).
 *
 * Table Management protects an operator's unsaved ticker or club-message draft
 * three ways: switching sections asks, closing the tab asks (beforeunload), and
 * a click on an in-app link asks. The hamburger menu was believed to be the
 * third case, and it is not: every entry in it is a <button> that calls
 * navigate(), so the page's link guard never saw the click and the draft was
 * thrown away without a word.
 *
 * This is the one door a button-driven navigation can ask at. A page holding
 * work registers a question while the work is dirty; a navigator that is about
 * to leave the page asks it first. At most one page holds the door at a time,
 * and releasing it only releases the holder that registered.
 */
type LeaveQuestion = () => boolean;

let holder: LeaveQuestion | null = null;

/** Hold the door while `question` guards unsaved work. Returns the release. */
export function holdInAppNavigation(question: LeaveQuestion): () => void {
  holder = question;
  return () => {
    if (holder === question) holder = null;
  };
}

/** True when nothing is held, or the holder agreed to let the operator leave. */
export function mayLeaveCurrentPage(): boolean {
  return holder ? holder() : true;
}
