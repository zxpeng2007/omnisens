# The omnisens app (no hardware)

The omnisens app gives you per-direction sensitivity without the USB adapter.
It is one small program: it runs the calibration tool locally (offline) and
applies your profile to the PC you are using.

| | Windows | Linux | macOS |
|---|---|---|---|
| Calibration tool | yes | yes | use the [website](https://zxpeng2007.github.io/omnisens/) |
| How the profile is applied | the free, signed [Raw Accel](https://github.com/RawAccelOfficial/rawaccel) driver | built in (evdev → uinput) | not supported |
| Directions | 4 (right, left, up, down); diagonals approximated | full profile (8-16 points, interpolated) | - |
| One-time setup | install Raw Accel's driver, restart | one permission rule (sudo) | - |

**Why Windows is an approximation.** Games read mouse input straight from
the Windows driver stack, so changing it needs a signed kernel driver.
omnisens uses Raw Accel's, which is widely used and, per its FAQ, written to
work with anti-cheat. Raw Accel can scale moving right, left, up and down
separately but has no per-angle table, so the app fits the four values that
best match your whole profile and shows you how close that is (typically
within 1-2%; diagonal flicks can be bent by a few degrees). For full fidelity
on Windows, use the [USB adapter](HARDWARE.md). A fully programmable driver
(Interception) was ruled out because anti-cheats such as Vanguard and FACEIT
block it.

> **Status: early.** The app is unit-tested and the Linux engine is tested
> against virtual devices, but it has not been tried by players yet. Please
> report problems.

## Windows

1. Download `omnisens-windows-x64.exe` (or `-arm64`) from the
   [releases page](https://github.com/zxpeng2007/omnisens/releases) and run it.
   Windows SmartScreen may warn that the app is unrecognised because it is not
   code-signed: choose *More info* → *Run anyway*. The source and the CI build
   are public.
2. Your browser opens the omnisens tool on `http://127.0.0.1:...`. Keep the
   small console window open while you use it.
3. On **This PC**, press **Install Raw Accel**. omnisens downloads the
   official Raw Accel 1.7.1 release from GitHub, checks its SHA-256, and
   starts Raw Accel's installer (approve the Windows prompt). **Restart your
   PC** when it finishes. Already use Raw Accel? Point omnisens at its folder
   instead; your settings are kept (see below).
4. Run omnisens again, calibrate (**Calibrate**, 5-8 minutes), then press
   **Apply on this PC** on the results page.
5. Turn on **Apply at every login**, because Raw Accel forgets its settings
   at shutdown. This adds a startup entry that runs Raw Accel's own
   `writer.exe` with your settings; omnisens itself does not need to run.

**If you already use Raw Accel**, omnisens multiplies its four directional
factors into your existing settings (every profile) and leaves everything
else, such as acceleration curves, untouched. It saves your original file as
`settings.before-omnisens.json` the first time, and **Remove** divides the
factors back out. Close Raw Accel's own window before applying; if you later
press Apply in Raw Accel's window, it writes its in-memory copy back, which
can drop the omnisens factors.

Raw Accel needs the Microsoft Visual C++ runtime; the app tells you if it is
missing and links to Microsoft's installer.

**Undo everything:** press **Remove**, turn off *Apply at every login*, and,
if you want, run `uninstaller.exe` in the Raw Accel folder and restart. The
app keeps its state in `%LOCALAPPDATA%\omnisens`.

## Linux

1. Download `omnisens-linux-x64` (or `-arm64`) and make it executable:
   `chmod +x omnisens-linux-x64`.
2. One-time permissions, so omnisens can read your mouse and create a virtual
   one: `sudo ./omnisens-linux-x64 linux-setup --install`, then log out and
   back in. (`./omnisens-linux-x64 linux-setup` only prints what it would do.)
3. Run `./omnisens-linux-x64`, calibrate in the browser, and press **Apply on
   this PC**. The correction runs while omnisens runs: it grabs your mouse
   and sends the corrected movement through a virtual mouse called
   "omnisens: <your mouse>". Close omnisens and your mouse goes back to
   normal.
4. Headless or at login: `./omnisens-linux-x64 apply <profile code>`, or turn
   on **Apply at every login** (an XDG autostart entry).

The Linux engine is the same algorithm as the adapter firmware, so the full
profile applies, not an approximation.

## How it works and what it touches

* The app serves the calibration tool on `127.0.0.1` only, on a random port,
  with a random token per run; other websites cannot call it. Nothing is
  uploaded.
* Windows: it reads and writes Raw Accel's `settings.json`, runs Raw Accel's
  `writer.exe`, and (if you ask) downloads and starts Raw Accel's installer
  and adds one startup entry under `HKCU\...\Run`.
* Linux: it reads `/dev/input/event*` mice and writes `/dev/uinput`.
* Command line: `omnisens --no-browser`, `omnisens apply <code>`,
  `omnisens remove`, `omnisens --version`.

## Fair play

Applying omnisens through Raw Accel changes your mouse input the same way any
Raw Accel setting does. Check the rules of your game and league; see the
README's fair-play section.
