JSSpeccy 3 Tech Notes
=====================

Architecture
------------

The browser UI thread (starting point in runtime/jsspeccy.js) is kept as lightweight as possible, only performing tasks that are directly related to communication with the "outside world": rendering the screen data to a canvas, handling keyboard events, outputting audio and managing UI actions such as loading files.

All the actual emulation happens inside a Web Worker (runtime/worker.js), with all communcation between the UI thread and the worker happening through `postMessage`. The most important messages are `runFrame` (sent from the UI thread to the worker, to tell it to run one frame of emulation and fill the passed video and audio buffers with the resulting output) and `frameCompleted` (sent from the worker to the UI thread when execution of the frame is complete, passing the filled video and audio buffers back).

Within the Web Worker, all of the performance-critical work is handled by a WebAssembly module (jsspeccy-core.wasm). The main entry point into this is the `runFrame` function, which runs the Z80 and all related 'continuous' processes (memory reads / writes, responding to port reads / writes, building the screen and generating audio) for one video frame. `runFrame` returns a status of 0 to indicate that the frame has completed execution (and thus the video / audio buffers are ready to send back to the UI thread), with other status values serving as 'exceptions', indicating that execution was interrupted and needs action from the calling code before it can be continued (by calling `resumeFrame`). The exceptions are the tape traps in the ROM: 2 when LD-BYTES is about to load a block (only with instant tape loading on), 3 when SA-BYTES is about to save one (only while the tape recorder is connected), and 4 when SA-BYTES returns from a save being recorded in real time; 1 means an unrecognised opcode. A trap handler may leave the PC where it is, since the instruction the machine resumes on is never trapped again.

All state required for the WebAssembly core module to run - including memory contents (ROM and RAM), registers, audio / video buffers and lookup tables - is contained within the module's own memory map, and statically allocated at compile time.

On the real machine, generating video and audio output happens in parallel with the Z80's execution - an emulator implementing this naïvely would have to break out of the Z80 loop every few cycles to perform these tasks. In fact, these processes can be deferred for as long as we like, as long as we catch up on them before any state changes occur that would affect the output. With this in mind, the JSSpeccy core implements two functions `updateFramebuffer` and `updateAudioBuffer` which perform all pending video / audio generation as far as the current Z80 cycle. These are called immediately before any state change (which means, for audio, a write to any AY register or the beeper port; and for video, a write to video memory, change of border colour or a write to the memory paging port).


Building the core
-----------------

