# Play Poker Keeps Its Club Selector After Shortcut Removal

Integrating the protected removal of Poker Arena's bottom shortcut cards also removed the club selector used by the approved Play Poker entry. The combined compiler refused the undefined reference before push.

Give Play Poker its own memoized destination through the existing resolveTargetClub helper and current membership directory. Remembered eligible clubs retain priority, unions stay excluded, and no retired shortcut card returns. Existing resolver tests, the app compiler and the production Play Poker navigation case cover this path. No admission or financial writer changes.
