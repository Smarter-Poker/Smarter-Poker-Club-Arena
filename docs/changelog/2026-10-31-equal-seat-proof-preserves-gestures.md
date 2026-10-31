# Equal Seat Proof Preserves Gestures

The production browser check now compares the layout dimensions of the avatar, name/chip panel and action caption, retaining transformed visual bounds in its evidence. A folded avatar intentionally slumps to 97% through the existing choreography; measuring that posture as a size rule caused a false 2.07px inequality. No player sizing or animation was changed. The proof closes table chat before capturing its table screenshot.

Validation: focused source contracts, TypeScript and existing folded-avatar browser regressions; publication and exact served browser proof remain required.
