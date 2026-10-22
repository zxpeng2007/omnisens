# omnisens

**Per-direction mouse sensitivity for any mouse.** An open-source take on the
directional sensitivity behind Corsair's *PureVector*: measure how much you
over- or under-shoot when you flick in each direction, then let a tiny USB
adapter correct it in hardware, in every game, with nothing running on your PC.

[![CI](https://github.com/zxpeng2007/omnisens/actions/workflows/ci.yml/badge.svg)](https://github.com/zxpeng2007/omnisens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Calibration tool:** https://zxpeng2007.github.io/omnisens/ &nbsp;·&nbsp;
**Firmware:** [how to get it](#quick-start) &nbsp;·&nbsp;
**Hardware:** [docs/HARDWARE.md](docs/HARDWARE.md)

> **Status: early, not yet tested on real hardware.** The firmware builds in
> CI and its core logic (direction engine, HID descriptor parser, flash
> storage) is unit-tested, and the calibration maths is tested against
> simulated players, but nobody has run the adapter with a real mouse yet.
> Expect rough edges and please report what works and what does not (see
> [CONTRIBUTING.md](CONTRIBUTING.md)).

---

## The idea

Corsair's [SABRE v3 PRO PureVector](https://www.corsair.com/us/en/p/gaming-mouse/CH-931G400-WW/sabre-v3-pro-purevector-ultralight-wireless-gaming-mouse-ch-931g400-ww)
calibrates in Aimlabs: you flick at targets for about five minutes, it works
out how much you over- or under-aim in each of eight directions, and it saves
a per-direction sensitivity profile to the mouse's firmware. As
[DiamondLobby's short](https://www.youtube.com/shorts/6OZWJPcAX6A) puts it,
it is like having separate X and Y sensitivities, but for more directions.

That only works on one mouse line. omnisens does the same job for **any**
USB mouse, wired or wireless:

```
 ┌──────────────┐  flick test in the   ┌────────────────────┐
 │ web tool     │  browser, at your    │ 8 directional       │
 │ (this repo)  │─ game sensitivity ──▶│ values (and a 16-   │
 └──────────────┘                      │ point profile)      │
                                       └─────────┬──────────┘
                                                 │ WebHID
 mouse ──USB──▶ [ $4-18 RP2040/RP2350 adapter ] ─┴──USB──▶ PC
                 applies the per-direction gain
                 to every report, in hardware
```

1. **The firmware** (`firmware/`, under 100 KB) runs on a Raspberry Pi Pico or
   a ready-made USB host board. It sits between the mouse and the PC, scales
   each motion report by a gain that depends on the direction you are moving,
   and forwards it. Out of the box it is a transparent passthrough.
2. **The calibration tool** (`web/`, runs in the browser, no install) is a
   SpiderShot-style flick test at your real game sensitivity. It measures the
   first ballistic movement of every flick, fits your directional bias, and
   gives you the values. With an adapter connected it writes them to it.

## Quick start

1. **Get an adapter.** Easiest: an
   [Adafruit Feather RP2040 USB Host](https://www.adafruit.com/product/5723).
   Cheapest: a Raspberry Pi Pico plus a USB-A socket (four wires). Options and
   wiring: [docs/HARDWARE.md](docs/HARDWARE.md).
2. **Flash it.** Hold BOOTSEL while plugging it in, then drag the matching
   `omnisens-<board>.uf2` onto the drive that appears. Until the first
   release is published, get the `.uf2` from the latest successful
   [CI run](https://github.com/zxpeng2007/omnisens/actions/workflows/ci.yml)
   (Artifacts section, GitHub sign-in needed) or build it
   ([docs/BUILDING.md](docs/BUILDING.md)).
3. **Plug in:** mouse → adapter → PC. It should behave like your normal mouse.
4. **Calibrate.** Open the [calibration tool](https://zxpeng2007.github.io/omnisens/)
   in Chrome or Edge, enter your DPI, game and in-game sensitivity, connect
   the adapter, and flick for five to eight minutes.
5. **Apply.** Review your values, press *Send to adapter*, then *Save*. The
   profile lives on the adapter; nothing runs on your PC while you play.

**No adapter?** The tool still finds your values. On Windows it can export
them as a [Raw Accel](https://github.com/RawAccelOfficial/rawaccel) profile;
Raw Accel can only scale right/left/up/down separately, so that version
approximates the diagonals.

## Your values

The result is a sensitivity multiplier for each direction you move the
mouse, for example:

| Direction | Multiplier |
|---|---|
| Right | 0.962× |
| Up-right | 0.981× |
| Up (push away) | 1.024× |
| Up-left | 1.031× |
| Left | 1.018× |
| Down-left | 0.996× |
| Down (pull toward you) | 0.991× |
| Down-right | 0.999× |

Here the player overshoots when flicking right, so right gets about 4% less
sensitivity, and undershoots up-left, so that direction gets a bit more.
Values are relative to your current sensitivity and their geometric mean
stays at 1.0, so your overall sensitivity does not change. The adapter
interpolates smoothly between directions (the tool sends 16 points by
default; the firmware's flat factory profile has 8).

## How it works, briefly

* **Direction, not axes.** Each report's motion vector is scaled by one gain
  `g(θ)`, so a straight flick stays straight; only its length changes. The
  direction comes from a short travel-weighted average, so 1-count reports at
  1000 Hz don't make the gain flicker. Sub-count remainders carry over, so no
  motion is lost.
* **Measuring bias.** For each flick the tool finds the end of the first
  ballistic movement (Meyer et al. 1988; Roberts et al. 2024) and compares its
  length with the target distance. A robust Fourier fit across directions
  separates real directional bias from the range effect and random scatter.
* **Being careful.** The tool only applies a correction when the pattern is
  statistically clear *and* replicates across halves of your data. It applies
  70% of the measured correction by default, changes no direction by more
  than roughly ±15% per calibration, and never changes your average
  sensitivity. A
  *tracking-safe* mode only makes corrections that are equal in opposite
  directions, so strafe tracking stays consistent.
* **Checking it.** *Refine* re-measures with the profile active.
  *Blind A/B* runs blocks with the correction on and off in a random,
  balanced order without telling you which is which, then shows whether your
  flicks actually improved.

Details and references: [docs/ALGORITHM.md](docs/ALGORITHM.md). USB
interfaces and the configuration protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).
Building: [docs/BUILDING.md](docs/BUILDING.md).

## omnisens vs. PureVector

| | PureVector | omnisens |
|---|---|---|
| Mice | SABRE v3 PRO PureVector series | any USB mouse or receiver |
| Where the profile lives | mouse firmware | adapter firmware |
| Calibration | Aimlabs (Steam account) | browser, no account |
| Directions | 8 (as shown in Corsair's graphs) | 8 values shown, up to 16 interpolated points |
| Values visible and editable | shown as a graph; editing not documented | yes |
| Polling rate | up to 8 kHz | up to 1 kHz through the adapter |
| Cost | the mouse | about $4-18 for the adapter |
| Algorithm | not published (Corsair describes it as patented) | open, documented, unit-tested (not yet validated with players) |

omnisens is an independent project built from public motor-control research.
It is not a reimplementation of PureVector, and nobody (including Corsair)
has published independent evidence that directional correction improves
aim. The blind A/B mode is there so you can find out for yourself.

## Fair play

omnisens is a separate USB device that changes mouse input. It does not aim
for you, read the game or add inputs: everything it sends is your own mouse
movement and clicks, with the movement scaled by a fixed per-direction
profile. Even so:

* **Tournaments and leagues:** competitive rulebooks (for example Riot's VCT
  rules and ESL's rulebooks) generally allow only approved equipment, and an
  inline input-modifying adapter is very unlikely to be approved. Ask the
  organiser first.
* **Online play:** the adapter identifies itself on USB as an "omnisens
  adapter" with its own USB IDs. It does not hide from or impersonate
  anything, and a game's anti-cheat may treat it like any other
  input-modifying device. No game, league or anti-cheat vendor has approved
  it.

Check the rules of each game, platform and event before using it, including
in casual or ranked online matchmaking. You are responsible for how you use
it. This section is not legal advice.

## Related projects

* [hid-remapper](https://github.com/jfedor2/hid-remapper): general-purpose
  RP2040 input remapper; omnisens learned a lot from its PIO-USB setup.
* [Raw Accel](https://github.com/RawAccelOfficial/rawaccel): Windows
  acceleration driver with per-axis and left/up multipliers.
* [Pico-PIO-USB](https://github.com/sekigon-gonnoc/Pico-PIO-USB) and
  [TinyUSB](https://github.com/hathach/tinyusb), which make the adapter
  possible.

## License

MIT, see [LICENSE](LICENSE). The firmware links pico-sdk (BSD-3-Clause),
TinyUSB (MIT) and Pico-PIO-USB (MIT), and `ws2812.pio` comes from
pico-examples (BSD-3-Clause); their notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

PureVector, SABRE and CORSAIR are trademarks of Corsair; Aimlabs is a
trademark of its owner. All trademarks belong to their respective owners.
omnisens is not affiliated with or endorsed by Corsair or Aimlabs.
