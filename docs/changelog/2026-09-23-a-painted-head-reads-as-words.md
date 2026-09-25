# A painted head reads as words (2026-09-23)

`ZoneText` in `src/components/console/SpadeConsole.tsx` now closes its own text
with a space, so a console head's text content is words rather than one word.

## What it read as

Every zone in a #ClubArenaConsole head is `position: absolute`, measured off
the master art. What the eye reads as

```
TOURNAMENT
LOBBY                                    [IN GAME]
```

is four DOM siblings printed inches apart on screen and immediately adjacent in
the markup, with nothing at all between them. The tournament lobby's panel
therefore had a text content of `TournamentLobbyIn Game`.

Nobody sees that, which is exactly why it survived a console sweep: it is what
a screen reader announces, what a copy and paste produces, and what an end to
end check reads. `tests/e2e/tournament-watch.spec.ts` asserts
`toContainText(/Tournament Lobby/i)`, and that assertion could not pass on any
painted head no matter how correct the page was. The client half of the
post-deploy audit has been reporting it as a page defect since the console
landed.

## The fix

```tsx
<span ref={ref}>{text}</span>{' '}
```

`.sc-zone` is `display: grid`, and a grid container does not render a child
text run that is only white space. The separator is therefore in the DOM, where
text is read, and in no box at all, so it moves no pixel and changes no
measurement. It is a sibling of the fitted span rather than inside it, because
`useFitText` measures that span and a trailing space inside it would be
measured too.

## What is pinned

`tests/components/consoleHeadReadsAsWords.test.tsx` renders a real console and
a real `TournamentLobbyModal` and holds both halves at once: the head's text
separates every zone, and the line actually printed into each zone is still
exactly its label with nothing appended. Without the second half the obvious
fix (appending a space to `text`) would pass while quietly widening every
fitted line in the app.

## What was already fixed

The two-axis 44px touch floor on Club Data and the rake snapshot panel, which
the same post-deploy run reported, landed on main in #5109 and #5112. Only the
head's text was left.
