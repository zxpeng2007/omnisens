# Hardware

A mouse's own firmware can't be replaced in general, so omnisens runs on a
small USB adapter between the mouse and the PC:

```
mouse ──USB──▶ [ RP2040 / RP2350 adapter ] ──USB──▶ PC
              PIO-USB host      native USB device
```

The adapter reads every report from the mouse, scales the motion by the
direction-dependent gain, and sends it on. It works with wired mice and with
wireless receivers, needs no drivers or software on the PC, and keeps its
settings in its own flash.

## Pick a board

| Board | Approx. price | Effort | Firmware file |
|---|---|---|---|
| [Adafruit Feather RP2040 with USB Type A Host](https://www.adafruit.com/product/5723) | $17.50 | none, plug and play | `omnisens-feather_rp2040_usb_host.uf2` |
| [Raspberry Pi Pico](https://www.raspberrypi.com/products/raspberry-pi-pico/) + USB-A socket | $4 + socket | four wires | `omnisens-pico.uf2` |
| [Raspberry Pi Pico 2](https://www.raspberrypi.com/products/raspberry-pi-pico-2/) + USB-A socket | $5 + socket | four wires, maybe two resistors | `omnisens-pico2.uf2` |
| [Waveshare RP2350-USB-A](https://www.waveshare.com/wiki/RP2350-USB-A) | $5 | remove one resistor | `omnisens-waveshare_rp2350_usb_a.uf2` |
| [Waveshare RP2040-PiZero](https://www.waveshare.com/wiki/RP2040-PiZero) | $10 | remove one resistor, USB-C OTG adapter | `omnisens-waveshare_rp2040_pizero.uf2` |

If you just want it to work, get the **Feather**. If you want the cheapest
build, use a **Pico (RP2040)** and a USB-A socket or a cut extension cable.
The Waveshare RP2350-USB-A has the nicest form factor (a thumb-drive-sized
stick) but needs a small soldering fix.

### Adafruit Feather RP2040 USB Host

Nothing to wire. The USB-C port goes to the PC, the USB-A port takes the
mouse. The board switches 5 V to the USB-A port itself (GPIO18) through a
500 mA fuse. Status shows on the NeoPixel and the red LED.

### Raspberry Pi Pico / Pico 2 (DIY)

Wire a USB-A female socket (or the socket end of a USB extension cable) to
the Pico:

| USB-A socket pin | Usual wire colour | Pico pin |
|---|---|---|
| 1 VBUS | red | pin 40 (VBUS) |
| 2 D- | white | pin 2 (GPIO1) |
| 3 D+ | green | pin 1 (GPIO0) |
| 4 GND | black | pin 38 (GND) |

* 22 Ω series resistors on D+ and D- are recommended by Pico-PIO-USB but
  optional; many builds work without them.
* The Pico's micro-USB goes to the PC. The mouse gets 5 V straight from the
  PC through the Pico's VBUS pin.
* **Pico 2 only:** early RP2350 chips (stepping A2, printed on the chip) have
  erratum RP2350-E9, which can stop the adapter from noticing when the mouse
  is unplugged. Add 15 kΩ resistors from D+ to GND and from D- to GND, or use
  an RP2040 Pico, which is not affected.

### Waveshare RP2350-USB-A

A small stick with a USB-C port for the PC and a USB-A socket for the mouse
(D+ GPIO12, D- GPIO13), RGB LED on GPIO16. A short USB-C cable or a
USB-A-to-C adapter connects it to the PC.

**Required fix:** the board has a 1.5 kΩ pull-up resistor (R13) on the
socket's D+ line, meant for using the socket as a device. In host mode it
makes the adapter think something is always plugged in, low-speed mice do not
work, and hot-plugging fails. Desolder **R13**. For reliable plug/unplug
detection, also add 15 kΩ pull-downs from D+ and D- to GND. Waveshare's wiki
FAQ and [this write-up](https://qsantos.fr/2025/11/21/fixing-the-rp2350-usb-a-not-working-as-usb-host/)
describe the fix. The socket's VBUS is wired straight to the PC's 5 V with
no fuse, so avoid power-hungry devices.

### Waveshare RP2040-PiZero

The PIO-USB port is the second USB-C connector (D+ GPIO6, D- GPIO7). Use a
USB-C (male) to USB-A (female) OTG adapter for the mouse. Remove the 2.2 kΩ
D+ pull-up **R34** for host mode, as with R13 above. There is no user LED.

## Flashing and updating

1. Download the `.uf2` for your board from the
   [latest release](https://github.com/zxpeng2007/omnisens/releases/latest).
2. Put the board in bootloader mode: hold **BOOT/BOOTSEL** while plugging it
   into the PC (Feather and Waveshare: hold BOOT and tap RESET). A drive
   called `RPI-RP2` (RP2040) or `RP2350` appears.
3. Drag the `.uf2` onto that drive. The board reboots into omnisens.

Later updates work the same way, or use **Enter bootloader** on the Device
page of the calibration tool. Your saved profile survives firmware updates.

## Status LED

| LED | Meaning |
|---|---|
| on (RGB: green) | mouse attached, correction on |
| off (RGB: dim red) | mouse attached, bypass (correction off) |
| slow blink (RGB: blue) | no mouse detected |
| three quick flashes | correction toggled with the button chord |

Hold **left + right + middle** for 3 seconds to toggle the correction
without software (it does not change the saved setting).

## Limits

* **1000 Hz maximum.** RP2040/RP2350 USB and PIO-USB are full speed
  (12 Mbit/s), which tops out at 1000 reports per second. A 4k/8k mouse
  falls back to full speed and runs at 1 kHz through the adapter. True 8 kHz
  passthrough would need a chip with high-speed USB on both sides (for
  example an NXP i.MX RT1062 / Teensy 4.x); omnisens does not support that
  yet.
* **Compatibility.** PIO-USB works with most mice, receivers and hubs, but
  a few devices misbehave on it. If yours does not enumerate, try a short
  cable or a small hub between the adapter and the mouse, and open an issue
  with the mouse model.
* **Power.** The mouse is powered by the PC through the adapter. Very
  power-hungry RGB mice may need the Feather (fused boost converter) or a
  powered hub. While the PC sleeps the status LED turns off; on the Feather
  the mouse is also switched off if the PC has not enabled wake-on-click,
  and comes back when the PC wakes.
* **Vendor software.** G Hub, Synapse, iCUE and similar tools cannot see the
  mouse through the adapter. Set DPI, polling rate, RGB and button mappings
  first, saved to the mouse's onboard memory, then put the adapter in
  between. On-mouse DPI buttons keep working, and because the gains are
  ratios they stay valid at any DPI.
* **Keyboard interfaces.** Extra keyboard interfaces on the mouse (macro
  keys) are forwarded as a boot keyboard. Media keys (consumer control) are
  not forwarded.
