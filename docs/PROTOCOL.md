# USB interfaces and configuration protocol

The adapter enumerates as one composite USB device with three HID interfaces.
Everything here is the contract between `firmware/` and `web/js/device.js`.

| Interface | Purpose | Endpoint | Report |
|---|---|---|---|
| 0 | Mouse (boot subclass) | IN 0x81, 1 ms | 8 bytes, no report ID |
| 1 | Keyboard (boot subclass) | IN 0x82, 1 ms | 8-byte boot keyboard report |
| 2 | Vendor config (usage page `0xFF00`, usage `0x01`) | IN 0x83 (unused) | Feature reports 1-3, 63 bytes each |

USB IDs default to `0x1209:0x0001`, the [pid.codes](https://pid.codes/1209/0001/)
test PID. It is not unique and is meant for testing; omnisens will switch to a
dedicated PID once one is assigned. Builds can override the IDs with the
`OMNI_USB_VID` / `OMNI_USB_PID` C defines (update `web/js/device.js` to match).

## Interface 0: mouse

Report protocol (default), 8 bytes:

| Byte | Field |
|---|---|
| 0-1 | Buttons 1-16, one bit each (bit 0 = left, 1 = right, 2 = middle, 3 = back, 4 = forward) |
| 2-3 | X, int16 little endian, logical range -32767..32767, relative |
| 4-5 | Y, int16 little endian, relative, +Y = down |
| 6 | Wheel, int8, relative |
| 7 | AC Pan (horizontal wheel, Consumer page 0x0238), int8, relative |

If the host selects the boot protocol (BIOS/UEFI), the interface sends the
standard 4-byte boot report instead: buttons 1-8, X int8, Y int8, wheel int8.
Motion that does not fit in a report is carried over to the next one, never
dropped.

## Interface 1: keyboard passthrough

Many gaming mice expose a second HID interface that types keys for macro
buttons. Only boot-subclass keyboard interfaces (`bInterfaceSubClass` 1,
`bInterfaceProtocol` 1) are forwarded. Each one is switched to the boot
protocol, and its 8-byte reports are forwarded unchanged once the device has
confirmed the switch, so report-protocol bytes are never sent as keystrokes.
Not forwarded:

- boot keyboards that refuse `SET_PROTOCOL(BOOT)`;
- keyboard collections on non-boot interfaces or behind report IDs,
  including ones that share an interface with the mouse;
- consumer (media) keys.

Keyboard LED output reports from the PC are ignored.

## Interface 2: vendor configuration

All configuration goes through feature reports on the control endpoint, so
it works with WebHID (`sendFeatureReport` / `receiveFeatureReport`), hidapi,
or any HID library. Each report has a report ID byte followed by 63 payload
bytes. Multi-byte fields are little endian. Reserved bytes are written as 0
and must be ignored when read.

### Report 1: configuration (GET and SET)

GET returns the configuration that is live in RAM. SET replaces it; the
firmware sanitizes it (clamps every field into range), applies it on the
next motion report, and marks it dirty until it is saved with command
`0x01`.

| Offset | Type | Field | Range / meaning |
|---|---|---|---|
| 0 | u8 | `version` | `1` |
| 1 | u8 | `flags` | bit 0 enabled, bit 1 linear interpolation (else cubic), bit 2 chord toggle |
| 2 | u8 | `n_points` | 1-16 directional gain points |
| 3 | u8 | reserved | 0 |
| 4 | u16 | `smoothing_counts` | direction smoothing length L in counts, 0-4096 (0 = per report) |
| 6 | u16 | `reset_ms` | 1-2000; idle gap that starts a new stroke |
| 8 | i16 | `rotation_cdeg` | -4500..4500, extra output rotation in 0.01 deg, CCW |
| 10 | u16 | `calib_dpi` | informational, DPI used during calibration (0 = unknown) |
| 12 | u16[16] | `gains_q12` | gain point k is at angle `k * 360 / n_points`; Q12 (4096 = 1.0x), 410-32767; slots >= n_points are 4096 |
| 44 | char[16] | `label` | printable ASCII profile name, NUL padded |
| 60 | u8[3] | reserved | 0 |

Angles are counter-clockwise with 0 deg = moving the mouse right, 90 deg =
pushing it away from you (cursor up), 180 deg = left, 270 deg = pulling it
toward you (cursor down).

Factory defaults: flags = enabled | chord toggle, 8 points all `4096`,
`smoothing_counts` 32, `reset_ms` 40, rotation 0. With these the adapter is
a transparent passthrough.

### Report 2: status (GET) and commands (SET)

SET: byte 0 is a command, the rest are arguments.

| Command | Args | Effect |
|---|---|---|
| `0x01` SAVE | - | Write the RAM configuration to flash |
| `0x02` LOAD | - | Discard RAM changes, reload the saved configuration |
| `0x03` DEFAULTS | - | Load factory defaults into RAM (SAVE to make them stick) |
| `0x04` SET_ENABLED | byte 1: 0 or 1 | Turn correction off/on in RAM (used for calibration bypass) |
| `0x05` BOOTLOADER | - | Reboot into the UF2 bootloader for firmware updates |
| `0x06` REBOOT | - | Plain reboot |
| `0x07` RESET_COUNTERS | - | Zero the live counters in report 3 |

GET:

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | protocol version, `1` |
| 1 | u8 | firmware major |
| 2 | u8 | firmware minor |
| 3 | u8 | firmware patch |
| 4 | u8 | flags: bit 0 mouse attached, bit 1 correction enabled, bit 2 RAM config differs from flash, bit 3 a saved config exists, bit 4 keyboard interface attached, bit 5 mouse is using the boot-protocol fallback |
| 5 | u8 | result of the last command: 0 ok, 1 unknown command, 2 flash error, 3 bad arguments |
| 6 | u16 | attached mouse VID (0 if none) |
| 8 | u16 | attached mouse PID |
| 10 | u16 | mouse reports received in the last second |
| 12 | u8 | reserved, always 0 |
| 13 | u8 | board ID (see `firmware/boards/`) |
| 14 | u32 | uptime in ms |
| 18 | u32 | sequence number of the flash record loaded at boot or last saved (0 if none); goes up on every save |
| 22 | char[16] | board name, NUL padded |

### Report 3: live counters (GET)

Lets the web tool show what the adapter is doing without a game.

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | mouse reports processed |
| 4 | i32 | sum of raw input X |
| 8 | i32 | sum of raw input Y |
| 12 | i32 | sum of output X |
| 16 | i32 | sum of output Y |
| 20 | u16 | last direction estimate, 0.01 deg (0-35999) |
| 22 | u16 | last applied gain, Q12 |
| 24 | u16 | current button state |

## Flash storage

The configuration lives in a pair of reserved 4 KB sectors at the top of
flash, so dragging a new UF2 onto the board keeps it. The source of truth
is `STORE_OFFSET` in `firmware/src/storage.c`.

| Chip | Sectors | Addresses |
|---|---|---|
| RP2040 | the last two: flash size - 8 KB and - 4 KB | Pico 0x101FE000 / 0x101FF000, Feather RP2040 USB Host 0x107FE000 / 0x107FF000, RP2040-PiZero 0x10FFE000 / 0x10FFF000 |
| RP2350 | the third- and second-to-last: flash size - 12 KB and - 8 KB | Pico 2 0x103FD000 / 0x103FE000, RP2350-USB-A 0x101FD000 / 0x101FE000 |

RP2350 UF2s built with pico-sdk carry an absolute block at 0x10FFFF00
(erratum RP2350-E10 workaround, picotool `--abs-block`) that makes the
bootrom erase the last sector on every download, so on RP2350 nothing may
be stored there.

Each sector holds 16 records of 256 bytes (one flash page):

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | magic `0x534E4D4F` (`"OMNS"`) |
| 4 | u32 | sequence number |
| 8 | u8[63] | packed configuration, same layout as report 1 |
| 71 | u8 | 0 |
| 72 | u32 | CRC-32 (IEEE 802.3, the zlib one) of bytes 0-71 |
| 76 | - | 0xFF padding to 256 |

A record is valid when its magic and CRC are correct, whatever its
configuration version. Saving:

- The new record's sequence number is one more than the highest of any
  valid record in either sector, so a record written by older or newer
  firmware never outranks a later save.
- It goes into the first erased page after that newest record, in the same
  sector, so a save normally only programs one page (about 1 ms).
- When that sector is full, the other sector is erased (always, even if it
  reads blank) and the record goes into its first page. The full sector is
  kept until the next switch.

The sector holding the newest record is never erased, so losing power
during a save leaves the previous configuration loadable. On boot, the
valid record with the highest sequence number whose configuration version
the firmware understands wins (equal numbers: the later page in a sector);
if there is none, factory defaults are used.

## On-device toggle

With the chord toggle flag set, holding left + right + middle for 3 seconds
flips correction on or off (RAM only, a power cycle restores the saved
state). The status LED shows the result: solid = correction on, off =
bypass, slow blink = no mouse attached, three quick flashes = toggled.
While the PC has the USB bus suspended the LED is dark.
