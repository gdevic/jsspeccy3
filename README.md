# JSSpeccy 3

A ZX Spectrum emulator for the browser

## Features

* Emulates the Spectrum 48K, Spectrum 128K and Pentagon machines
* Handles all Z80 instructions, documented and undocumented
* Cycle-accurate emulation of scanline / multicolour effects
* AY and beeper audio
* Play using a joystick / gamepad connected to your PC (Kempston, Cursor and Sinclair)
* Loads SZX, Z80 and SNA snapshots
* Loads TZX and TAP tape images, instantly through the ROM loader or in real time
* Detects custom tape loaders (Speedlock and other turbo loaders) and plays the tape for them automatically, fast-forwarded when instant loading is on
* Loads any of the above files from inside a ZIP file
* ZX Interface 1 with two ZX Microdrives: format, save and load cartridges, and keep them in the browser between visits
* ZX Printer: LPRINT, LLIST and COPY print onto a scrolling roll of silver paper, which can be torn off or saved as a PNG
* Opens games straight from the PlayZX online catalog (~10,800 titles)
* 100% / 200% / 300% and fullscreen display modes, with a compact menu bar and toolbar at 100%
* A switched-off TV screen until the machine is started, which then powers on like a picture tube

## Implementation notes

JSSpeccy 3 is a complete rewrite of JSSpeccy to make full use of the web technologies and APIs available as of 2021 for high-performance web apps. The emulation runs in a Web Worker, freeing up the UI thread to handle screen updates, and sound plays from an AudioWorklet on the browser's audio thread, so a busy page can't starve it. The emulator core (consisting of the Z80 processor emulation and any auxiliary processes that are likely to interrupt its execution multiple times per frame, such as constructing the video output, reading the keyboard and generating audio) runs in WebAssembly, compiled from AssemblyScript (with a custom preprocessor).

## Pokes (game cheats)

