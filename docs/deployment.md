# Deployment

How to build **JSSpeccy3 / dev**, put it on a page of your own, script it, and fix the common problems. It is a fork that extends the original JSSpeccy 3 with many features (see the [README](../README.md)), and this page covers the fork. How it works inside is in [tech_notes.md](tech_notes.md).

## Building

Building this fork from source needs Node.js 26 or later (`.nvmrc` names the version for nvm). Install the dependencies with `npm ci`, then run `npm run build`, which writes the complete site into `dist/`. The scripts run from any shell, cmd and PowerShell on Windows included. The debug build, `npm run watch`, `npm test` and the rest of how the project is built are in [tech_notes.md](tech_notes.md).

To try a build, serve `dist/` over HTTP, for example with `python -m http.server --directory dist`, and open the page in a browser. Opening `index.html` straight from disk does not work, because browsers do not load the worker and WebAssembly files into a page opened from a `file://` URL.

## Embedding

JSSpeccy 3 is designed with embedding in mind, and this fork keeps that and builds on it. To include it in your own site, download [a release archive](https://github.com/gdevic/jsspeccy3/releases) of this fork and copy the contents of the `jsspeccy` folder somewhere web-accessible. Be sure to keep the .js and .wasm files and the subdirectories in the same place relative to jsspeccy.js.

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

The emulator sets its own width from the zoom level, so the containing element can simply fit it (for example `width: fit-content; margin: auto`). When connected, the tape recorder and the Microdrives stand outside it to the left, the recorder above the drives, and the ZX Printer to the right, so leave room on either side of it.

You can also pass configuration options as a second argument to `JSSpeccy`:

```html
    <script>JSSpeccy(document.getElementById('jsspeccy'), {zoom: 2, machine: 48})</script>
```

The available configuration options are as follows (the `joystick` ones are new in this fork):

* `autoStart`: if true, the emulator will start immediately with no need to press the play button. Bear in mind that browser policies usually don't allow enabling audio without a user interaction, so if you enable this option (and don't put the `JSSpeccy` call behind an onclick event or similar), expect things to be silent.
* `autoLoadTapes`: if true, any tape files opened (either manually or through the openUrl option) will be loaded automatically without the user having to enter LOAD "" or select the Tape Loader menu option. Once the visitor changes Options → Auto-load tapes, or restores a session that changes it, the choice is remembered in the browser and takes the place of this option on later visits, unless `uiEnabled` is false or `sandbox` is true.
* `tapeAutoLoadMode`: specifies the mode that the machine should be set to before auto-loading tape files. When set to 'default' (the default), this is equivalent to selecting the Tape Loader menu option on machines that support it; when set to 'usr0', this is equivalent to entering 'usr0' in 128 BASIC then LOAD "" from the resulting 48K BASIC prompt (which leaves 128K memory paging available without the extra housekeeping of the 128K ROM - this mode is commonly used for launching demos).
* `machine`: specifies the machine to emulate. Can be `48` (for a 48K Spectrum), `128` (for a 128K Spectrum), or `5` (for a Pentagon 128).
* `openUrl`: specifies a URL, or an array of URLs, to a file (or files) to load on startup, in any supported snapshot, tape or archive format. Standard browser security restrictions apply for loading remote files: if the URL being loaded is not on the same domain as the calling page, it must serve [CORS HTTP headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) to be loadable.
* `zoom`: specifies the size of the emulator window; 1 for 100% size (one Spectrum pixel per screen pixel), 2 for 200% size and so on; fractions such as 1.5 work too. A size the visitor has chosen from the Display menu is remembered in the browser and takes its place on later visits, unless `uiEnabled` is false. Browsers only allow fullscreen in response to the user, so a remembered fullscreen opens at the size underneath it and goes fullscreen when the play button is pressed.
* `sandbox`: if true, all UI options for opening a new file are disabled, and the tape recorder, the Microdrives, the printer, the starter programs and saving and restoring sessions are not offered - useful if you're showcasing a specific bit of Spectrum software on your page.
* `tapeTrapsEnabled`: if true (the default), the emulator will recognise when the tape loading routine in the ROM is called, and load tape files instantly instead. Custom loaders that bypass the ROM routine cannot be trapped, and neither can a block a TZX file keeps as a pure tone, pulses, pure data or a recording, even one the ROM loads; the emulator recognises the loader sampling the tape, plays the tape for it, and runs the machine faster than real time until the loader stops. With this option off, a detected loader still starts the tape, but loading runs at normal speed. Once the visitor changes Options → Instant tape loading, or restores a session that changes it, the choice is remembered in the browser and takes the place of this option on later visits, unless `uiEnabled` is false.
* `keyboardEnabled`: True by default; if false, the emulator will not respond to keypresses.
* `uiEnabled`: True by default; if false, the menu bar and toolbar will not be shown.
* `starterPrograms`: True by default; if false, a first visit finds the cassette and cartridge boxes empty instead of holding the starter programs, and File → Starter programs… is not offered. They are never offered with `sandbox` true or `uiEnabled` false, where the boxes can't be opened.
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

