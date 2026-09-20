# The purchase ledger shows the answer to the question actually asked

Debouncing the club shop's purchase search stopped a request per keystroke, and
in doing so it made a second request possible while the first is still in the
air: a pause fires, and the reply to the earlier page or the earlier search is
still travelling. Nothing ordered those replies. The older one was free to land
second and overwrite the table.

That matters on this screen more than on most. The refund control is drawn
inside the row and reads its purchase id off it, so rows the admin never asked
for arriving underneath those buttons is a money question, not a cosmetic one.
Every request now takes a ticket, and only the newest may write to the table.
A superseded reply is dropped, and a superseded failure no longer raises a
toast or drops an error banner over rows that had loaded perfectly well.

Two smaller corrections follow from the same gap. The empty-state sentence
asked about the text in the box when the rows on screen answer the debounced
search, so a search that found nothing could be described as an empty ledger
during the pause; it now reads the search the rows actually answer. And the
pager is held while the box and the rows disagree, because paging in that gap
asks the server for an offset into a list that is about to be replaced.

Pinned by `tests/the-ledger-shows-the-answer-to-the-question-asked.test.tsx`,
which lands the replies out of order and fails on the previous code: two
tests, both red without the ticket, the second naming the symptom exactly
("expected vi.fn() to not be called at all, but actually been called 1 times" -
the alarm raised by a request nobody was waiting on).

No endpoint, query, permission or refund rule changes.
