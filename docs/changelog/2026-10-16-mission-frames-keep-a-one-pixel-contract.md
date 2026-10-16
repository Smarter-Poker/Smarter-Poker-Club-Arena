# Mission frames keep a one-pixel contract

Post-deploy run 38955915461 stopped at the Daily Missions frame oracle because
an independently rounded pair of DOM rectangle coordinates produced an edge
offset of 1.0001220703125 CSS pixels. The previous equivalent journey passed on
unchanged mission source and assertion inputs. Live read-only inspection found
one-pixel card borders, zero frame insets, six painted rail layers and exact
one-pixel resting offsets. The visible frame and its styles are unchanged.

The measurement now independently checks the computed CSS layout gap against
the same strict one-pixel limit. Its viewport comparison permits only one
single-precision coordinate ULP, derived from viewport and document positions
and capped below 0.001 CSS pixel. An independent frame transform is refused.
This prevents coordinate roundoff from failing correct geometry without
accepting a real CSS inset beyond one pixel or a displaced viewport edge.

Focused cases retain the observed roundoff failure, exact and scrolled edges,
real layout gaps as small as 1.00001 pixels, visible displacements beyond the
roundoff bound, large offscreen coordinates and malformed readings. Rail,
animation, mission outcomes, reward settlement, lifecycle, cleanup and all
other production assertions remain intact. No product CSS, financial behavior,
engine code or Club Bank Transaction Ledger behavior changes.
