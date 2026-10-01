# JSSpeccy 3 Tech Notes

How the emulator is put together, written as know-how for a developer new to the code and as ground rules for an AI model working on it. The README covers what the emulator does, and docs/deployment.md how to build, embed and script it; this file covers how it does it. The sections run from the big picture (architecture, build) to the details of the code generator, the core's data formats and each feature, and end with the rules to follow when changing things.

## Contents

* Orientation: what the project is and where things live
* Architecture: the three layers and how they talk
* Building, running and testing
* The core code generator
* Data formats: the frame buffer
* Tape playback
* Feature notes: pokes, tape recorder, Interface 1 and Microdrives, printer, sessions, dialogs and movable panels, starter programs
* Working on the project: rules, gotchas and how to check a change

## Orientation

JSSpeccy 3 is a ZX Spectrum emulator (48K, 128K and Pentagon) that runs in the browser. It is a complete rewrite of JSSpeccy to make full use of the web technologies and APIs available as of 2021 for high-performance web apps. This fork, **JSSpeccy3 / dev**, extends the original with the tape recorder, the Interface 1 and Microdrives, the ZX Printer, sessions, pokes, catalog browsing and much more, and these notes describe the fork. The emulation runs in a Web Worker, freeing up the UI thread to handle screen updates, and sound plays from an AudioWorklet on the browser's audio thread, so a busy page can't starve it. The emulator core (consisting of the Z80 processor emulation and any auxiliary processes that are likely to interrupt its execution multiple times per frame, such as constructing the video output, reading the keyboard and generating audio) runs in WebAssembly, compiled from AssemblyScript (with a custom preprocessor).

Where things live:

