# How omnisens works

omnisens has two halves:

1. **The adapter firmware** applies a direction-dependent gain to every motion
   report (`firmware/src/omni_core.c`, mirrored in `web/js/omni-core.js`).
2. **The calibration tool** measures how far you over- or under-shoot when you
   flick in each direction and turns that into the gain table
   (`web/js/analysis.js`).

## 1. The directional gain engine

### Directions and the gain table

A profile is a table of `n` gains (1-16, default 8) spaced evenly around the
circle. Point `k` sits at angle `k * 360 / n` degrees, measured
counter-clockwise from "mouse moves right":

```
              90 Up (push away)
       135            45
180 Left       +       0 Right
       225            315
             270 Down (pull toward you)
```

Gains are stored as Q12 fixed point (4096 = 1.00x, legal range 0.10x-8.0x).

### Interpolation

Between points the gain is a periodic Catmull-Rom spline (or plain linear
interpolation if the `linear` flag is set). With `u = angle * n / 360`,
`k = floor(u)`, `t = u - k` and neighbours `p0..p3 = g[k-1..k+2]` (indices
modulo `n`):

```
g(t) = p1 + 0.5 t (p2 - p0 + t (2p0 - 5p1 + 4p2 - p3 + t (3(p1 - p2) + p3 - p0)))
```

The spline passes exactly through every configured value and is clamped to
`[min(g), max(g)]`, so it can never produce a gain more extreme than one you
entered.

### Which direction is the hand moving?

At 1000 Hz a slow or diagonal movement arrives as tiny reports like
`(1,0) (0,-1) (1,0) (1,-1)`. Taking the angle of each report on its own would
flip between 0 and 90 degrees and apply the wrong gains. The engine instead
keeps a smoothed direction vector `s` with an exponential window over the last
~L counts of travel:

```
m    = |d|                    (length of this report's raw delta d)
keep = L / (L + m)
s    = keep * s + d
theta = atan2(-s.y, s.x)
```

`L` is `smoothing_counts` (default 32, about 0.5 mm at 1600 DPI). Fast
movement (large `m`) makes the window short, so the direction follows quick
changes; slow movement averages over several reports. If the mouse has been
still for `reset_ms` (default 40 ms) the history is cleared, so a new stroke
starts with a fresh direction.

### Applying the gain

```
v   = g(theta) * d            scalar gain: changes how far, never which way
v   = R(rotation) * v         optional, 0 by default
v  += remainder               sub-count carry from earlier reports
out = round_half_away(v)
remainder = v - out
```

Because the gain is a scalar, a straight stroke stays straight; only its
length changes. The remainder carry means no motion is lost to rounding:
over any stroke the output total equals `g * input` to within one count, even
when every report is a single count.

With correction disabled (or the flag cleared) the adapter forwards deltas
untouched, so it is a transparent passthrough.

### Consequences worth knowing

* **Asymmetric gains are the point.** If you overshoot right by 8%, the right
  gain drops by about 7%. The side effect: moving right 10 cm and then left
  10 cm no longer returns the view to exactly where it started. Any scheme
  with different left and right sensitivities has this property; your hand
  compensates the way it does for any sensitivity. If that bothers you, use
  the tool's *tracking-safe* mode, which only allows corrections that are the
  same in opposite directions (`g(θ) = g(θ + 180°)`).
* **Tracking.** Direction smoothing keeps the gain steady during smooth
  tracking, and a reversal only uses the old direction's gain for the first
  ~L counts. By default the tool caps every gain at ±15%.
* **DPI.** Gains are ratios, so they hold at any DPI. Only `smoothing_counts`
  is in counts; the tool sets it from your DPI.
* **Polling rate.** The adapter is a full-speed USB device and host, so it
  forwards at most 1000 reports per second. An 8 kHz mouse still works, at
  1 kHz. Added latency is roughly one USB frame (up to 1 ms) on top of the
  mouse's own.

## 2. The calibration

The tool runs a SpiderShot-style flick task at your real game sensitivity
and measures, for every flick, how far the first ballistic movement carried
you compared with how far the target was. That ratio, by direction, is your
directional bias.

### The task

* **Rendering.** A 3D yaw/pitch camera with your game's field of view and
  degrees per count (from DPI, game and in-game sensitivity), so a flick
  needs the same hand movement as in your game.
* **Raw input.** Pointer Lock with `unadjustedMovement: true`, so the page
  gets raw counts without OS acceleration (Chrome, Edge and Firefox on
  Windows and macOS; Linux browsers fall back with a warning). Per-sample
  movement comes from `getCoalescedEvents()`.
* **Targets.** A centre target alternates with a peripheral target. Each
  round has 48 peripheral targets: 16 directions (22.5° apart, each jittered
  by up to ±11.25° so every angle gets covered) × 3 distances (8°, 16°, 28°),
  shuffled so consecutive targets are at least 45° apart. Target size scales
  with distance (diameter = distance / 7), which keeps difficulty constant so
  target size does not masquerade as a distance effect. Flicks back to the
  centre count too, with their own offset term in the model.
