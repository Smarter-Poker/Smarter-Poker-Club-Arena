# A Last-Table Park The Door Left Continues From Its Never-Started Hand

After `20260927145416`, the abandoned-generation door closed 41eb379e's
never-started hand 14656452 (16:25 UTC) and left its dead generation's own
pre-manifest park for the successor, which claimed its custody. 41eb379e is a
Spin: that table is the event's last open table, so the park cannot begin, and
the only exit, `fn_f06_continue_no_start_last_table`, required the origin's
custody and the origin's own cancellation as the never-started witness. The
continuation now also accepts the successor holding the custody when the
door's receipt lists that park as left and that permit as never started.
Migration `20260927163617`. No money moves.

## The Holder Rule Follows The Live Lease

The first body admitted only the generation named in the park's custody
(3871b71a). That generation died as well: engine `e6b9dc5d` adopted 41eb379e at
20:56 UTC as `f798e8e0`, the park still names 3871b71a at revision 1, and the
engine logged `F06_CONTINUATION_EXACT_PREMANIFEST_PARK` for table b386a410 on
every pass. The continuation now admits the event's live lease holder (already
fenced by `f06_prefix`), never the origin the door closed, and only while no
other generation holds a lease. Proved on a local PostgreSQL 17 loaded with
the production rows in that exact shape: the live body and the first body both
refuse; the new body continues, withdraws the park and writes one receipt with
credit 0; the origin as caller, a foreign lease and a chip moved between chairs
refuse; a replay returns the stored receipt. The three players keep 240, 270
and 390 chips.
