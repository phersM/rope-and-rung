# Pushup form storyboard — asset record

**What this is.** A four-panel chalk storyboard of one pushup, shown in the app behind
"What counts as one" so a crew running on the honour system shares one definition of a rep.

| file | what it is |
|---|---|
| `design/pushup-form/master-v1-20260922.png` | the generator's original, 1672x941, untouched |
| `assets/pushup-form.jpg` | what the app loads — 1600x900, q82, 319KB |

Generated 2026-09-22 by the owner in ChatGPT's image generator from the v1 prompt below.
Not photographed, not traced from a licensed source, so there is nothing to clear.

---

## v1 — what shipped into the archive

See `prompt-v1.txt`. It produced the master above: four panels, chalk on a dark board,
consistent ground line, dashed body-line guide in panel 1.

## Verdict on v1 (owner + review, 2026-09-22)

Owner: lines too thin; **"its missing the bit where shoulders should be turned out at the
elbow — gives a better pushup foundation"**. That is the whole job of panel 2 and it did not
land: the arms read as plain straight arms with two ambiguous scribbles at the elbows.

Also wrong, from review:

1. **Dead board.** The panels occupy the middle third; the top and bottom 30% are empty. On a
   phone that makes every figure tiny.
2. **Scale drifts.** Panel 2's figure is noticeably larger than panels 1, 3 and 4.
3. **Panel 4 is lying on the floor.** It should be the bottom of the rep — chest at about fist
   height, elbows tucked, body still one straight line. As drawn it reads as a rest, and the
   arms are barely legible.
4. **Necks droop.** Panels 1 and 3 have the chin dropped to the chest; the neck should continue
   the body line, gaze just ahead of the hands.
5. **Hands and feet are stumps**, which matters most in panel 2 where the hand position is the
   point.
6. **Contour lines on the torso** in panel 2 read as muscle shading — the brief said outline only.
7. **The dashed guide line appears once.** It should also appear at the bottom position, where
   holding the line is hardest and most often faked.

## v2 — the prompt to run next

See `prompt-v2.txt`. Changes: much thicker chalk, panels fill the frame, one locked figure
height, a rebuilt panel 2 that actually shows external rotation (hands screwing outward into
the floor, elbow pits forward, elbows pointing back at 45 degrees), a corrected bottom
position, and the guide line repeated at the bottom.

**Portrait variant.** The app opens this full screen on a phone, and a 16:9 strip is small
there — the app rotates it to fill the screen in portrait, which works, but a 2x2 grid at 4:5
would read better still. `prompt-v2.txt` carries that variant at the bottom.

## Where it is used

`#form-sheet` in `index.html` — "What counts as one", opened from the link under the log
actions. The sheet also carries a **drawn, animated** side view of the rep: the pose is solved
(two-link inverse kinematics, `pfBody`/`pfUpper`/`pfFore` in `style.css`) so the hand never
slides off the floor, the body swings 28.7 to 10 degrees, and the elbow closes to 50 — chest
at fist height. That animation is the app's own vector work, not generated: it is ~2KB, sharp
at any size, works offline, and the form in it is exactly what the rules say.

The still storyboard and the animation do different jobs and both earn their place: the
drawing shows what a body looks like in each position, the animation shows the movement.
