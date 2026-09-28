Unreleased
----------


* Add a portable cassette recorder beside the Spectrum: SAVE records onto 60-minute cassettes kept in the browser between visits and in saved sessions, LOAD reads them back from wherever the tape is wound to, holding Record yourself records the beeper's sound too, and a cassette box creates, imports, exports, renames, write-protects and duplicates cassettes
* Add a script API (`emu.machine`, `emu.keyboard` and `emu.tape`) that switches the machine on, types into it and works the tape recorder from code, and waits for what happens, for tests and demos
* Add recognition of a character clicked on the screen, showing which ROM character it is and the keys that type it; a double-click types it
* Add the rest of the TZX format: CSW and generalized data blocks, blocks that stop the tape (always, or in 48K mode only), signal level blocks, and jumps, loops and calls that go backwards; the tape counter and its list of parts follow loops and jumps in the order the tape plays them
* Add Save to PC to the Microdrive drive panel, and save a printout longer than about 11.5 m as a ZIP of PNGs rather than dropping its start
* Make the File menu's dialogs (Find games, PlayZX, Pokes, Tape cassettes and Microdrive cartridges) open in one light window that can be moved, resized and maximized and opens again where it was left, show their progress and errors in a status line rather than alert boxes, and let the arrow keys and Enter pick and load a PlayZX result; the tape recorder's, Microdrives' and printer's panels and the restore card can be dragged too, the recorder's and Microdrives' resized, and they open again where they were left
* Make the tape recorder, the Microdrives and the ZX Printer connected on a first visit; after that each stays as the visitor left it, and keep the printer's roll and printout between visits too
* Make the page scroll to the tape recorder and Microdrives when zoomed in, keep the current zoom when a session is restored, and remember the tape loading settings across visits
* Make VERIFY with instant tape loading compare the tape with memory, failing with "R Tape loading error" where they differ, and make Play on a toolbar tape that has run out start it again from the beginning
* Make `emu.exit()` remove everything the emulator added to the page and keep a recording or Microdrive save still in progress, returning a promise; `setZoom`, `enterFullscreen` and `emu.tape.setInstantLoading` called from a page or script no longer change the visitor's saved settings
* Make the build run on Node 26 from any shell, cmd and PowerShell included, with the optimized core as the default build, and make `npm test` fail when a test fails
* Fix the emulator freezing or hanging on tape errors and damaged TZX files, including ones whose jumps and calls go round for ever; a frame that fails now pauses the machine with a message
* Fix TZX playback: winding to a part that follows a block which stops the tape made Play stop again at once, and direct recordings played with their signal level turned upside down, with an extra edge where two met
* Fix the sound: AY stereo, sound drifting out of step with the picture, AY envelopes that hold, audio on devices running above 48 kHz, AY registers reading back bits they don't have, and AY noise periods from 16 up playing far too high
* Fix hardware details: the floating bus, interrupt timing (R during the acknowledge, IM 0's length, and the 48K's shorter interrupt), LD A,I and LD A,R when interrupted, Reset on the Pentagon leaving TR-DOS paged in, a spinning Microdrive stopping when a cartridge is inserted, and the Cursor and Sinclair joysticks letting go of keys held on the keyboard
* Fix snapshots: `.z80` machine types, T-states, sound chip state, a byte 12 of 255 and uncompressed version 1 files, `.sna` files with the stack at the edge of memory, snapshots taken inside the Interface 1 ROM opened with the Microdrives disconnected, a damaged `.szx` T-state count freezing the machine for minutes, and snapshots and sessions losing the AY's port registers, or on a 48K the whole AY; a snapshot that can't be loaded whole is now refused before anything changes
* Fix pokes: undoing trainers that share bytes, forgetting them after a reset or a new load, bank pokes on the 48K, and undoing a poke after the game has paged another bank in
* Fix cassettes and cartridges being lost or overwritten: when a write to the browser's storage fails, when two tabs record on the same one, on a quick disconnect and reconnect of the recorder, on a format while the drive is still writing, and when a session is restored over work done since it was saved
* Fix the page: frame pacing, sound that stayed silent until a click, keys stuck down after focus left the page, calls made before start-up had finished, a URL that failed to download being opened as a file, numpad 8 typing DELETE, the UK ' key acting as Caps Shift, Symbol Shift + W closing the tab without asking, and a quick pause and resume running two frame loops, every opened tape and snapshot kept in memory for good, and a core that fails to load leaving the page to wait for ever without a word
* Fix the PlayZX, Pokes and Find games dialogs: Enter loading the previous search's first result, duplicate downloads after reopening, a failed catalog load lasting until reload, Find games sticking on errors and mangling some titles, the machine left paused after closing Find games, Find games opening an item's last file rather than its first, and a game still downloading when Find games was closed being loaded and started anyway
* Fix a restored session losing the dots of a row being printed, a session saved in the middle of a Microdrive command (`FORMAT`, `CAT`, `LOAD *`) failing it on restore, which now carries on with the drives' motors and heads as they were, a hand-edited session with an empty cassette id emptying the recorder, and the tape counter marking the first pass of a looped part
* Fix an empty Microdrive file (`OPEN #` then `CLOSE #`) shown in the drive panel as a bad sector instead of a file
* Fix more hardware details: the floating bus showing each screen byte a T-state late, border colour changes landing 8 pixels to the right, bit 6 of port 0xFE ignoring the EAR output, and the AY's register port reading 0 rather than 255 with register 16 or above selected
* Fix instant tape loading hanging on a TZX block kept as a pure tone, pulses and pure data, which now plays for the ROM to load in real time, and the tape recorder still offering to undo a recording once a later one had taken the undo away
* Fix the script API: `emu.keyboard.type` typing two Enters for a Windows line ending and refusing `^`, `emu.tape.parts` leaving out the end, and naming no data parts, on a pre-recorded tape, and `emu.tape.undo` doing nothing while a SAVE still held Record down


