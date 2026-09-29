# The Diamond Games Can Be Heard And Felt

Date: 2026-09-26. Mobile spins programme, Phase 5 of 7. Client only: one service, three
scenes, the Mines board and two pages changed, two test files added and one moved with its
mechanism. No migration, no RPC, no money path, no fairness math touched.

## What was missing

The Diamond Spins wheel has a full score: a lever, a peg click on every seam that crosses
the pointer, a landing sting, and a buzz on the beats. Crash, Plinko, Donkey Cross and
Diamond Mines were nearly silent. The Crash page played the wheel's `playSpinStart` when a
round started and `playSpinMultiplierResult` when it booked, and the choice page played
`playSpinTick` and `playSpinMultiplierResult` on the crossing's beats. Plinko and Mines made
no game sound at all. On a phone the games did not feel physical.

Two defects came with the borrowed cues. `playSpinStart` starts an idling engine bed that
only the wheel's own chase (`playSpinTicking`) ever closes, so on the Crash page that bed
idled on under the flight and past it. And under reduced motion the crossing scene told a
street's beat twice: its reduced-motion effect committed the beat, and its frame loop then
found the same change and owed it again.

## What changed

**SoundService** gains a section of cues for the four games, built the way the rest of the
file is (oscillators, filtered noise, the master gain) and passed through one door,
`gameBeat`: a hidden tab plays and buzzes nothing; a per cue throttle absorbs a double fire;
the buzz goes through `vibrationGate` before the sound switch is asked, so a player who
plays muted still feels the beats and a player with vibration off feels nothing; the sound
then needs the master switch and a context. Like the spin cues, these stay out of the 50 ms
rank window, because they are movements of one scene rather than competitors for a felt's
frame. Short hits share one cached noise grain instead of filling a buffer each time.

Continuous sound is one reused voice per source: `driveCrashEngine(cents)` and
`driveCrossingCar(closeness)` build their voice on the first call and afterwards only write
AudioParam targets, and only when the target has moved. A voice stops on request, when
sound is switched off mid flight (the switch is read at most four times a second) and on a
hidden tab (the service's own visibility listener stops every voice).

**Crash** (`CrashCurve.tsx`). The engine starts on the first open frame and rises in pitch,
and a little in level, with the multiplier that frame printed, on a log scale (about two
octaves by 25x). It stops on the frame the round ends, on unmount and when the tab is
hidden. A crash is a burst (a crack, a falling thump and a rumble) with the strong buzz. A
cash-out is the booked sting with the medium buzz, and a round booked at the cap, whose
cash marker reads "Max", gets a gold brass fanfare with the jackpot buzz instead. Each
ending sounds once, on the frame that draws it; a resize that rebuilds the loop never sounds
it again, and a round that was already over when the scene appeared is not announced.

**Plinko** (`PlinkoBoard.tsx`). A soft chrome tick for each peg a diamond strikes, pitched by
row, at most one every 30 ms on the frame clock however many diamonds fall (the service
holds the same limit). A clink for each landing, brighter the more the bucket pays; a batch
that lands together on one frame (reduced motion) is one clink at its best bucket. A plain
landing is a light buzz; a big win (5x or better) adds a gold sparkle and the jackpot buzz.

**Donkey Cross** (`ChoiceScene.tsx`). Four hoof steps on each walk, on the gait's own clock.
The car coming to the street is one engine voice that grows as it closes; past the point
where a safe street and a hit part, a safe car's tyres squeal as it brakes and the other
sounds its horn. The beats are played in the scene's `commit`, the same door that tells the
page, so they land on the frame that shows them: a landing is a light tick and a light buzz,
a hit is the impact with the strong buzz (with the horn folded in when there was no approach
to sound it), a booked win is the booked sting at that street's multiplier. Reduced motion
keeps every beat and drops only the motion sounds. The loop no longer re-owes a change the
reduced-motion path has already shown, so each beat is told once.

**Diamond Mines** (`MinesGrid.tsx`). On the render that turns a tile: a crystalline chime
for a gem, climbing a pentatonic ladder with each gem found this round, with a light buzz; a
blast for the mine with the strong buzz; the booked sting for a win at the multiplier it
paid. A board that mounts on a round in progress, and a new round, start silently.

**The pages.** Every beat has one owner. The Crash page no longer plays `playSpinStart` at
the start tap or the cash-out chord and buzzes at settle; the scene does. The choice page's
`onMoment` no longer plays a tick, a chord or a buzz for the crossing, and the page no longer
buzzes a Mines answer, since the board now does. The taps themselves keep their buzz, because
a tap is the one place an iOS switch haptic is granted.

## Tests

`tests/components/DiamondGamesSound.test.tsx` (19) mocks the service and drives each scene's
frame loop: the Crash engine follows the multiplier frame by frame, stops on a crash, a
cash-out, unmount and a hidden tab and resumes after it, and each ending is asked for once,
held until its frame is drawn, never repeated on a resize and never played for a round
already over; Plinko ticks every row of a drop once in order, rate limits a falling batch to
one tick every 30 ms and lands a reduced-motion batch as one beat; the crossing steps four
times, brings the car in and squeals it before the landing, horns before the impact, books
at the street's multiplier, keeps every beat once under reduced motion and silences the car
on unmount; Mines chimes each gem one step higher, blasts once, books once and stays silent
for a round in progress.

`tests/unit/diamondGameCues.test.ts` (20) runs the real service on a fake AudioContext: the
engine builds its oscillators once and only writes rising targets afterwards, stops on
request, on a mid-flight mute and on a hidden tab; the car is its own voice; the peg tick is
limited to one every 30 ms; every beat buzzes once with its own pattern through the gate;
muted sound keeps the buzz and plays nothing; vibration off keeps the sound and never buzzes;
a muted gate and a hidden tab play nothing at all.

`tests/components/DiamondChoiceAutoSettle.test.tsx`: the five cases that pinned the page
playing the crossing's sounds and buzzes (and the Mines answer buzz) now pin that the page
plays none of them, because that mechanism moved into the scene in this change.