* `emu.setZoom(zoomLevel)` - set the zoom level of the emulator (any positive factor, as for the `zoom` option); unlike a size the visitor chooses, it is not remembered for the next visit
* `emu.enterFullscreen()` - activate full-screen mode, which is not remembered for the next visit
* `emu.exitFullscreen()` - exit full-screen mode
* `emu.toggleFullscreen()` - enter or exit full-screen mode
* `emu.setMachine(machine)` - set the emulated machine type
* `emu.setJoystickType(type)` - set the joystick type used for a PC joystick (`"kempston"`, `"cursor"`, `"sinclair1"`, `"sinclair2"` or `"none"`)
* `emu.setJoystickDevice(device)` - choose which physical controller drives the emulator, matched as a substring of its name (or `null` for the first available)
* `emu.getJoystickDevices()` - return the list of currently connected controllers as `{id, label}` objects
* `emu.openFileDialog()` - open the file chooser dialog
* `emu.openUrl(url)` - open the file at the given URL
* `emu.loadSnapshotFromStruct(snapshot)` - load a snapshot from the given data structure; the data format is currently undocumented but runtime/snapshot.js should give you a decent idea of it...
* `emu.onReady(callback)` - call the given callback once the emulator is fully initialised: the files given in `openUrl` are open and `autoStart` has started the machine. Files opened, snapshots loaded and a machine chosen while it is still loading take effect once it has loaded, rather than being lost to its start-up
* `emu.exit()` - immediately stop the emulator and remove it from the document, with everything it hung on the page; returns a promise that resolves once what the tape recorder and the Microdrives held but hadn't kept yet has been sent back to be kept, and the emulator's worker has stopped
* `emu.machine` - the machine's power and pause, worked from a script (see below)
* `emu.keyboard` - the Spectrum's keyboard, pressed from a script (see below)
* `emu.tape` - the tape recorder and the cassette box, worked from a script (see below)

### Scripting the machine, the keyboard and the tape recorder

This fork adds `emu.machine`, `emu.keyboard` and `emu.tape`, which do from code what a user does with the machine, the keys and the recorder, to drive tests or a demo. The machine starts switched off unless the `autoStart` option is set, so a script switches it on first and gives it time to boot. It runs only while its page is visible, since browsers hold back animation frames from a hidden page.

* `emu.machine.state()` - `"off"`, `"running"` or `"paused"`
* `emu.machine.powerOn()` - switch the machine on and run it, as the play button over the screen does; returns the new state
* `emu.machine.powerOff()` - switch the machine off: it stops, showing a switched-off screen; returns the new state
* `emu.machine.pause()` and `emu.machine.resume()` - pause a running machine, and run a paused one again, as the toolbar's pause button does; `resume` throws for a machine that is switched off
* `emu.machine.setWarp(on)` - run the machine as fast as it can, silently, as holding F8 does, until `setWarp(false)` or a pause; only a running machine warps, and it returns whether it is warping. `emu.machine.warp()` tells whether it is

Keys are named `A` to `Z`, `0` to `9`, `ENTER`, `SPACE` (or `BREAK_SPACE`), `CAPS_SHIFT` and `SYMBOL_SHIFT`, in any case; where a method takes keys, it takes one name or an array of names held together. Methods that take time return a promise. Every key is held for 80ms and let go for 120ms before the next, long enough for the ROM to take each one, the same key twice included; `opts` can set `holdMs` and `gapMs`.