3.2.3 (2026-09-25)
------------------

* Add ZX Interface 1 and Microdrive emulation: the Interface 1 shadow ROM and extended BASIC, two Microdrives in a dock beside the Spectrum, a drive panel for inserting, formatting, write-protecting and ejecting cartridges, and a cartridge box that keeps cartridges in the browser between visits and imports and exports them as .mdr files
* Add ZX Printer emulation with a printer beside the Spectrum: LPRINT, LLIST and COPY print onto a roll of silver paper (COPY bit-exact on the 48K, 128K and Pentagon), which scrolls with the mouse wheel or by dragging, folds over the printer, and can be torn off or saved as a PNG
* Add saving and restoring the whole session as one file: the running machine, the machine and ROM chosen, the tape and where it is parked, the Microdrive cartridges, the printout, the settings and whether the machine was off, paused or running, stored as a ZIP holding a standard SZX snapshot alongside the other parts
* Add writing SZX snapshots, which also carry the AY, Interface 1, Beta 128 and ZX Printer state
* Add detection of custom tape loaders (Speedlock and other turbo loaders): the tape starts by itself when such a loader begins reading it, runs fast-forwarded when instant loading is on, and stops again once the loader goes idle, so a multi-load game finds the tape where the last load left it
* Add a switched-off TV screen shown until the machine is first started, which then powers on like a picture tube
* Add a display size slider from 100% to 400% that catches on the whole and half sizes, and remember the chosen size, fullscreen included, between visits
* Add the Microdrive motor whirr and the printer buzz to the emulator's sound
* Add `JSSpeccy.version`, and show the version in the browser tab title
* Make audio play from an AudioWorklet on the browser's audio thread with a cap on latency, so a busy page can no longer starve it
* Make the menu bar and toolbar compact below 200% zoom so they stay on one row
* Fix snapshot loads taking the first interrupt one instruction late, by restoring the EI-last flag
* Fix the CPU register state left behind by the instant tape-load trap


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