* **Length.** One warm-up round (discarded) plus 6 rounds by default, about
  as long as PureVector's five one-minute rounds plus some margin.

### Measuring one flick

1. Resample cumulative counts to 1 kHz and low-pass them with a zero-phase
   2nd-order Butterworth filter at 10 Hz (Roberts et al. 2024).
2. Movement onset: the speed passes 5% of its peak (Fradet et al. 2008),
   searched backward from the first major speed peak.
3. End of the primary submovement: scanning forward from peak deceleration,
   the first of a velocity reversal (overshoot), re-acceleration (undershoot
   followed by a correction), a braking discontinuity in jerk, or a stop,
   each sustained for 40 ms. These are the event types of Meyer et al. (1988)
   as operationalised by Roberts et al. (2024).
4. `ratio = (primary displacement along the target direction) / (distance
   to the target at onset)`. 1.0 is perfect, 1.08 is an 8% overshoot.
5. Rejected: reaction time under 100 ms or over 1 s, initial direction more
   than 30° off, primary shorter than 40 ms or longer than 600 ms, ratio
   outside 0.5-2.0, a gap in input longer than 30 ms mid-flick (mouse
   lifted), or already moving when the target appeared. The results screen
   lists how many flicks each rule removed.

### From flicks to gains

The model, fitted to `y = ln(ratio)` over all usable flicks:

```
y = μ + β·ln(D / D̄) + γ·[return flick] + Σ_{k∈K} (a_k cos kθ + b_k sin kθ)
```

* `β` absorbs the range effect (people overshoot short and undershoot long
  targets), so it is not mistaken for a directional effect.
* `μ`, your average over/undershoot, is reported but never corrected: a
  uniform bias is a general sensitivity matter, and the motor system
  re-adapts a global gain within about ten movements anyway (Pearson,
  Krakauer & Mazzoni 2010).
* The harmonic set `K` is chosen by BIC among {}, {1}, {1,2}, {1,2,3}
  (tracking-safe mode: {} or {2}). Limb inertia mainly produces the second
  harmonic (Gordon, Ghilardi & Ghez 1994); push/pull and left/right
  differences show up in odd harmonics.
* The fit is a robust M-estimate (Huber, then Tukey bisquare) with the noise
  scale estimated per distance band, since extent noise grows with distance.

**Evidence gate.** The correction is only applied if the direction terms are
jointly significant (Wald test, p < 0.01) *and* the curve replicates between
two halves of the data (split-half reliability ≥ 0.5, Spearman-Brown).
Otherwise the profile stays as it was, and the tool tells you so. You can
override it.

**Shrinkage and partial correction.** The direction coefficients are shrunk
toward zero (positive-part James-Stein, or a Gaussian prior with SD 0.03 when
there is a single harmonic), only 70% of the measured correction is applied
by default, and each gain is capped at ±15%. Direction-specific gain changes
are learned more slowly than one global change, so a cautious first step that
you can refine is better than an aggressive one.

```
ln g_new(θ) = ln g_base(θ) − λ · ĥ(θ)      λ = strength (default 0.7)
```

`g_base` is the profile that was active while you recorded (flat for a
fresh calibration, your current profile for *Refine*), and `ĥ` is the shrunk
directional part of the fit. The table is then shifted so its geometric mean
equals the base's, which keeps your overall sensitivity unchanged.

**Uncertainty.** The whole fit (model choice included) is repeated on 200
bootstrap resamples, stratified by direction and distance, to give the 90%
ranges shown next to every value.

### Refine and verify

* **Refine.** Calibrate again with the adapter active; the tool measures the
  bias that remains and updates the table multiplicatively. This is how you
  converge, and how you re-tune after changing grip, mousepad or DPI.
* **Blind A/B.** The verify mode alternates blocks with the correction on
  and off without telling you which is which, then compares how often your
  first movement lands on the target and how fast you hit. It is the honest
  way to find out whether this helps *you*.

### What is not known

Corsair and Aimlabs have not published how PureVector computes or applies
its profile (number of directions, interpolation, limits), and no
independent study of directional sensitivity correction exists yet. omnisens
is an independent design built from the motor-control literature below; it
is not a reimplementation of PureVector.

### References

* Meyer, Abrams, Kornblum, Wright & Smith (1988). Optimality in human motor
  performance. *Psychological Review* 95:340-370.
* Roberts, Burkitt & Elliott (2024). *Experimental Brain Research*,
  doi:10.1007/s00221-024-06784-0.
* Fradet, Lee & Dounskaia (2008). Origins of submovements during pointing
  movements. *Acta Psychologica*.
* Boudaoud, Spjut & Kim (2022). Mouse sensitivity effects in first-person
  targeting tasks. IEEE CoG, arXiv:2203.12050.
* Gordon, Ghilardi & Ghez (1994). Accuracy of planar reaching movements,
  parts I and II. *Experimental Brain Research* 99.
* Pearson, Krakauer & Mazzoni (2010). Learning not to generalize: modular
  adaptation of visuomotor gain. *Journal of Neurophysiology* 103:2938.
* Corsair, *How to use PureVector* and *PureVector: the future of aiming*
  (2026), for the behaviour omnisens is modelled on.
