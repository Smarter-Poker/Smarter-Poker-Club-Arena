# Owner window for the paired-board receipt fix

#8138 (the PLO paired-board fold and the hold'em premium rule are signed by the
policy graph) merged at 07:15 UTC as 26dab2bac. The daily 04:00 Chicago window
was taken by the older queued release 63a25f18, which does not contain it, so
the receipt refusals would have continued for another day: the engine refuses
each paired-board fold as an invalid policy receipt and the horse snap-folds
through the zero-think-time fallback. Under Dan's order to make the fold rule
live when ready, one owner window names 26dab2bac. It uses the existing
last-hand notice, drain, freeze, certificate, rollback reserve and thaw,
expires within six hours and is spent once the containing engine serves.
