# Building and testing

You only need this to change the code. Prebuilt firmware is on the
[releases page](https://github.com/zxpeng2007/omnisens/releases) and the
calibration tool runs at https://zxpeng2007.github.io/omnisens/.

## Firmware

Requirements: `cmake` (3.17+; Ubuntu 20.04 and Debian 10 need a newer one
than apt provides, e.g. `pip install cmake`), `ninja` or `make`, `arm-none-eabi-gcc` with
newlib, a host C/C++ compiler (pico-sdk builds `pioasm` and `picotool`), git
and Python 3. On Ubuntu/Debian or WSL:

```bash
sudo apt install cmake ninja-build gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib build-essential git python3
```

Fetch the pinned dependencies (pico-sdk 2.3.1, TinyUSB 0.21.0 and a pinned
Pico-PIO-USB commit) into `firmware/deps/`:

```bash
bash firmware/scripts/fetch-deps.sh
```

To keep them somewhere else (for example shared between clones), export
`OMNI_DEPS_DIR` for both the script and CMake, or pass `-DOMNI_DEPS_DIR=...`.

Build for a board (any file name in `firmware/boards/` without extension):

```bash
cmake -S firmware -B build -G Ninja -DOMNI_BOARD=pico
cmake --build build
```

The result is `build/omnisens-<board>.uf2`. To use dependencies that live
elsewhere, set `PICO_SDK_PATH`, `PICO_TINYUSB_PATH` and `PICO_PIO_USB_PATH`
(as environment variables or `-D` options). The resolved paths are cached on
the first configure; change them with `-D` or by deleting the build
directory.

Optional build settings:

| Option | Default | Meaning |
|---|---|---|
| `-DOMNI_BOARD=...` | `feather_rp2040_usb_host` | target board |
| `OMNI_USB_VID` / `OMNI_USB_PID` (C defines) | `0x1209` / `0x0001` | USB IDs; also change them in `web/js/device.js` |
| `firmware/src/profile_default.h` | absent | factory profile; the tool's Export page generates it |

### Adding a board

Create `firmware/boards/<name>.cmake` (sets `PICO_BOARD`) and
`firmware/boards/omni_board_<name>.h`: copy an existing header and define
every macro in it, using `(-1)` for pins the board lacks (an undefined pin
macro would silently become GPIO0) and a unique `OMNI_BOARD_ID`. Then add
the board to the matrix in `.github/workflows/ci.yml`. D- must be the GPIO
right after D+.

### Code map

| File | Role |
|---|---|
| `src/omni_core.c` | the directional gain engine and config format (no SDK, unit tested) |
| `src/hid_parser.c` | finds buttons/X/Y/wheel in any mouse's report descriptor (no SDK, unit tested) |
| `src/config_store.c` | append-only config log for one flash sector (no SDK, unit tested) |
| `src/host.c` | core 1: PIO-USB host, mouse/keyboard mount and report decoding |
| `src/main.c` | core 0: USB device, applying the engine, report sending, LED, watchdog |
| `src/vendor.c` | the WebHID configuration protocol (`docs/PROTOCOL.md`) |
| `src/usb_descriptors.c`, `src/report_descs.h` | what the PC sees |
| `src/storage.c` | flash read/write (the image runs from RAM, so writes never stall the host) |
| `src/led.c` | status LED / WS2812 |

## Tests

```bash
make -C firmware/test run          # C unit tests with ASan + UBSan (host gcc/clang)
node --test "web/test/*.test.mjs"   # calibration maths, exports, schedule
```

`firmware/test/vectors.inc` is generated from the JavaScript engine
(`node web/test/gen-vectors.mjs > firmware/test/vectors.inc`) so the C and
JS implementations are checked against each other. CI fails if it is stale.

## Calibration tool

The tool is plain HTML/CSS/ES modules with no build step. Serve `web/` over
HTTP (WebHID and raw pointer lock need `localhost` or HTTPS):

```bash
python -m http.server 8000 --directory web
```

then open http://localhost:8000/. Pushing to `main` deploys it to GitHub
Pages through `.github/workflows/pages.yml` (in a fork, first set Settings →
Pages → Source to "GitHub Actions").
