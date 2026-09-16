3.2.2 (2026-09-16)
------------------

* Add a PlayZX game browser (File → PlayZX open…) over the PlayZX online catalog of around 10,800 ZX Spectrum tape images: browse by initial letter, then title, then the individual releases with publisher, year and playing time, or search live by title, publisher, a raw SQL condition, or a random pick, and load the chosen tape straight into the emulator
* Fix jumping to a tape segment doing nothing when nothing was left reading the tape: the ROM tape loader is now booted for a fresh LOAD, while a load already in flight picks up the new position by itself
* Fix the tape segment popup highlighting the wrong part once a whole tape had loaded, by marking the block the tape is parked on rather than where the cassette counter happens to sit
* Fix the start button drifting off centre when the menu bar, toolbar or on-screen keyboard changed the height of the display


3.2.1 (2026-09-13)
------------------

* Add a Pokes (game cheats) browser (File → Pokes…) over the complete Tipshop poke database: fuzzy-matches the loaded game's title, applies/undoes trainers with checkboxes, supports user-supplied values and 128K bank-specific pokes (.POK semantics)
* Add support for a local (PC) joystick / gamepad via the browser Gamepad API, with Kempston, Cursor and Sinclair mappings selectable via the `joystickType` option, the Joystick menu, or the `setJoystickType` API endpoint
* Add `joystickEnabled` configuration option
* Add controller selection when more than one gamepad is connected, via the Controller menu, the `joystickDevice` option, or the `setJoystickDevice` API endpoint
* Add a clickable on-screen ZX Spectrum keyboard below the display, toggled from the toolbar, with sticky CAPS SHIFT/SYMBOL SHIFT and Shift/Ctrl modifiers
* Add a cassette counter with a segment popup for jumping to any part of a loaded tape, plus an eject button
* Add a "Spectrum 48K gw03" machine (the Gosh Wonderful alternate 48K ROM)
* Fix the SZX halted flag being read from the wrong offset, which spuriously restored halted=true and corrupted the stack in some games


3.2 (2024-11-23)
----------------

* Add mappings from keyboard symbol keys to equivalent Spectrum keypresses (Andrew Forrest)
* Add support for the Recreated ZX Spectrum's "game mode" (Andrew Forrest)
* Add `keyboardEnabled` configuration option
* Add `uiEnabled` configuration option
* Add `loadSnapshotFromStruct` API endpoint
* Add `onReady` API endpoint
* Enable 'instant tape loading' option in sandbox mode
* Make keyboard event listeners play better with other interactive elements on the page


3.1 (2021-08-26)
----------------

* Real-time tape loading, including turbo loaders (except for direct recording, CSW and generalized data TZX blocks)
* Emulate floating bus behaviour
* Fix typo in docs (`openURL` -> `openUrl`)


3.0.1 (2021-08-16)
------------------

* Fix relative jump instructions to not treat +0x7f as -0x81 (which broke the Protracker 3 player)


3.0 (2021-08-14)
----------------

Initial release of JSSpeccy 3.

* Web Worker and WebAssembly emulation core
* 48K, 128K, Pentagon emulaton
* Accurate multicolour
* AY and beeper audio
* TAP, TZX, Z80, SNA, SZX, ZIP loading
* Fullscreen mode
* Browsing games from Internet Archive