The **File → Pokes…** menu item opens a cheat browser over a committed catalog of the complete Tipshop poke database (`static/pokes/pokes.json`: ~3,700 games, ~23,000 cheats, ~72,000 pokes, sourced from [The Tipshop](https://www.the-tipshop.co.uk/) via the [all-tipshop-pokes](https://github.com/ladyeklipse/all-tipshop-pokes) collection). The search box is pre-filled with the name of the loaded game (from an opened file or a URL) and matches titles fuzzily, so "007 - The Spy Who Loved Me" finds "Spy Who Loved Me, The". Ticking a cheat pokes it into emulated memory Multiface-style (honouring the `.POK` format's 128K bank field); unticking restores the bytes that were overwritten. Cheats whose value is user-selectable (e.g. "number of lives") get a small input field. The catalog is lazy-loaded on first use and can be regenerated with `node tools/gen-pokes-catalog.js <all-tipshop-pokes checkout>`.

## PlayZX game catalog

The **File → PlayZX open…** menu item browses the PlayZX catalog of ZX Spectrum tape images and loads one straight into the emulator. The **All** tab walks the catalog by initial letter, then by title, then lists the individual releases under that title (publisher, year, playing time, and any variation note). The **Search** tab is a live query box: plain text matches a title prefix, a leading space matches a publisher prefix, a leading `=` is spliced in as a raw SQL condition over the `Name, Pub, Year, Duration, Variation, Rating` columns, and a trailing `?` picks one match at random (two characters minimum, 100 results maximum). The menu item only appears when the page is served from a host the PlayZX server will mint a download session for, since everywhere else the browsing would work and every download would be refused; see `PLAYZX_HOSTS` in `runtime/playzx-session.js`.

## ZX Interface 1 and Microdrives

The toolbar button between the keyboard and printer buttons connects a ZX Interface 1 (edition 2 ROM) with two ZX Microdrives, or disconnects it, without resetting the machine. The drives stand to the left of the Spectrum, joined to it by a ribbon, and a drive's red light shows while its motor runs. The motor whirrs quietly, louder with a cartridge in. The Interface 1 pages its shadow ROM in at the same addresses as the real one (the error restart at 0x0008 and CLOSE # at 0x1708), so its extended BASIC works as documented, for example `FORMAT "m";1;"name"`, `SAVE *"m";1;"name"`, `LOAD *"m";1;"name"`, `VERIFY *"m";1;"name"`, `CAT 1`, `ERASE "m";1;"name"` and `OPEN #` streams to a Microdrive file. Use a 48K machine or 48 BASIC. The RS232 and ZX Net ports are not emulated.

Clicking a drive opens a panel above it for using a cartridge. An empty drive offers the cartridges in the box, a new blank cartridge, or an `.mdr` file from the PC. A loaded drive shows the tape loop with each sector's use, a CAT-style list of its files (clicking one gives the `LOAD *` command to type), a write-protect toggle, a Format button for a blank cartridge, and Eject. The cartridge's label shows its name, handwritten. Dropping an `.mdr` file onto a drive inserts it there; opening one through the File menu or the `openUrl` option puts it in the first free drive and connects the Microdrives.

**File → Microdrive cartridges…** opens the cartridge box, where cartridges are kept. Every cartridge lives in the browser's storage (IndexedDB) and survives a reload, as does which drive holds it. The box creates cartridges (blank, or already formatted with a name), imports `.mdr` files, imports or saves the whole box as a ZIP file, and for each cartridge shows its files, free space and drive, and can rename it, change its colour, save it to the PC as an `.mdr` file, duplicate it or delete it. A cartridge's name is the one FORMAT wrote on the tape, the same name CAT shows; renaming rewrites it in every sector header and leaves the files alone, which a real Microdrive could only do by reformatting.

## ZX Printer

The toolbar button between the Microdrive and fullscreen buttons connects a ZX Printer, or disconnects it, without resetting the machine. The printer stands to the right of the Spectrum, joined to it by its cable, and the printout rises out of it up to the top of the screen as it prints. `LPRINT`, `LLIST` and `COPY` work as on the real printer, from 48 BASIC or a program's own printer routine. A red light shows while the motor runs, and the motor buzzes quietly.

The printer is emulated at the hardware level, after Sinclair's own description of it: two styli on a belt take turns across the paper, each on it for about 32ms and off it for about 16ms at full speed, an encoder gives 256 pulses across the 92mm print width of the 100mm paper, and the paper feeds one dot's height for every pass. It answers the port with address line A2 low, reporting the paper edge and each dot position to the program, which switches the stylus, the motor and its slow speed. A full-screen `COPY` takes about 8½ seconds.

The printer measures its paper: a roll holds about 20m, and the panel shows how much is left. The roll, with its printout, stays with the browser session: it survives a reload, and a new session starts with a fresh roll, so save a printout to keep it. When the roll runs out, printing waits for paper just as on the real printer, where the ROM finds no paper edge; load a new roll to carry on, or press BREAK. Clicking the printer opens its panel, to load a new roll, tear the printout off, or save it to the PC as a PNG. The FEED button on top of the printer's right tower feeds blank paper while it is held down.

## Contributions

These days, releasing open source code tends to come with an unspoken social contract, so I'd like to set some expectations...

This is a personal project, created for my own enjoyment, and my act of publishing the code does not come with any commitment to provide technical support or assistance. I'm always happy to hear of other people getting similar enjoyment from hacking on the code, and pull requests are welcome, but I can't promise to review them or shepherd them into an "official" release on any sort of timescale. Managing external contributions is often the point at which a "fun" project stops being fun. If there's a feature you need in the project - feel free to fork.

## Embedding

JSSpeccy 3 is designed with embedding in mind. To include it in your own site, download [a release archive](https://github.com/gasman/jsspeccy3/releases) and copy the contents of the `jsspeccy` folder somewhere web-accessible. Be sure to keep the .js and .wasm files and the subdirectories in the same place relative to jsspeccy.js.

In the `<head>` of your HTML page, include the tag

```html
    <script src="/path/to/jsspeccy.js"></script>
```

replacing `/path/to/jsspeccy.js` with (yes!) the path to jsspeccy.js. At the point in the page where you want the emulator to show, place the code:

```html
    <div id="jsspeccy"></div>
    <script>JSSpeccy(document.getElementById('jsspeccy'))</script>
```

If you're suitably confident with JavaScript, you can put the call to `JSSpeccy` anywhere else that runs on page load, or in response to any user action.

The emulator sets its own width from the zoom level, so the containing element can simply fit it (for example `width: fit-content; margin: auto`). When connected, the Microdrives stand outside it to the left and the ZX Printer to the right, so leave room on either side of it.

You can also pass configuration options as a second argument to `JSSpeccy`:

```html
    <script>JSSpeccy(document.getElementById('jsspeccy'), {zoom: 2, machine: 48})</script>
```

The available configuration options are:

* `autoStart`: if true, the emulator will start immediately with no need to press the play button. Bear in mind that browser policies usually don't allow enabling audio without a user interaction, so if you enable this option (and don't put the `JSSpeccy` call behind an onclick event or similar), expect things to be silent.
* `autoLoadTapes`: if true, any tape files opened (either manually or through the openUrl option) will be loaded automatically without the user having to enter LOAD "" or select the Tape Loader menu option.
* `tapeAutoLoadMode`: specifies the mode that the machine should be set to before auto-loading tape files. When set to 'default' (the default), this is equivalent to selecting the Tape Loader menu option on machines that support it; when set to 'usr0', this is equivalent to entering 'usr0' in 128 BASIC then LOAD "" from the resulting 48K BASIC prompt (which leaves 128K memory paging available without the extra housekeeping of the 128K ROM - this mode is commonly used for launching demos).
* `machine`: specifies the machine to emulate. Can be `48` (for a 48K Spectrum), `128` (for a 128K Spectrum), or `5` (for a Pentagon 128).
* `openUrl`: specifies a URL, or an array of URLs, to a file (or files) to load on startup, in any supported snapshot, tape or archive format. Standard browser security restrictions apply for loading remote files: if the URL being loaded is not on the same domain as the calling page, it must serve [CORS HTTP headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) to be loadable.
* `zoom`: specifies the size of the emulator window; 1 for 100% size (one Spectrum pixel per screen pixel), 2 for 200% size and so on.
* `sandbox`: if true, all UI options for opening a new file are disabled, and the Microdrives and printer are not offered - useful if you're showcasing a specific bit of Spectrum software on your page.
* `tapeTrapsEnabled`: if true (the default), the emulator will recognise when the tape loading routine in the ROM is called, and load tape files instantly instead. Custom loaders that bypass the ROM routine cannot be trapped; the emulator recognises them sampling the tape, plays the tape for them, and runs the machine faster than real time until the loader stops. With this option off, a detected loader still starts the tape, but loading runs at normal speed.
* `keyboardEnabled`: True by default; if false, the emulator will not respond to keypresses.
* `uiEnabled`: True by default; if false, the menu bar and toolbar will not be shown.
* `keyboardMap`: if this is set to the value `"recreated"`, the emulator will accept keypresses in the encoded format emitted by the [Recreated ZX Spectrum](https://recreatedzxspectrum.com/) keyboard in "game mode". If it is unset or set to any other value, the emulator will accept keypresses as normal.
* `joystickEnabled`: True by default; if false, the emulator will ignore any joystick / gamepad connected to the host PC. When enabled, a physical joystick connected to the PC (and recognised by the browser's [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API)) is read and translated into the emulated machine's joystick input. The stick / d-pad controls direction, and any other button acts as fire.
* `joystickType`: selects how the PC joystick is presented to the emulated machine. Can be `"kempston"` (the default, reported on the Kempston port), `"cursor"` (mapped to the Cursor / Protek keys), `"sinclair1"` (Sinclair Interface 2 joystick 1, keys 6-0), `"sinclair2"` (Sinclair Interface 2 joystick 2, keys 1-5), or `"none"` (ignore the joystick). This can also be changed at runtime through the Joystick menu.
* `joystickDevice`: when more than one controller is connected, selects which one drives the emulator. The value is matched (case-insensitively) as a substring against the controller's name, so `"Wireless"` would pick a "Wireless Controller". If unset (the default), the first available controller is used. This can also be changed at runtime through the Controller menu. (Note: the browser's Gamepad API does not honour the Windows "default controller" setting, and only reveals a controller once a button has been pressed on it.)

For additional JavaScript hackery, the return value of the JSSpeccy function call is an object exposing a number of functions for controlling the running emulator:

```html
    <script>
        let emu = JSSpeccy(document.getElementById('jsspeccy'));
        emu.openFileDialog();
    </script>
```

* `emu.setZoom(zoomLevel)` - set the zoom level of the emulator
* `emu.enterFullscreen()` - activate full-screen mode
* `emu.exitFullscreen()` - exit full-screen mode
* `emu.toggleFullscreen()` - enter or exit full-screen mode
* `emu.setMachine(machine)` - set the emulated machine type
* `emu.setJoystickType(type)` - set the joystick type used for a PC joystick (`"kempston"`, `"cursor"`, `"sinclair1"`, `"sinclair2"` or `"none"`)
* `emu.setJoystickDevice(device)` - choose which physical controller drives the emulator, matched as a substring of its name (or `null` for the first available)
* `emu.getJoystickDevices()` - return the list of currently connected controllers as `{id, label}` objects
* `emu.openFileDialog()` - open the file chooser dialog
* `emu.openUrl(url)` - open the file at the given URL
* `emu.loadSnapshotFromStruct(snapshot)` - load a snapshot from the given data structure; the data format is currently undocumented but runtime/snapshot.js should give you a decent idea of it...
* `emu.onReady(callback)` - call the given callback once the emulator is fully initialised
* `emu.exit()` - immediately stop the emulator and remove it from the document

## Troubleshooting

If the emulator does not start, open the browser's developer console (on Chrome: View -> Developer -> JavaScript Console; on Firefox: Tools -> Browser Tools -> Browser Console) and check for any error messages.

If you see an error such as

```
TypeError: WebAssembly: Response has unsupported MIME type 'application/octet-stream' expected 'application/wasm'
```

then you need to configure the web server to serve .wasm files with the correct content type header. If you run your own Apache or Nginx server, follow these [instructions for editing /etc/mime.types](https://gist.github.com/WesThorburn/62ea13952749d6563ce2fb15b45f1ba8). If your hosting provider supports `.htaccess` files, upload one containing the line:

```
AddType application/wasm wasm
```

## Licence

JSSpeccy 3 is licensed under the GPL version 3 - see COPYING.
