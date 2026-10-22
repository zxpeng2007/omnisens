# Contributing

Bug reports, mouse compatibility reports and pull requests are welcome.

* **A mouse does not work through the adapter?** Open an issue with the mouse
  model, the board, what the status LED does, and (if the Adapter page of the
  calibration tool can connect) the status it shows.
* **Calibration results look wrong?** Download the session from the results
  page (`Download session`) and attach it; it contains only your flick
  movements and settings.
* **Code changes:** run the tests before opening a PR:

  ```bash
  make -C firmware/test run
  node --test "web/test/*.test.mjs"
  ```

  If you change `firmware/src/omni_core.c` or `web/js/omni-core.js`, change
  both and regenerate the shared vectors with
  `node web/test/gen-vectors.mjs > firmware/test/vectors.inc`. Protocol
  changes must update `docs/PROTOCOL.md`, `firmware/src/vendor.c` and
  `web/js/device.js` together.

Keep the firmware small and predictable: everything it sends to the PC is
the mouse's own input, scaled; no input injection, no features that act on
the game.
