# The console dialogs shed the metallic shell

2026-09-14. Branch `feat/felt-buy-in`, third commit. A fix to every felt
dialog that wears a console, found while checking the buy-in's corners at 2x.

`metallic-popups.css` dresses every element whose class ends in `-dialog`
(its `[class$='-dialog']` inventory, beside `-modal` and `-popup`) in a card
of its own: a `#111823` shell, a 1px edge, 16px corners and a 3px blue rail
along the top, all `!important`. The wait list, the time bank store, the
buy-in, the rebuy and the add-on each wrap their console in a `*-dialog`
element, so that card was painted behind the art and showed at the
chamfered corners as a second frame bolted on - three pixels of `#2d72d2`
sitting outside the chrome, easy to mistake for the master's own rail.

Every console dialog wrapper now carries `sc-dialog` beside its own class,
and `SpadeConsole.css` switches the shell off longhand by longhand at 0,2,0.
The cashier gets the same class on its own branch. The skill's §3.5 records
the trap and the check: look at a corner of the render at 2x before calling
a dialog done.

Verified on the rebuy at 393px: the wrapper computes to a transparent
background, no border, no radius, no shadow, and no pixel of the rail colour
within 60px of the console's corner.
