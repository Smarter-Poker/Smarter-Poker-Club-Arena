# Mission Ornament Has Its Own Clipping

The production Daily Missions journey passed in run 38970235866, including
the continuous-frame check. Its responsive companion found scroll overflow
inside the Monthly mission panel at 320px with 200 percent text.

The oversized corner ornament was still a pseudo-element on the card. Keeping
the card overflow visible for its aligned outer rail let that ornament add
41px to the panel's scroll bounds even though the polygon clipped its paint.
Give the ornament its own noninteractive clipped layer. Keep its existing
shape, state opacity, the card polygon, outer frame alignment, text and actions.
The production reflow assertion is unchanged.

An isolated render of the real ChallengeCard and imported styles reproduces
the overflow before the repair. Afterward, active, complete and claimed cards
retain zero offset on all four frame edges and the panel's scroll width equals
its client width. The existing source contracts guard the separate clipping
owner and preserve decorative hit-target exclusion. Required checks, protected
merge, publication and the production journey/reflow results are recorded in
the task's external evidence checkpoint.
