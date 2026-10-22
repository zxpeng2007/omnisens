#!/usr/bin/env bash
# Fetches the pinned firmware dependencies (shallow) into firmware/deps,
# or into $OMNI_DEPS_DIR if set. Re-running updates them to the pinned refs.
set -euo pipefail

PICO_SDK_REF=2.3.1
TINYUSB_REF=0.21.0
# Pico-PIO-USB main after 0.7.2: RP2350-E9 guard fix and a bounds check on received packets.
PIO_USB_REF=5a37a66dc5d3fbe0ef3cdbeda923a757440f984f

DEPS=${OMNI_DEPS_DIR:-"$(cd "$(dirname "$0")/.." && pwd)/deps"}
mkdir -p "$DEPS"

fetch() {  # name url ref
  local dir="$DEPS/$1"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$2"
  fi
  git -C "$dir" fetch -q --depth 1 origin "$3"
  git -C "$dir" checkout -q FETCH_HEAD
  echo "$1 @ $3"
}

fetch pico-sdk https://github.com/raspberrypi/pico-sdk.git "$PICO_SDK_REF"
fetch tinyusb https://github.com/hathach/tinyusb.git "$TINYUSB_REF"
fetch Pico-PIO-USB https://github.com/sekigon-gonnoc/Pico-PIO-USB.git "$PIO_USB_REF"