* `emu.keyboard.press(keys, opts)` - hold the keys down together, then let them go, e.g. `press(['CAPS_SHIFT', 'SYMBOL_SHIFT'])` for extended mode
* `emu.keyboard.type(text, opts)` - type `text` a character at a time: letters (a capital with Caps Shift), digits, spaces, `\n` (or `\r\n`) for Enter, and the characters Symbol Shift types, such as `"`, `;`, `$`, `(`, `£` and `^` (the Spectrum's ↑); text with a character no key types is refused before any key goes down; for BASIC, use `typeBasic`
* `emu.keyboard.typeBasic(text, opts)` - type BASIC as someone at the keyboard would, into whichever of the ROM's editors is waiting (the standard 48K one, which takes keywords from their keys, or 128 BASIC and the gw03 ROM, which take them spelled out), switching on a paused machine; resolves once the last key is up. Keywords are written in capitals, as a listing shows them (`GOTO` and `GOSUB` also do), and are taken as keywords outside quotes and REM; `\n` is Enter, and before the next line the editor must have taken it, however long that takes as the program grows. It waits up to `opts.waitMs` (10 seconds unless given) for the editor, at the start and after each Enter, and fails, every key let go, with an `Error` saying why, and `line` and `column` where there are some: a character no key types (before any key goes down), the machine switched off, paused or not in its editor, a keyword where the editor can't take it, or a line it refused with its mistake marked. `opts.keywords` false types every word letter by letter, as for an answer to `INPUT`, and `opts.signal`, an `AbortSignal`, stops the typing between two keys. Calls one after another take turns
* `emu.keyboard.editor()` - the ROM's line editor waiting for a key, as `{kind, cursor, command, input}`, or `null` while anything else runs: `kind` 48 or 128, `cursor` `"K"`, `"L"`, `"C"`, `"E"` or `"G"`, `command` whether it waits for a command on an empty line, `input` whether it is a program's `INPUT`
* `emu.keyboard.keyDown(keys)` and `emu.keyboard.keyUp(keys)` - hold keys down, and let them go, for as long as the script wants
* `emu.keyboard.releaseAll()` - let every key go

The tape recorder calls resolve once the emulator has done what they ask, so `emu.tape.status()` then tells how things are. Where the page doesn't offer the recorder (`sandbox`, or `uiEnabled` false), everything but `status`, `parts` and `until` throws.

* `emu.tape.status()` - the recorder now: `{connected, kind, cassette, mode, auto, saving, loading, positionMs, lengthMs, blankFromMs, writeProtect, instantLoading}`, where `kind` is `"cassette"`, `"game"` or `null`, `cassette` is the box's `{id, label, colour, writeProtect}` for your cassette in the recorder, `mode` is the key held down (`"stop"`, `"play"`, `"record"`, `"rewind"` or `"ffwd"`), `auto` is set when a SAVE or a loader pressed it, and `saving` is set while a SAVE records in real time
* `emu.tape.parts()` - the parts on the tape, as the recorder's panel lists them: `{startMs, endMs, durationMs, name, typeName, length, loadCommand, damaged, sound}`; a pre-recorded tape's parts are named as the panel names them, with `typeName`, `length` and `loadCommand` null
* `emu.tape.connect()` and `emu.tape.disconnect()` - connect or disconnect the recorder
* `emu.tape.newCassette(label)` - put a new blank C60 in the box and in the recorder; resolves to its id in the box
* `emu.tape.importCassette(data, fileName)` - put a `.tap` or `.tzx` file's bytes in the box as a cassette, and in the recorder; resolves to its id (a cassette the box already has, rewound, rather than a second one)
* `emu.tape.cassettes()` - the cassettes in the box, without their bytes
* `emu.tape.insert(id)` - put the box's cassette `id` in the recorder
* `emu.tape.press(key)` - press one of the recorder's keys: `"play"`, `"record"`, `"rewind"`, `"ffwd"`, `"stop"` or `"eject"`
* `emu.tape.windTo(positionMs, opts)` - wind the tape to a place, as picking a part in the panel does, or at once with `{quiet: true}`; resolves when it is there
* `emu.tape.undo(opts)` - take back the last recording that recorded over something, once a SAVE that is still recording has let Record go; fails after `opts.timeoutMs` as `until` does
* `emu.tape.setWriteProtect(value)` - write-protect the cassette in the recorder, or allow recording on it
* `emu.tape.setInstantLoading(value)` - turn Options → Instant tape loading on or off for now; the visitor's own setting, kept for the next visit, is left as it was
* `emu.tape.data()` - the cassette in the recorder as a `.tzx` file's bytes, what has been recorded so far included, or `null`
* `emu.tape.until(condition, timeoutMs)` - resolve with the status once `condition(status)` is true, checking every 20ms, or fail after `timeoutMs` (10 seconds unless given)

For example, to record the sound of `BEEP 1,0` on a new cassette:

```javascript
emu.machine.powerOn();
await new Promise(resolve => setTimeout(resolve, 3000));  // the 48K boots
await emu.tape.newCassette('beep');
await emu.tape.press('record');
await emu.keyboard.press(['CAPS_SHIFT', 'SYMBOL_SHIFT']);  // extended mode
await emu.keyboard.press(['SYMBOL_SHIFT', 'Z']);           // BEEP
await emu.keyboard.type('1,0\n');
await new Promise(resolve => setTimeout(resolve, 2000));
await emu.tape.press('stop');
console.log(emu.tape.parts());  // a part whose typeName is "Sound"
```

The emulator's version is available, without starting it, as the string `JSSpeccy.version` (e.g. `"3.2.3"`). The bundled `index.html` shows it in the browser tab title.

## Troubleshooting

If the emulator does not start, or says it could not load its core, open the browser's developer console (on Chrome: View -> Developer -> JavaScript Console; on Firefox: Tools -> Browser Tools -> Browser Console) and check for any error messages.

If you see an error such as

```
TypeError: WebAssembly: Response has unsupported MIME type 'application/octet-stream' expected 'application/wasm'
```

then you need to configure the web server to serve .wasm files with the correct content type header. If you run your own Apache or Nginx server, follow these [instructions for editing /etc/mime.types](https://gist.github.com/WesThorburn/62ea13952749d6563ce2fb15b45f1ba8). If your hosting provider supports `.htaccess` files, upload one containing the line:

```
AddType application/wasm wasm
```

Run the emulator in one tab at a time. Everything it keeps in the browser (its settings, the cassette and cartridge boxes, what is in the recorder and the drives, the printer's roll, and where its dialogs and panels were left) is shared by every tab of that browser, and mostly goes by the tab that changed it last: the printout kept, for one, is the one from the tab that printed last. Only a cassette or cartridge recorded on in two tabs is kept twice, as two copies in its box.