* `generator/`: the code generator that produces the AssemblyScript source of the core. `core.ts.in` is the core's source, `instructions.js` holds the Z80 instruction body templates, `opcodes_*.txt` are the opcode tables, `gencore.js` is the preprocessor.
* `build/`: generated output (`core.ts`). Not checked in and never edited by hand.
* `runtime/`: everything that runs in the browser. `jsspeccy.js` is the UI thread's entry point and the `Emulator` class, `worker.js` is the Web Worker that owns the core. The rest are the pieces around them: `render.js` (canvas), `audio.js` (audio output), `keyboard.js`, `keyboard-overlay.js` and `keyboard-legends.js` (keyboard input and the on-screen keyboard), `joystick.js`, `snapshot.js` (SNA, Z80 and SZX), `tape.js` (TAP and TZX playback), `cassette.js` and `cassette-store.js` (tape recorder cassettes), `mdr.js` and `microdrive-store.js` (Microdrive cartridges), `tape-deck-ui.js`, `microdrive-ui.js` and `printer-ui.js` (the peripherals beside the Spectrum), `session.js`, `pokes.js` and `pokes-db.js`, `starter.js`, `char-picker.js`, `ui.js`, `dialog.js`, `movable.js`, `help.js` and `script-api.js`.
* `static/`: files that ship unchanged (`index.html`, the ROMs, the tape loaders, the game catalogs, the starter programs, the on-screen keyboard's picture).
* `starter/`: the sources of the starter programs: a BASIC listing for each, the machine code of the one that has some as assembly, the guessing game's trees, and `starter.json` naming each cassette and cartridge.
* `tools/`: the Node scripts behind the npm scripts (`build-js.js`, `copy-static.js`, `watch.js`), the pokes catalog generator, a test tape generator, and the starter programs' generator (`gen-starter.js`) with the BASIC tokeniser (`zxbasic.js`), the Z80 assembler (`z80asm.js`) and the Spectrum run in Node (`zxheadless.js`) it uses.
* `test/`: the FUSE-derived Z80 conformance suite.
* `dist/`: the built site.
* `docs/`: documentation, this file included.

## Architecture

There are three layers, and each talks to the next one in.

**The UI thread** (starting point in runtime/jsspeccy.js) is kept as lightweight as possible, only performing tasks that are directly related to communication with the "outside world": rendering the screen data to a canvas, handling keyboard events, outputting audio and managing UI actions such as loading files and parsing snapshot and tape files. It never touches the emulation directly. The frame loop is driven by `requestAnimationFrame`, pacing to about 20 ms per frame. In Warp (F8 held, or `emu.machine.setWarp`) each `runFrame` request asks the worker for a burst instead: it runs frames back to back for `WARP_BURST_MS` and returns the last one's picture and sound with the count it ran, and the UI thread asks again as soon as the burst comes back, up to `WARP_SPEED` times real time (unlimited as shipped). Everything a device does happens inside a frame, so the tape, the Microdrives and the printer speed up with the processor; the posts that keep the UI moving every few frames go once per burst, and the sound is muted.

**The Web Worker** (runtime/worker.js) owns the WebAssembly instance and does all the actual emulation. All communication between the UI thread and the worker happens through `postMessage`. The most important messages are `runFrame` (sent from the UI thread to the worker, to tell it to run one frame of emulation and fill the passed video and audio buffers with the resulting output) and `frameCompleted` (sent from the worker to the UI thread when execution of the frame is complete, passing the filled video and audio buffers back). The buffers are transferred, not copied, in both directions.

**The WebAssembly core** (jsspeccy-core.wasm) handles all of the performance-critical work. The main entry point into it is the `runFrame` function, which runs the Z80 and all related 'continuous' processes (memory reads / writes, responding to port reads / writes, building the screen and generating audio) for one video frame. `runFrame` returns a status of 0 to indicate that the frame has completed execution (and thus the video / audio buffers are ready to send back to the UI thread), with other status values serving as 'exceptions', indicating that execution was interrupted and needs action from the calling code before it can be continued (by calling `resumeFrame`). The exceptions are the tape traps in the ROM: 2 when LD-BYTES is about to load a block (only with instant tape loading on), 3 when SA-BYTES is about to save one (only while the tape recorder is connected), and 4 when SA-BYTES returns from a save being recorded in real time; 1 means an unrecognised opcode. A trap handler may leave the PC where it is, since the instruction the machine resumes on is never trapped again. The tape traps are serviced in JavaScript, in the worker (`trapTapeLoad` and its siblings): the worker reads or writes the tape block straight in core memory, then resumes.

`runIdleFrame` is a frame in which the machine stands still, for the tape recorder running while the machine is off or paused: the clock moves on one frame, the tape plays through it, and the audio buffer is filled with what the recorder alone makes (the tape signal and its own sounds, with the speaker, sound chip and MIC muted and untouched), then the frame is taken back off every clock, leaving the machine exactly as it was. The worker runs it for a `runIdleFrame` message, which the UI thread sends at the machine's pace, in place of `runFrame`, for as long as the recorder has something going on.

All state required for the WebAssembly core module to run, including memory contents (ROM and RAM), registers, audio / video buffers and lookup tables, is contained within the module's own memory map, and statically allocated at compile time. Nothing is heap-allocated.

**Cross-boundary state access.** The worker reads and writes core state directly through typed-array views over `core.memory.buffer`, using addresses the module exports as `usize` constants: `REGISTERS` (12 u16 register pairs), `FRAME_BUFFER`, `AUDIO_BUFFER_LEFT` and `AUDIO_BUFFER_RIGHT`, `TAPE_PULSES`, `MACHINE_MEMORY` and `LOG_ENTRIES`. Loading a snapshot, for example, writes registers by index into a `Uint16Array` view rather than calling functions. The address exports in core.ts.in must stay in sync with the views in worker.js and test/test.js.

**Deferred output.** On the real machine, generating video and audio output happens in parallel with the Z80's execution. An emulator implementing this naively would have to break out of the Z80 loop every few cycles to perform these tasks. In fact, these processes can be deferred for as long as we like, as long as we catch up on them before any state changes occur that would affect the output. With this in mind, the JSSpeccy core implements two functions `updateFramebuffer` and `updateAudioBuffer` which perform all pending video / audio generation as far as the current Z80 cycle. These are called immediately before any state change (which means, for audio, a write to any AY register or the beeper port; and for video, a write to video memory, change of border colour or a write to the memory paging port).

## Building, running and testing

Building this fork needs Node.js 26 or later (`.nvmrc` names the version for nvm, and `engines` in package.json states it). Install the dependencies with `npm ci`. The toolchain is deliberately small: `assemblyscript` (0.28) and `webpack` (5) are the only dev dependencies, and `file-dialog`, `jszip`, `pako` and `sql.js` the only runtime ones. Every step is a Node script, so they run the same from cmd, PowerShell or a POSIX shell.

* `npm run build`: the full build with the optimised (`optimizeLevel: 3`, `converge`) WebAssembly core: core, then wasm, then the JavaScript bundles, then the static assets, all written into `dist/`. This is the build that ships.
* `npm run build:debug`: the same with the debug core (unoptimised, with a source map), for debugging the emulation itself.
* `npm run watch`: `tools/watch.js` runs a full build, then reruns the step whose inputs changed. The `watch` section of package.json maps files to steps.
* `npm test`: runs `npm run build`, then the FUSE-derived Z80 conformance suite against the release core (`node test/test.js test/tests.in test/tests.expected`). It prints only the tests whose results differ from the expected ones, followed by a count, and exits non-zero if there are any; a silent run means every test passed. Memory is filled with FUSE's DE AD BE EF pattern before each test, and the event log holds 511 events per test. Node's `ExperimentalWarning` about importing a WebAssembly module is expected and is not a failure.
* The individual steps, for iterating: `build:core`, `build:wasm:debug`, `build:wasm:release`, `build:js` (webpack through its Node API, `tools/build-js.js`) and `build:static` (`tools/copy-static.js`).

The test harness always runs the whole suite from `tests.in` and `tests.expected` and has no filter flag. To narrow a run to one test, trim those two files to the test of interest: each test spans a name line, register lines and memory lines in `tests.in`, and a matching block in `tests.expected`.

There is no dev server. To run the emulator, build it, serve `dist/` over HTTP (for example `npx http-server dist` or `python -m http.server --directory dist`) and open `index.html`. Opening it from a `file://` URL does not work, because it uses Web Workers and streaming WebAssembly compilation. The server must send `.wasm` files as `application/wasm`.

## The core code generator

The wasm core is not hand-written AssemblyScript. To build jsspeccy-core.wasm, we run the script generator/gencore.js, which runs a preprocessing pass over the input file generator/core.ts.in, to generate the [AssemblyScript](https://www.assemblyscript.org/) source file build/core.ts (creating the build directory if needed). This is then passed to the AssemblyScript compiler to produce the final dist/jsspeccy/jsspeccy-core.wasm module, using the `debug` and `release` targets in asconfig.json.

The preprocessor step serves two purposes: firstly, it allows us to programmatically build the large repetitive `switch` statements that form the Z80 core. Secondly, it allows us to use conventional array syntax to access our statically-defined arrays. Currently, AssemblyScript does not appear to have any native support for static arrays - any use of array syntax causes it to immediately pull in a `malloc` implementation and a higher-level array construct with bounds checking, all of which is unwanted overhead for our purposes. The gencore.js processor rewrites array syntax into direct memory access [`load` / `store` instructions](https://www.assemblyscript.org/stdlib/builtins.html#memory).

Opcode generation works from two inputs. The opcode to mnemonic tables live in generator/opcodes_base.txt, opcodes_cb.txt, opcodes_dd.txt, opcodes_ddcb.txt and opcodes_ed.txt, and the instruction body templates live in generator/instructions.js. gencore.js fuzzy-matches each opcode's mnemonic against a template: `ADD A,B` matches an `ADD A,r` template, with `B` passed as a parameter. The placeholders are `r`, `rr`, `c`, `v` and `k`. The `dd` / `fd` and `ddcb` / `fdcb` prefix tables are derived automatically by substituting IY for IX.

All statically-defined arrays are allocated at the start of the module's memory map, from address 0 onward, each one starting on a multiple of its element size so that its loads and stores are aligned. Currently a 1664Kb block is allocated for these (`memoryBase` in asconfig.json is 1703936 bytes, of which about 1.68 MB is used). If you need more, increase `memoryBase` in asconfig.json. gencore.js stops the build with an error if the allocations outgrow it.

The core's top-level statements (setting up the power-on machine state) run when the module is instantiated, in source order, and the AssemblyScript compiler rejects any such code that reaches a global declared further down the file (`TS2448 ... used before its declaration`). For that reason this start-up block (`setMachineType(48)` and the `keyStates` fill) sits at the very end of core.ts.in, after every declaration it could touch, and any new top-level statement goes there too.

The gencore.js preprocessor recognises the following directives:

* `#alloc` - allocates an array of the given size and type. For example, if `#alloc frameBuffer[0x6600]: u8` is the first line of the file, then 0x6600 bytes from address 0 will be allocated to an array named `frameBuffer`. This will then rewrite subsequent lines as follows:
  * An assignment such as `frameBuffer = [0x00, 0x01, 0x02];` will be rewritten as a sequence of `store<u8>(0, 0x00);`, `store<u8>(1, 0x01);` lines
  * An assignment such as `frameBuffer[ptr] = 0x00;` will be rewritten as `store<u8>(0 + ptr, 0x00);`
  * A lookup such as `val = frameBuffer[ptr];` will be rewritten as `val = load<u8>(0 + ptr);`
  * `(&frameBuffer)` will be replaced with the array's base address, e.g. `const FRAME_BUFFER = (&frameBuffer);` becomes `const FRAME_BUFFER = 0;`
  * Keep in mind that these are simple regexp replacements, not a full parser - it's likely to fail on statements that are split over multiple lines, or have nested brackets. An assignment to an array element, or to a register, is only recognised at the start of a line, so the body of an `if` or `for` that assigns one goes on a line of its own, in braces; `if (x) frameBuffer[i] = 0;` on one line fails to compile. Comments are rewritten too, so a comment that names an array without an index or `&` stops the build with "getter not implemented"; describe the array instead of naming it. If you don't like this, feel free to submit a better implementation of static arrays to the AssemblyScript project :-)
* `#const` - defines an identifier to be replaced by the given expression. For example, given a directive `#const FLAG_C 0x01`, a subsequent line `result &= FLAG_C;` will be rewritten to `result &= 0x01;`. `const FLAG_C = 0x01;` would achieve the same thing, but will also define a symbol in the resulting module, which we probably don't want.
* `#regpair` - allocates two bytes to store a Z80 register pair. This is always little-endian, as per the WebAssembly spec. For example, if the next memory address to be allocated is 0x1000, then `#regpair BC B C` will define identifiers `BC`, `B` and `C` such that:
  * `val = BC;` is rewritten to `val = load<u16>(0x1000);`
  * `BC = 0x1234;` is rewritten to `store<u16>(0x1000, 0x1234);`
  * `val = B;` is rewritten to `val = load<u8>(0x1001);`
  * `B = result;` is rewritten to `store<u8>(0x1001, result);`
  * `val = C;` is rewritten to `val = load<u8>(0x1000);`
  * `C = result;` is rewritten to `store<u8>(0x1000, result);`
* `#optable` - generates the sequence of `case` statements that decode an opcode byte. The subroutine bodies for each class of instruction are defined in generator/instructions.js, and these are pattern-matched to the actual instruction lists in generator/opcodes_*.txt.
* `#op` - expands a single opcode case.

## Data formats

### Frame buffer

The frame buffer data structure (as written by the WebAssembly core and passed to the UI thread in the `frameCompleted` message) is essentially a log of all border, screen and attribute bytes in the order that they would be read to build the video output. This is based on a 320x240 output image consisting of 24 lines of upper border, 192 lines of main screen (each consisting of 32px left border, 256px main screen, and 32px right border), and 24 lines of lower border. This results in a 0x6600 byte buffer, breaking down as follows:

* 0x0000..0x009f: line 0 of the upper border. 160 bytes, each one being a border colour (0..7) and contributing two pixels to the final image. (This corresponds to the maximum resolution at which border colour changes happen on the Pentagon; these take effect on every cycle, and one cycle equals two pixels.)
* 0x00a0..0x013f: line 1 of the upper border
* ...
* 0x0e60..0x0eff: line 23 of the upper border
* 0x0f00..0x0f0f: left border of main screen line 0. 16 bytes, each contributing two pixels of border as before
* 0x0f10..0x0f4f: main screen line 0. 32*2 bytes, consisting of the pixel byte and attribute byte for each of the 32 character cells
* 0x0f50..0x0f5f: right border of main screen line 0. 16 bytes, each contributing two pixels of border as before
* 0x0f60..0x0f6f: left border of main screen line 1
* 0x0f70..0x0faf: main screen line 1. (Again, since the data here is in the order that the video output would be generated, this is the data pulled from address 0x4100 onward, not 0x4020.)
* 0x0fb0..0x0fbf: right border of main screen line 2
* ...
* 0x56a0..0x56af: left border of main screen line 191
* 0x56b0..0x56ef: main screen line 191
* 0x56f0..0x56ff: right border of main screen line 191
* 0x5700..0x579f: line 0 of the lower border. 160 bytes, as per upper border
* 0x57a0..0x583f: line 1 of the lower border
* ...
* 0x6560..0x65ff: line 23 of the lower border

## Tape playback

A tape in the worker (runtime/tape.js: `TAPFile`, `TZXFile`, or `CassetteTape` for a cassette in the tape recorder) feeds a `PulseGenerator`, which turns segments (tones, pulse sequences, data bits, pauses, sound recordings) into pulse lengths in the core's `TAPE_PULSES` buffer, each flipping the EAR level unless the segment sets the level itself (TZX blocks 0x19 and 0x2B, and sound recordings, TZX 0x15 and the cassette's own, whose samples are the level). A segment can also stop the tape (TZX 0x20 with a pause of 0, and 0x2A in 48K mode), which ends the worker's play as the end of the tape does, but leaves the rest to play when it is started again.

The tape's position is a count of T-states in the worker, and a seek to it (`seekToMs`) puts the generator before the block under the head with `skipTstates` set to how far into the block the head is: the generator eats that much from the front of the block's pulses as it makes them, whole pulses and then part of one, so Play starts with the signal that is there, tone, sync, data or the pause after, the level as it would be there, as a real tape plays from wherever it was wound to. The block a loader reads next is a separate question, answered by `getNextLoadableBlock`: with the tape standing still it is the first block from the head whose pilot tone the head is not yet past (to within `CATCH_MARGIN_MS`), since a block heard from its data on is only noise to a loader; while the tape plays, the generator's queue says which block is playing and `catchPlayingBlock` keeps a block whose tone is still going.

A TZX file is not played in block order: jumps, loops and calls move through it. The `TZXFile` walker's position is its control state, the next block plus the loop it is in and the calls it will return from. `buildTimeline` walks the file once as it would play, laying out a block in a loop once for each time round and leaving out blocks a jump passes over, and records the control state before each entry. The cassette counter, the list of parts and every seek work on that timeline, so winding to a place restores the walker exactly as playing up to it would have left it, except that winding to where a stop is leaves it behind, since the part after it starts there too. A file that plays for ever is laid out up to where its control state first repeats. The same test keeps a file whose jumps go round for ever from hanging the worker: a search for a block to load gives up once the walk comes back to a control state it has passed without finding one, and playing ends the tape once the walk comes back to one without any time having played. A call that would take the call stack past `MAX_CALL_STACK` places ends the tape, as calls that never return would otherwise grow it, and every timeline entry's copy of it, without end.

With instant loading, LD-BYTES is trapped (status 2) and `trapTapeLoad` copies the next block straight into memory, or for VERIFY compares it with memory, then leaves the registers and the carry flag as LD-BYTES itself would on return.

## Feature notes

### Pokes

The File → Pokes… dialog (runtime/pokes.js, with search and matching in runtime/pokes-db.js) browses a committed catalog of the complete Tipshop poke database, static/pokes/pokes.json (about 1.9 MB). It is lazy-fetched on first open, and regenerated with `node tools/gen-pokes-catalog.js <all-tipshop-pokes checkout>` from the [all-tipshop-pokes](https://github.com/ladyeklipse/all-tipshop-pokes) collection.

The loaded game's name is tracked in `Emulator.loadedGameName`, set by `setLoadedGame()` from `openFile` and `openUrl`; internal loads such as tape loader snapshots pass `{trackName: false}`. It is matched against catalog titles by article-free token overlap, since catalog names are TOSEC style ("Spy Who Loved Me, The") while loaded-game names come from a filename or URL ("007 - The Spy Who Loved Me").

Ticking a trainer sends an `applyPokes` message to the worker, which follows `.POK` semantics as FUSE takes them: bank 0 to 7 means that RAM page, for an address from 0xC000 on a machine that pages RAM; otherwise (bank bit 3 set, a 48K, or a lower address) the poke goes through the current paging. The worker replies with the overwritten bytes and their physical locations in `MACHINE_MEMORY`, kept in `Emulator.activePokes`, so unticking restores them to the same bytes whatever is paged in by then. `setLoadedGame()` clears that map.

### Tape recorder

The recorder's UI is runtime/tape-deck-ui.js; its cassettes are runtime/cassette.js (timing, files and parts of a cassette) and runtime/cassette-store.js (persistence). The cassette itself, played back by `CassetteTape` in runtime/tape.js, is described under Tape playback.

Cassettes live in IndexedDB, each as a TZX image with a label, a label colour, whether the write-protect tab is out and where the tape was left, so they survive a reload. Whether the recorder is connected, and which cassette is in it, is small enough to keep in localStorage instead. Every storage access is wrapped defensively, so a private-browsing tab or a cleared origin degrades to an empty recorder rather than breaking the emulator.

A cassette saves as a `.tzx` file whose pauses are the blank tape between its recordings, with sound recordings as direct recording blocks sampled at 44.3 kHz. It can also be saved as a `.tap` file of the data recordings one after another, which leaves the sound out. A TZX file with turbo or custom-loader blocks can't become a cassette, which is why it plays as a pre-recorded tape instead.

SAVE is caught at the ROM's SA-BYTES routine through the tape traps (status 3 when a block is about to be saved, and status 4 when a save recorded in real time returns), so a program's own turbo saver is not seen by them and is recorded only as sound while Record is held.

When Record is held, the speaker and MIC bits of port 0xFE are recorded alike, as one level that rises and falls with the socket's voltage, and a recording plays back as loud as anything else on tape. Only the beeper reaches the tape: the 128K's sound chip does not.

### ZX Interface 1 and Microdrives

The Microdrive dock, drive panel and cartridge box are in runtime/microdrive-ui.js, the cartridge format helpers in runtime/mdr.js and the persistence in runtime/microdrive-store.js. See runtime/mdr.js and generator/core.ts.in for why connecting and disconnecting the Interface 1 must never eject a cartridge.

The Interface 1 (edition 2 ROM) pages its shadow ROM in at the same addresses as the real one, the error restart at 0x0008 and CLOSE # at 0x1708, so its extended BASIC works unmodified.

A cartridge is a sequence of 10 to 254 blocks, one per physical sector, each 543 bytes: a 15-byte header, a 15-byte record descriptor, 512 data bytes and a checksum. A `.mdr` file is that many blocks back to back, optionally followed by one trailing write-protect byte. Cartridges live in IndexedDB as full `.mdr` images plus a label and a colour. The label is a copy of the name the cartridge was formatted with (empty when unformatted), kept so the cartridge box can list names without reading every image. Which cartridge is in each drive, and whether the Interface 1 is connected, is small enough to keep in localStorage. Renaming a cartridge rewrites the name in every sector header and leaves the files alone.

### ZX Printer

The printer's UI is runtime/printer-ui.js. It is emulated at the hardware level, after Sinclair's own description of it: two styli on a belt take turns across the paper, each on it for about 32ms and off it for about 16ms at full speed, an encoder gives 256 pulses across the 92mm print width of the 100mm paper, and the paper feeds one dot's height for every pass. It answers the port with address line A2 low, reporting the paper edge and each dot position to the program, which switches the stylus, the motor and its slow speed.

### Sessions

Saving and restoring a session is runtime/session.js. A session file is a ZIP of readable parts, so each can also be used on its own: `session.json` describing it, the machine as a standard `machine.szx` snapshot (which also records the Interface 1, the Pentagon's TR-DOS paging and a connected ZX Printer), the tape file as it was opened, every cassette as a `.tzx` file, every cartridge as an `.mdr` file, and the printout both as `printout.bin` (32 bytes per dot row) and as a picture, `printout.png`.

What SZX cannot carry goes in `session.json` beside `machine.szx` (`printerMechanism` and `microdriveMechanism`). The Microdrive mechanism is applied with `emu.setMicrodriveMechanism` only after `microdriveDock.sessionRestore` has put the cartridges back, since inserting a cartridge resets its drive.

### Dialogs and movable panels

Every File menu dialog opens through `openDialog(ui, emu, opts)` in runtime/dialog.js, which pauses the machine, handles Escape and `ui.hideDialog()`, and gives a light, movable, resizable window (`DialogFrame`, inside `appContainer` so it shows in fullscreen). Its place and size are kept per dialog in localStorage under `jsspeccy-dialogs` (a place only once the window has been dragged), never in saved sessions. Build dialog content with the `h()`, `button()` and `confirmButton()` helpers and the `jsd-` classes in `DIALOG_CSS`, not inline styles.

The dark device panels and the restore card are made draggable (and the recorder's and Microdrives' resizable) by `makeMovable` in runtime/movable.js, which keeps their places under `jsspeccy-panels` as offsets within `appContainer`. Their owners' positioning code calls `mover.place()` first and places them itself only when it returns false.

The devices themselves (recorder, drives, printer) are dragged by `makeDeviceMovable` in the same file. The owner stands its scaled element where it always did and the body inside is translated in drawn units (kept under `jsspeccy-panels` as `{dx, dy}`), the cable SVG's `draw(dx, dy)` redrawing the lead to the moved rear. Devices never overlap: a drag keeps a 2 px gap and slides along another, and a `settle()` pass puts a moved one back if it ends up overlapping. They may go off the page. A click on a cable resets that device and any moved into its place. The printer's element stands above the others (z-index 94) so its paper is never under them. `ui.makeRoomOnLeft` measures `[data-reach]` bodies so a device dragged further out still gets left margin, but never during a drag, since the page shifting under the pointer would skew it.

### Starter programs

The starter cassettes and cartridges hold original BASIC programs whose sources are in `starter/`: a listing for each program (`*.bas`), the guessing game's two trees (`things.txt` and `animals.txt`), and `starter.json`, which names each cassette and cartridge, its label, colour and write-protect tab, and what goes on it. `node tools/gen-starter.js`, run by hand after `npm run build`, makes `static/starter/` from them: a labelled `.tzx` file for each cassette, an `.mdr` file for each cartridge, and `index.json`, which the Starter programs dialog shows. They are committed, so the build only copies them.

The generator never writes the Spectrum's formats itself. `tools/zxheadless.js` runs a 48K Spectrum in Node, from the built core and the ROMs in `static/roms`, and `tools/zxbasic.js` turns each line of a listing into what the 48K editor holds once the line is typed: its number's digits, the keywords as tokens and the rest as characters. The line is put in the editor's line and entered with Enter, so the ROM checks it, refusing a mistake as it would a typed line, and adds the hidden 5-byte form of every number. The ROM's own `SAVE "name" LINE 10` then writes the tape blocks, caught at SA-BYTES as the worker catches them, and with the Interface 1 connected its `SAVE *` writes the files onto a cartridge made by `mdr.quickFormat`. A guessing game's tree goes onto a cartridge as the character array `t$()`, filled with `LET` commands and saved with `SAVE * ... DATA t$()`. A program with machine code names its assembly source in `starter.json`: `tools/z80asm.js`, a small two-pass assembler of the documented Z80 instructions, turns it into bytes, which go into the headless Spectrum's memory and onto the tape after the program with the ROM's `SAVE "name" CODE start,length`; the program loads them with `LOAD ""CODE`, as games of the time did.

ZOOM is that program: the Mandelbrot set in the screen's colour squares, redrawn in a second or so. Its numbers are 16-bit fixed point with 12 fraction bits, and every product comes from one table of squares the code builds at 28672 to 61439, since 2ab = (|a|+|b|)^2 - a^2 - b^2; the code sits at 61440, above 32768, where the screen does not slow the processor. A point in the main cardioid or the disc beside it is known to be inside before any step, a point whose orbit comes back exactly to where it was 8 steps before has settled into a cycle, and those two tests are what keep the black squares cheap. The fixed point limits the zoom to 64 times, where one square is 6/4096 wide.

A listing is written as a listing shows it, keywords in capitals as whole words and variables in small letters, so that a mistyped keyword is refused rather than taken for a variable; inside quotes and REM, `\a` to `\u` stand for the user-defined graphics and `\xNN` for any character code. The headless Spectrum also runs a program and answers it, which is how to try one: given `opts.tape`, a list of blocks, LOAD reads them one after another; `enter` and `command` type into the editor, `press` and `type` press keys, `screen` reads the screen as text against the ROM's character set, `report` gives the report on the bottom line, `printed` holds the ZX Printer's rows and `cartridge` gives a drive's cartridge.

`runtime/starter.js` fills the boxes on a first visit, one where both boxes are empty and localStorage has no `jsspeccy-starter` entry, once the recorder and the drives are back as they were left and whatever the page opened at startup is in: every cassette and cartridge goes into the boxes, the first cassette into the recorder unless a tape is in it already, and each cartridge into its drive if that is empty. It never connects a device, and nothing goes into one that is disconnected. File → Starter programs… puts back whatever is missing the same way. A cassette or cartridge the box has is found by its label (a cartridge's is the name it was formatted with), so that one from an earlier set of starter programs, or the DATA cartridge the guessing game has saved onto, is kept rather than added again; failing that by its bytes, as an import finds it.

## Working on the project

These are the rules for changing the code, for people and for AI models alike.

### Where to make a change

* Edit the core in generator/core.ts.in, generator/instructions.js or the opcodes_*.txt tables, never in build/core.ts, which is generated and overwritten. Rerun `build:core` (or `watch`) to regenerate.
* Keep the lines the preprocessor touches single-line and simple (see The core code generator). A statement split across lines, or with nested brackets, breaks it.
* If you add or resize an `#alloc`, `memoryBase` in asconfig.json may need to rise. gencore.js fails the build when the allocations do not fit.
* asc ignores unknown keys in asconfig.json without a word. The wasm output key is `outFile`, and a misspelt one silently writes no `.wasm` and leaves the old one in `dist/`.
* Any new address the worker needs from the core is exported from core.ts.in as a `usize` constant, and the views in worker.js and test/test.js are kept in sync with it.
* Something a session must carry that SZX cannot goes in `session.json` (see Sessions).

### Public contract

The object returned by `JSSpeccy(...)` and the `opts` it accepts are used by third-party pages: `setZoom`, `setMachine`, `openUrl`, `loadSnapshotFromStruct`, `onReady`, `exit`, and options such as `machine`, `autoStart`, `sandbox`, `keyboardEnabled` and `uiEnabled`. See the Embedding section of deployment.md before changing any signature or default.

### Checking a change

* The conformance suite (`npm test`) covers the Z80 core only. Anything in the core, the generator or the opcode tables must pass it.
* For everything above the core, check in the browser: build, serve `dist/` as described above and open the page. Drive the emulator with the script API rather than by clicking. The bundled index.html keeps the emulator in the global `emu`, and `emu.machine`, `emu.keyboard` and `emu.tape` (documented in deployment.md) do what a user does by hand: `emu.machine.powerOn()` starts it, `emu.keyboard.typeBasic('PRINT 1\n')` types BASIC, `emu.tape.importCassette(bytes, name)` and `emu.tape.press('play')` work the recorder, and `emu.tape.until(status => ...)` waits for a state. Take a screenshot only to read the result, and fall back to clicking only for what the API does not reach, such as the menus.
* The machine starts switched off, and it runs only while its page is visible, since browsers hold back animation frames from a hidden page.
* Type BASIC with `emu.keyboard.typeBasic`, which takes each editor as it comes (keywords from their keys on the standard 48K ROM, spelled out in 128 BASIC and on gw03) and waits after each Enter until the line is in, however long the program; `emu.keyboard.type` types characters only, which garbles keywords on the standard 48K ROM. Press a key after a typed SAVE.

### Documentation

* Update the README when what a user sees changes, and these notes when the internals do. After a major change or a new feature, update both.
* Comments and documentation describe the present state only, never the history: not what the code used to do, where a file used to live or what a change replaced. Keep the reason a thing is the way it is, since that is still true.
* Write each paragraph of a Markdown file as one line, and break a line only where the format needs it (list items, headings, code, tables).
