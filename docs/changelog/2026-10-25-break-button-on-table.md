# The Minimized Break Clock Stays On Its Table

The tournament break button was fixed above the viewport's bottom navigation, placing it over the action bar. Its artwork used only the open-ended console header, leaving a cut-off lower frame.

TablePage now passes its own table canvas ref through TableModalsLayer. The minimized break clock portals into that canvas and positions itself on the lower felt. Its width stays within the center lane, clear of the side-player plates on narrow desktop tables. Its complete frame uses the approved matching header and closing foot at their native ratios. Text scales with the button so small tables retain the same fitted labels.

Countdown, share, minimize, Escape and reopen behavior are preserved. No engine or database behavior changed.

Verification: focused unit and console contracts, including ownership of the portal and reopen behavior; real-component browser geometry at phone, tablet, desktop and short landscape sizes. The button stays inside the table and clear of the action bar, with a complete 1000:420 frame. The new regression assertions fail against the original component/styles.