To build jsspeccy-core.wasm, we run the script generator/gencore.js, which runs a preprocessing pass over the input file generator/core.ts.in, to generate the [AssemblyScript](https://www.assemblyscript.org/) source file build/core.ts (creating the build directory if needed). This is then passed to the AssemblyScript compiler to produce the final dist/jsspeccy/jsspeccy-core.wasm module.

The preprocessor step serves two purposes: firstly, it allows us to programmatically build the large repetitive `switch` statements that form the Z80 core. Secondly, it allows us to use conventional array syntax to access our statically-defined arrays. Currently, AssemblyScript does not appear to have any native support for static arrays - any use of array syntax causes it to immediately pull in a `malloc` implementation and a higher-level array construct with bounds checking, all of which is unwanted overhead for our purposes. The gencore.js processor rewrites array syntax into direct memory access [`load` / `store` instructions](https://www.assemblyscript.org/stdlib/builtins.html#memory).

All statically-defined arrays are allocated at the start of the module's memory map, from address 0 onward, each one starting on a multiple of its element size so that its loads and stores are aligned. Currently a 1664Kb block is allocated for these - if you need more, increase `memoryBase` in asconfig.json. gencore.js stops the build with an error if the allocations outgrow it.

The core's top-level statements (setting up the power-on machine state) run when the module is instantiated, in source order, and the AssemblyScript compiler rejects any such code that reaches a global declared further down the file. For that reason this start-up block sits at the very end of core.ts.in, after every declaration it could touch.

The gencore.js preprocessor recognises the following directives:

* `#alloc` - allocates an array of the given size and type. For example, if `#alloc frameBuffer[0x6600]: u8` is the first line of the file, then 0x6600 bytes from address 0 will be allocated to an array named `frameBuffer`. This will then rewrite subsequent lines as follows:
  * An assignment such as `frameBuffer = [0x00, 0x01, 0x02];` will be rewritten as a sequence of `store<u8>(0, 0x00);`, `store<u8>(1, 0x01);` lines
  * An assignment such as `frameBuffer[ptr] = 0x00;` will be rewritten as `store<u8>(0 + ptr, 0x00);`
  * A lookup such as `val = frameBuffer[ptr];` will be rewritten as `val = load<u8>(0 + ptr);`
  * `(&frameBuffer)` will be replaced with the array's base address, e.g. `const FRAME_BUFFER = (&frameBuffer);` becomes `const FRAME_BUFFER = 0;`
  * Keep in mind that these are simple regexp replacements, not a full parser - it's likely to fail on statements that are split over multiple lines, or have nested brackets. An assignment to an array element, or to a register, is only recognised at the start of a line, so the body of an `if` or `for` that assigns one goes on a line of its own, in braces; `if (x) frameBuffer[i] = 0;` on one line fails to compile. Comments are rewritten too, so a comment that names an array without an index or `&` stops the build with "getter not implemented". If you don't like this, feel free to submit a better implementation of static arrays to the AssemblyScript project :-)
* `#const` - defines an identifier to be replaced by the given expression. For example, given a directive `#const FLAG_C 0x01`, a subsequent line `result &= FLAG_C;` will be rewritten to `result &= 0x01;`. `const FLAG_C = 0x01;` would achieve the same thing, but will also define a symbol in the resulting module, which we probably don't want.
* `#regpair` - allocates two bytes to store a Z80 register pair. This is always little-endian, as per the WebAssembly spec. For example, if the next memory address to be allocated is 0x1000, then `#regpair BC B C` will define identifiers `BC`, `B` and `C` such that:
  * `val = BC;` is rewritten to `val = load<u16>(0x1000);`
  * `BC = 0x1234;` is rewritten to `store<u16>(0x1000, 0x1234);`
  * `val = B;` is rewritten to `val = load<u8>(0x1001);`
  * `B = result;` is rewritten to `store<u8>(0x1001, result);`
  * `val = C;` is rewritten to `val = load<u8>(0x1000);`
  * `C = result;` is rewritten to `store<u8>(0x1000, result);`
* `#optable` - generates the sequence of `case` statements that decode an opcode byte. The subroutine bodies for each class of instruction are defined in generator/instructions.js, and these are pattern-matched to the actual instruction lists in generator/opcodes_*.txt.


Tape playback
-------------

A tape in the worker (runtime/tape.js: `TAPFile`, `TZXFile`, or `CassetteTape` for a cassette in the tape recorder) feeds a `PulseGenerator`, which turns segments (tones, pulse sequences, data bits, pauses, sound recordings) into pulse lengths in the core's `TAPE_PULSES` buffer, each flipping the EAR level unless the segment sets the level itself (TZX blocks 0x19 and 0x2B, and sound recordings, TZX 0x15 and the cassette's own, whose samples are the level). A segment can also stop the tape (TZX 0x20 with a pause of 0, and 0x2A in 48K mode), which ends the worker's play as the end of the tape does, but leaves the rest to play when it is started again.

A TZX file is not played in block order: jumps, loops and calls move through it. The `TZXFile` walker's position is its control state, the next block plus the loop it is in and the calls it will return from. `buildTimeline` walks the file once as it would play, laying out a block in a loop once for each time round and leaving out blocks a jump passes over, and records the control state before each entry. The cassette counter, the list of parts and every seek work on that timeline, so winding to a place restores the walker exactly as playing up to it would have left it, except that winding to where a stop is leaves it behind, since the part after it starts there too. A file that plays for ever is laid out up to where its control state first repeats. The same test keeps a file whose jumps go round for ever from hanging the worker: a search for a block to load gives up once the walk comes back to a control state it has passed without finding one, and playing ends the tape once the walk comes back to one without any time having played. A call that would take the call stack past `MAX_CALL_STACK` places ends the tape, as calls that never return would otherwise grow it, and every timeline entry's copy of it, without end.

With instant loading, LD-BYTES is trapped (status 2) and `trapTapeLoad` copies the next block straight into memory, or for VERIFY compares it with memory, then leaves the registers and the carry flag as LD-BYTES itself would on return.


Frame buffer format
-------------------

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
