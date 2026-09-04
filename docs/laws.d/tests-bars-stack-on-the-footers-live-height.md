# tests/bars-stack-on-the-footers-live-height.law.test.ts

The footer publishes the height it occupies (--ca-bottom-chrome-h: measured while shown, 0px while scroll has hidden it or it is unmounted); --bottom-nav-stack-base IS that number and every fixed bar that stacks on the footer stacks on the base, never on the designed clearance, so it snap-locks to the bottom edge the frame the footer leaves (Dan 2026-09-04); page content keeps padding with the clearance
