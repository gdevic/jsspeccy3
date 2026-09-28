import { FRAME_BUFFER_SIZE } from './constants.js';
import { TAPFile, TZXFile, CassetteTape } from './tape.js';
import { setCartridgeName } from './mdr.js';
import { blockMs, bytesThatFit, headerName, gameTapeLengthMs, SOUND_TSTATES_PER_SAMPLE } from './cassette.js';

let core = null;
let memory = null;
let memoryData = null;
let workerFrameData = null;
let registerPairs = null;
let tapePulses = null;
let soundEdges = null;

let tape = null;
let tapeIsPlaying = false;
let tapePositionTstates = 0;      // tape consumed since load/seek, drives the cassette counter
let framesSincePositionPost = 0;  // throttle position updates to the UI
let framesSinceTapeTrap = 0;      // frames since the machine last pulled a block through the trap
let tapeAutoPlayed = false;       // the tape was started by loader detection, not by the user
let autoPlaySuppressed = false;   // the user stopped the tape, so detection must not restart it
let loaderIdleFrames = 0;         // frames in which the machine read the port but no loader sampled it
let tapeTrapsEnabled = true;
let motorPosted = false;          // what the UI was last told: is the tape running at play speed

/* The tape recorder. While it is connected, whatever is in the tape slot is
 * in it: a game tape, or a cassette (a CassetteTape) that SAVE records onto.
 * Its keys move the tape: deckMode is the key held down, and deckAuto is set
 * when the machine pressed it rather than the user (a SAVE presses Record
 * and Play, and lets them go again once it is done). The tape's movement
 * while recording is accounted up to movedUntilT into the current frame, so
 * a trap part way through a frame starts from where the tape really is. */
let deckConnected = false;
let deckMode = 'stop';            // 'stop', 'play', 'record', 'rewind' or 'ffwd'
let deckAuto = false;
let deckReleaseFrames = 0;        // frames until a SAVE's keys are let go, 0 when not counting
let windSpeed = 0;                // winding speed, in play speeds
let windTop = 0;                  // the speed a wind builds up to
let windTarget = null;            // where a wind stops, or null to wind to the end
let windSeek = null;              // {quiet} when the wind is a jump from the counter, reported on arrival
let movedUntilT = 0;
let cassetteToken = null;         // the UI's id for the cassette in the slot
let cassetteSeq = null;           // which of the UI's inserts put it there, handed back with it
let cassetteDirty = false;        // it has been recorded on since it was last posted back
let framesSinceCassetteFlush = 0;
let pendingSave = null;           // a block being SAVEd in real time, until SA-BYTES returns
let undoBlocks = null;            // the cassette before the last recording erased something
let erasedNames = [];             // what the recording in progress has erased
let framesSinceDeckStatus = 0;
let framesSinceTrapLoad = 1000;   // frames since the LOAD trap last read a block
let loadingPosted = false;
let nothingAheadAt = null;        // the position the last "nothing ahead" hint was for
let deckJump = null;              // an instant SAVE or LOAD's jump along the tape, for the UI to show
let pendingDeckSound = null;      // {kind, time}: a key's sound, made when the next frame runs
let inFrame = false;              // a trap is being handled, part way through a frame

/* The machine's sound going onto a cassette while the user holds Record, as
 * a real recorder takes whatever is at the MIC socket (see setSoundRecording
 * in the core). The level changes are gathered, placed where the tape was at
 * the time, into a take: a sound recording from the first change to the
 * last, in soundTake while it goes on. A take ends once the level has held
 * still for SOUND_GAP_MS, the tape going on blank, and one with fewer than
 * SOUND_MIN_EDGES changes, such as the key clicks while typing SAVE, is left
 * off the tape. A take long enough to keep is put on the tape as it grows,
 * every SOUND_SYNC_FRAMES, in place of the last put there. */
let soundCapturing = false;       // the core is noting level changes
let soundTake = null;             // {startT, lastT, edges, level, count, bits, block}, positions in tape T-states
let framesSinceSoundSync = 0;
const SOUND_GAP_MS = 5000;
const SOUND_MIN_EDGES = 64;
const SOUND_SYNC_FRAMES = 25;

const DECK_AUTO_RELEASE_FRAMES = 75;  // ~1.5s after the last block of a SAVE
const DECK_STATUS_FRAMES = 4;         // status posts while the tape moves
const CASSETTE_FLUSH_FRAMES = 250;    // how often a long recording is posted back
const TRAP_LOAD_SHOWN_FRAMES = 25;    // Play shows down this long after a trapped load
const DECK_SOUND_STALE_MS = 150;      // a key's sound not made by then is dropped

/* Winding speeds, in play speeds: a wind starts at WIND_START and builds up
 * to WIND_MAX over WIND_RAMP_S; a jump to a part builds up faster, and
 * higher if need be, so that it arrives within about WIND_JUMP_S, braking
 * over the last WIND_BRAKE_S. */
const WIND_START = 10;
const WIND_MAX = 120;
const WIND_RAMP_S = 3;
const WIND_JUMP_S = 2;
const WIND_BRAKE_S = 0.25;

/* Interface 1 / Microdrive: per-drive bookkeeping the core doesn't expose
 * directly. mdrTokens identifies which cartridge (an opaque id from the UI's
 * storage layer) is in each drive, so a flush can be posted back with an id
 * that still points at the right record even if the drive's been swapped by
 * the time the message arrives; mdrBlocks is the sector count last passed to
 * insertMicrodrive, needed to know how many bytes of the drive's (always
 * full-size) slot in MICRODRIVE_DATA are actually its cartridge. */
let mdrTokens = [null, null, null, null, null, null, null, null];
let mdrSeqs = [null, null, null, null, null, null, null, null];  // the page's number for each drive's insert
let mdrBlocks = [0, 0, 0, 0, 0, 0, 0, 0];
let mdrFramesSinceFlush = [0, 0, 0, 0, 0, 0, 0, 0];
let mdrLastMotors = 0;
let mdrFramesSinceStatus = 0;

/* How often a still-spinning, still-dirty drive gets force-flushed anyway
 * (long multi-block SAVEs shouldn't sit unflushed for their whole duration),
 * and how often the LED/head status gets posted regardless of whether it
 * changed (so the UI's head-position animation stays smooth). */
const MDR_FORCE_FLUSH_FRAMES = 250;
const MDR_STATUS_INTERVAL_FRAMES = 4;

const TSTATES_PER_MS = 3500;

/* A load counts as "in flight" while the machine has pulled a block through the
 * tape trap within this many frames (~1s at 50fps). Seeking during one lets the
 * running loader pick up the new position by itself; seeking outside one leaves
 * nothing to read the tape, so the UI boots the tape loader to start a fresh
 * LOAD from where the user jumped to. */
const TRAP_IDLE_FRAMES = 50;

/* With instant loading on, a custom loader that the trap cannot catch is run faster
 * than real time instead: each frame request runs extra frames for up to this many
 * milliseconds while the detected loader has the tape playing. */
const FAST_LOAD_MS = 12;

/* An auto-started tape is stopped once this many frames (~0.5s) have read the
 * port without a loader sampling it in an edge-timing loop, so a multi-load game
 * waiting between levels finds the tape where the last load left it. A frame is
 * active if it saw at least LOADER_ACTIVE_READS loader-like reads, which a game
 * polling the keyboard does not reach. A frame with no reads at all counts
 * neither way: loaders sit in long delays without touching the port (the ROM
 * and Speedlock both wait about a second into the pilot tone), and a stop only
 * takes effect at a frame boundary, so stopping there would cut the tone short
 * or corrupt a block. */
const LOADER_IDLE_FRAMES = 25;
const LOADER_ACTIVE_READS = 10;

const tapePositionMs = () => tapePositionTstates / TSTATES_PER_MS;
const deckWinding = () => (deckMode === 'rewind') || (deckMode === 'ffwd');
// The recorder's tape is moving without being played back: loaders can't start it then.
const deckMoving = () => deckConnected && ((deckMode === 'record') || deckWinding());

/* The core's view of the tape: whether one is in, and whether it is moving,
 * which stops loader detection from starting it. */
const updateCoreTapeState = () => {
    if (core) core.setTapeState(!!tape, tapeIsPlaying || deckMoving());
};

// Tells the UI whether the tape is running at play speed: playing or recording.
const postMotor = () => {
    const running = tapeIsPlaying || (deckConnected && (deckMode === 'record'));
    if (running === motorPosted) return;
    motorPosted = running;
    postMessage({ message: running ? 'playingTape' : 'stoppedTape' });
};

const setTapePlaying = (playing, auto) => {
    if (playing == tapeIsPlaying) return;
    tapeIsPlaying = playing;
    tapeAutoPlayed = playing && !!auto;
    loaderIdleFrames = 0;
    if (deckConnected) {
        if (playing) {
            deckMode = 'play';
            deckAuto = !!auto;
        } else if (deckMode === 'play') {
            deckMode = 'stop';
            deckAuto = false;
        }
    }
    updateCoreTapeState();
    postMotor();
    if (deckConnected) postDeckStatus();
};

/* A tape freshly inserted or ejected starts out stopped. */
const resetTapeState = () => {
    tapeIsPlaying = false;
    tapeAutoPlayed = false;
    autoPlaySuppressed = false;
    deckMode = 'stop';
    deckAuto = false;
    deckReleaseFrames = 0;
    windSpeed = 0;
    windTarget = null;
    windSeek = null;
    updateCoreTapeState();
    postMotor();
};

/* ---------- the tape recorder ---------- */

// How long the tape in the slot is, as the recorder winds it.
const tapeLengthMs = () => {
    if (!tape) return 0;
    return tape.isCassette ? tape.lengthMs : gameTapeLengthMs(tape.totalMs);
};

/* Makes the sound of one of the recorder's keys (see playDeckSound in the
 * core): straight away inside a trap, otherwise at the start of the next
 * frame, so it falls in the audio it belongs with. */
const deckSound = (kind) => {
    if (!deckConnected) return;
    if (inFrame) {
        core.playDeckSound(kind);
    } else {
        pendingDeckSound = { kind, time: performance.now() };
    }
};

const updateDeckSound = () => {
    if (!core) return;
    const motor = !deckConnected ? 0 : ((deckMode === 'record') ? 2 : (tapeIsPlaying ? 1 : 0));
    const wind = (deckConnected && deckWinding()) ? Math.min(1, windSpeed / WIND_MAX) : 0;
    core.setDeckSound(motor, wind);
};

const postDeckStatus = () => {
    framesSinceDeckStatus = 0;
    const loading = framesSinceTrapLoad < TRAP_LOAD_SHOWN_FRAMES;
    loadingPosted = loading;
    const speed = !tape ? 0 : ((deckMode === 'rewind') ? -windSpeed : ((deckMode === 'ffwd') ? windSpeed
        : ((tapeIsPlaying || (deckMode === 'record')) ? 1 : 0)));
    postMessage({
        message: 'tapeDeckStatus',
        connected: deckConnected,
        mode: deckMode,
        auto: deckAuto,
        loading,
        positionMs: tapePositionMs(),
        speed,
        lengthMs: tapeLengthMs(),
        kind: tape ? (tape.isCassette ? 'cassette' : 'game') : null,
        writeProtect: tape ? (!tape.isCassette || tape.writeProtect) : false,
        saving: !!pendingSave,
        jump: deckJump,
    });
    deckJump = null;
};

const postDeckHint = (kind, details) => {
    postMessage({ message: 'deckHint', kind, positionMs: tapePositionMs(), ...(details || {}) });
};

/* Posts the cassette's bytes back to the UI, to keep: when it has been
 * recorded on since the last time, or always if `force`. */
const flushCassette = (force) => {
    if (!tape || !tape.isCassette) return;
    syncSoundTake();
    if (!cassetteDirty && !force) return;
    cassetteDirty = false;
    framesSinceCassetteFlush = 0;
    const data = tape.toTZX();
    postMessage({
        message: 'cassetteData',
        token: cassetteToken,
        seq: cassetteSeq,
        data: data.buffer,
        positionMs: tapePositionMs(),
        writeProtect: tape.writeProtect,
    }, [data.buffer]);
};

/* Brings the recording tape up to `toT` T-states into the frame, wiping it
 * as it goes past the head, and recording the machine's sound onto it if
 * it is going there. Stops at the end of the tape. */
const advanceRecording = (toT) => {
    if (!deckConnected || (deckMode !== 'record') || !tape || !tape.isCassette || (toT <= movedUntilT)) {
        movedUntilT = Math.max(movedUntilT, toT);
        return;
    }
    const fromT = movedUntilT;
    const fromMs = tapePositionMs();
    const toMs = Math.min(tape.lengthMs, fromMs + ((toT - movedUntilT) / TSTATES_PER_MS));
    movedUntilT = toT;
    noteErased(tape.erase(fromMs, toMs));
    tapePositionTstates = toMs * TSTATES_PER_MS;
    if (soundCapturing) takeSoundEdges(fromT, fromMs * TSTATES_PER_MS, toMs * TSTATES_PER_MS);
};

/* Notes what a recording erased, by the names in its headers; a block
 * without one, sound recordings included, counts once, as '', unless its
 * header went too. */
const noteErased = (blocks) => {
    if (!blocks.length) return;
    cassetteDirty = true;
    for (const block of blocks) {
        const name = (block.data && (block.data[0] === 0x00)) ? headerName(block.data) : '';
        if (!erasedNames.includes(name)) erasedNames.push(name);
    }
    postTapeInfo();
};

/* Whether the machine's sound goes onto the tape: while the user holds
 * Record, but not while a SAVE is recording a block in real time. */
const updateSoundCapture = () => {
    const on = deckConnected && (deckMode === 'record') && !deckAuto && !pendingSave && !!tape && tape.isCassette;
    if (on === soundCapturing) return;
    soundCapturing = on;
    if (core) core.setSoundRecording(on);
    if (!on) endSoundTake();
};

/* Takes the level changes the core has noted, since the machine was at
 * fromT in the frame and the tape at fromTapeT (T-states along it), into
 * the take. The tape has since got to toTapeT, and a change the machine made
 * at the very end of the frame is placed there. */
const takeSoundEdges = (fromT, fromTapeT, toTapeT) => {
    const count = core.getSoundEdgeCount();
    for (let i = 0; i < count; i++) {
        soundEdge(Math.min(toTapeT, fromTapeT + Math.max(0, soundEdges[i] - fromT)));
    }
    core.clearSoundEdges();
};

// A change of level at `atT` along the tape: it starts a take, or carries one on.
const soundEdge = (atT) => {
    if (soundTake && ((atT - soundTake.lastT) >= (SOUND_GAP_MS * TSTATES_PER_MS))) endSoundTake();
    const take = soundTake;
    if (!take) {
        soundTake = { startT: atT, lastT: atT, edges: 1, level: 1, count: 0, bits: new Uint8Array(4096), block: null };
        return;
    }
    fillSoundTake(take, Math.floor((atT - take.startT) / SOUND_TSTATES_PER_SAMPLE));
    take.level ^= 1;
    take.lastT = atT;
    take.edges++;
};

/* Fills the take's samples up to `end` with the level it has held since
 * its last change. What of the take is on the tape shares its buffer, but
 * only the samples before `count`, which this never changes. */
const fillSoundTake = (take, end) => {
    if (end <= take.count) return;
    if ((end >> 3) >= take.bits.length) {
        const bits = new Uint8Array(Math.max(take.bits.length * 2, (end >> 3) + 1));
        bits.set(take.bits);
        take.bits = bits;
    }
    if (take.level) {
        for (let i = take.count; i < end; i++) take.bits[i >> 3] |= 0x80 >> (i & 7);
    }
    take.count = end;
};

// Puts the take on the tape as it is so far, if it is long enough to keep.
const syncSoundTake = () => {
    framesSinceSoundSync = 0;
    const take = soundTake;
    if (!take || !tape || !tape.isCassette || (take.edges < SOUND_MIN_EDGES) || !take.count) return;
    if (take.block && (take.block.sound.count === take.count)) return;
    const sound = { bits: take.bits, from: 0, count: take.count, tstatesPerSample: SOUND_TSTATES_PER_SAMPLE };
    take.block = tape.putSound(take.startT / TSTATES_PER_MS, sound, take.block);
    cassetteDirty = true;
    postTapeInfo();
};

// The take is over: it stays on the tape if it is long enough to keep.
const endSoundTake = () => {
    if (!soundTake) return;
    syncSoundTake();
    soundTake = null;
};

/* Presses Record (and Play with it). A recording erases as it goes, so the
 * cassette as it was is kept first, for an undo, in place of the undo of the
 * recording before, which the UI stops offering. */
const engageRecord = (auto) => {
    if (tapeIsPlaying) setTapePlaying(false);
    if (deckWinding()) endWind(false);
    if (core) core.resetTapePulseBuffer();  // nothing plays back while recording
    deckMode = 'record';
    deckAuto = auto;
    deckReleaseFrames = 0;
    if (undoBlocks) postDeckHint('undoGone', {});
    undoBlocks = tape.snapshotBlocks();
    erasedNames = [];
    updateCoreTapeState();
    updateSoundCapture();
    postMotor();
    updateDeckSound();
};

/* The keys come up after recording: whatever was being SAVEd in real time
 * ends where the tape stopped, so does the machine's sound, and the cassette
 * goes back to the UI. */
const endRecording = () => {
    if (pendingSave) finishPendingSave(null);
    deckMode = 'stop';
    deckAuto = false;
    deckReleaseFrames = 0;
    updateSoundCapture();
    tape.seekToMs(tapePositionMs());
    flushCassette(false);
    if (erasedNames.length) {
        const names = erasedNames.filter(Boolean);
        const details = { names: names.length ? names : [''], canUndo: !!undoBlocks };
        // With the cassette on its way out, the hint follows its eject, which would clear it.
        if (releasingTape) recordedOverAfterEject = details;
        else postDeckHint('recordedOver', details);
    } else {
        undoBlocks = null;
    }
    erasedNames = [];
    updateCoreTapeState();
    postMotor();
};

const startWind = (direction, target, seek) => {
    deckMode = (direction < 0) ? 'rewind' : 'ffwd';
    deckAuto = false;
    windSpeed = WIND_START;
    windTarget = target;
    windSeek = seek;
    windTop = WIND_MAX;
    if (target !== null) {
        // fast enough to get there in about WIND_JUMP_S, allowing for speeding up and braking
        windTop = Math.max(WIND_MAX, (Math.abs(target - tapePositionMs()) / (WIND_JUMP_S * 1000)) * 1.6);
    }
    updateCoreTapeState();
    postMotor();
};

/* The wind is over: the tape is ready to play from where it stopped. If it
 * was a jump from the counter and got there, the UI hears about it as a
 * seek, to start a load if one is wanted. */
const endWind = (arrived) => {
    const seek = windSeek;
    windSpeed = 0;
    windTarget = null;
    windSeek = null;
    deckMode = 'stop';
    deckAuto = false;
    if (tape) tape.seekToMs(tapePositionMs());
    if (core) core.resetTapePulseBuffer();
    nothingAheadAt = null;
    updateCoreTapeState();
    postTapePosition();
    if (arrived && seek) postTapeSeeked(seek.quiet);
};

// Winds the tape for one frame of `frameMs`.
const windStep = (frameMs) => {
    const direction = (deckMode === 'rewind') ? -1 : 1;
    const positionMs = tapePositionMs();
    let limit = (direction < 0) ? 0 : tapeLengthMs();
    let top = WIND_MAX;
    let accel = (WIND_MAX - WIND_START) / WIND_RAMP_S;
    if (windTarget !== null) {
        limit = windTarget;
        top = Math.min(windTop, Math.max(WIND_START, Math.abs(windTarget - positionMs) / (WIND_BRAKE_S * 1000)));
        accel = windTop / 0.4;
    }
    windSpeed = Math.min(top, windSpeed + (accel * frameMs / 1000));
    let next = positionMs + (direction * windSpeed * frameMs);
    const arrived = (direction < 0) ? (next <= limit) : (next >= limit);
    if (arrived) next = limit;
    tapePositionTstates = next * TSTATES_PER_MS;
    if (arrived) {
        const jump = windTarget !== null;
        endWind(true);
        deckSound(jump ? 2 : 4);
        postDeckStatus();
    }
};

/* Winds the tape to `ms`: at once when `quiet` (restoring a session) or
 * already there, otherwise on the recorder, visibly. `seek` is set for a
 * jump from the counter. */
const windTo = (ms, seek, quiet) => {
    if (!tape) return;
    stopDeck();
    ms = Math.max(0, Math.min(ms, tapeLengthMs()));
    if (quiet || !deckConnected || (Math.abs(ms - tapePositionMs()) < 1)) {
        tapePositionTstates = ms * TSTATES_PER_MS;
        tape.seekToMs(ms);
        if (core) core.resetTapePulseBuffer();
        nothingAheadAt = null;
        postTapePosition();
        if (seek) postTapeSeeked(seek.quiet || quiet);
        if (deckConnected) postDeckStatus();
        return;
    }
    startWind((ms < tapePositionMs()) ? -1 : 1, ms, seek);
    deckSound(1);
    postDeckStatus();
};

// Lets every key up: the tape stops, whatever it was doing.
const stopDeck = () => {
    if (deckMode === 'record') endRecording();
    if (deckWinding()) endWind(false);
    if (tapeIsPlaying) setTapePlaying(false);
    deckMode = 'stop';
    deckAuto = false;
    updateCoreTapeState();
    postMotor();
};

/* One of the recorder's keys, pressed by the user. A key that can't go
 * down (Record on a write-protected cassette, say) springs back, with a hint
 * saying why. */
const pressDeckKey = (key) => {
    if (!deckConnected) return;
    if (!tape && (key !== 'stop')) {
        postDeckHint('noCassette', { key });
        return;
    }
    switch (key) {
        case 'play':
            // The tape plays on from where it stopped, or from where it was wound to.
            if (deckMode === 'play') return;
            stopDeck();
            autoPlaySuppressed = false;
            setTapePlaying(true);
            deckSound(1);
            break;
        case 'record':
            if (!tape.isCassette) { postDeckHint('gameTape', { key }); return; }
            if (tape.writeProtect) { postDeckHint('writeProtected', { key }); return; }
            if (deckMode === 'record') return;
            stopDeck();
            movedUntilT = 0;
            engageRecord(false);
            deckSound(1);
            break;
        case 'rewind':
        case 'ffwd':
            if ((deckMode === key) && (windTarget === null)) return;
            stopDeck();
            startWind((key === 'rewind') ? -1 : 1, null, null);
            deckSound(1);
            break;
        case 'stop':
            if ((deckMode === 'stop') && !tapeIsPlaying) return;
            stopDeck();
            autoPlaySuppressed = true;
            deckSound(2);
            break;
    }
    postDeckStatus();
};

/* Takes the tape out of the slot, or makes way for another: a cassette is
 * posted back with where it was left and why it went (`reason`: 'eject',
 * 'replaced', or 'parked' when the recorder is switched off). */
/* Set while releaseTape stops the deck: a recording it ends reports what it
 * recorded over after the cassette has gone, not before. */
let releasingTape = false;
let recordedOverAfterEject = null;

const releaseTape = (reason) => {
    if (!tape) return;
    // A recording ended by the cassette leaving can't be undone: the undo goes with it.
    undoBlocks = null;
    releasingTape = true;
    stopDeck();
    releasingTape = false;
    if (tape.isCassette) {
        flushCassette(false);
        postMessage({ message: 'cassetteEjected', token: cassetteToken, seq: cassetteSeq, positionMs: tapePositionMs(), reason });
        cassetteToken = null;
    }
    if (recordedOverAfterEject) {
        postDeckHint('recordedOver', recordedOverAfterEject);
        recordedOverAfterEject = null;
    }
    erasedNames = [];
    if (reason !== 'parked') deckSound(3);
};

/* A block being SAVEd in real time is over: SA-BYTES returned (`sent` is
 * how many bytes it put out), or the save was cut short (`sent` null) by the
 * keys coming up, the tape running out or the machine moving on. While the
 * tape recorded throughout, every byte SA-BYTES put out is on it, however
 * fast the machine's timing ran; otherwise what went onto the tape before
 * recording stopped is kept. The tape is then past the block, so what comes
 * next can't erase it. */
const finishPendingSave = (sent) => {
    const save = pendingSave;
    pendingSave = null;
    if (core) core.setSaveReturnTrap(false);
    if (!tape || !tape.isCassette) return;
    let keep;
    if ((sent !== null) && (save.recordStopMs === null)) {
        keep = Math.min(sent, save.bytes.length);
    } else {
        const stopMs = (save.recordStopMs !== null) ? save.recordStopMs : tapePositionMs();
        keep = Math.min((sent === null) ? save.bytes.length : sent, bytesThatFit(save.bytes, stopMs - save.startMs));
    }
    if (keep > 0) {
        const recorded = save.bytes.subarray(0, keep);
        tape.insertRecorded(save.startMs, recorded);
        const endMs = Math.min(tape.lengthMs, save.startMs + blockMs(recorded));
        if (tapePositionMs() < endMs) tapePositionTstates = endMs * TSTATES_PER_MS;
        cassetteDirty = true;
        flushCassette(false);
        postTapeInfo();
    }
    updateSoundCapture();
    if (deckAuto && (deckMode === 'record')) deckReleaseFrames = DECK_AUTO_RELEASE_FRAMES;
    if (deckConnected) postDeckStatus();
};

/* A real-time SAVE that never came back through SA/LD-RET (a program
 * jumping into the middle of SA-BYTES, say) is finished once the machine is
 * plainly doing something else. */
const checkPendingSave = () => {
    const pc = core.getPC();
    const romPage = memoryData[Number(core.MEMORY_PAGE_READ_MAP)];
    const inSaBytes = (pc >= 0x04c2) && (pc <= 0x053f) && ((romPage === 9) || (romPage === 10));
    if (!inSaBytes || (tapePositionMs() > pendingSave.deadlineMs)) finishPendingSave(null);
};

/* Status 3, SA-BYTES about to save a block, trapped while the recorder is
 * connected. With a cassette to record on, the SAVE presses Record and Play,
 * and the block goes onto the tape where it is: all at once with instant
 * tape loading on, when SA-BYTES is skipped, or as the ROM saves it for
 * real, when it is only noted here and kept once it is done (status 4).
 * Without one, the ROM just saves to nothing, and the UI is told why. */
const trapTapeSave = () => {
    if (!deckConnected) return;
    if (!tape || !tape.isCassette || tape.writeProtect) {
        postDeckHint(!tape ? 'noCassette' : (!tape.isCassette ? 'gameTape' : 'writeProtected'), { save: true });
        return;
    }
    const tNow = core.getTStates();
    advanceRecording(tNow);
    // A block still being recorded in real time is over once SA-BYTES starts another.
    if (pendingSave) finishPendingSave(null);
    // The block goes onto the tape in place of the machine's sound, which carries on after it.
    endSoundTake();
    const flag = registerPairs[0] >> 8;
    const start = registerPairs[8];  /* IX */
    const length = registerPairs[2];  /* DE */
    const sp = registerPairs[10];
    const bytes = new Uint8Array(length + 2);
    bytes[0] = flag;
    let parity = flag;
    for (let i = 0; i < length; i++) {
        const byte = core.peek((start + i) & 0xffff);
        bytes[i + 1] = byte;
        parity ^= byte;
    }
    bytes[length + 1] = parity;

    if (deckMode !== 'record') {
        engageRecord(true);
        movedUntilT = tNow;
        deckSound(1);
    }
    deckReleaseFrames = 0;
    const startMs = tapePositionMs();

    if (tapeTrapsEnabled) {
        const result = tape.record(startMs, bytes);
        noteErased(result.erased);
        cassetteDirty = true;
        tapePositionTstates = result.endMs * TSTATES_PER_MS;
        // kept at once, not only when the keys come up, in case the page goes first
        flushCassette(false);
        postTapeInfo();
        deckJump = { fromMs: startMs, toMs: result.endMs, kind: 'save' };
        if (!result.written) {
            postDeckHint('endOfTape', { save: true });
            endRecording();
            deckSound(4);
        } else {
            deckReleaseFrames = DECK_AUTO_RELEASE_FRAMES;
        }
        /* Leave the registers as SA-BYTES itself does on finishing: IX past
         * the parity byte, DE run down past zero, carry set; its RET then
         * goes through SA/LD-RET, which puts the border back. */
        registerPairs[8] = (start + length + 1) & 0xffff;  /* IX */
        registerPairs[2] = 0xffff;  /* DE */
        registerPairs[3] = 0x0000;  /* HL */
        registerPairs[1] = 0x000e;  /* BC */
        registerPairs[0] = 0x0051;  /* AF */
        core.setPC(0x053e);
    } else {
        const returnSP = (core.peek(sp) | (core.peek((sp + 1) & 0xffff) << 8)) === 0x053f ? ((sp + 2) & 0xffff) : null;
        pendingSave = {
            startMs, bytes, start, returnSP,
            deadlineMs: startMs + blockMs(bytes) + 2000,
            recordStopMs: null,
        };
        if (returnSP !== null) core.setSaveReturnTrap(true);
        updateSoundCapture();
    }
    postDeckStatus();
};

/* Status 4, SA/LD-RET reached while a SAVE is being recorded in real time:
 * the SAVE is over if this is SA-BYTES returning. IX tells how far it got,
 * stepping past each byte as it goes out: all of them, flag and parity
 * included, unless BREAK stopped it. */
const trapSaveReturn = () => {
    if (!pendingSave || (registerPairs[10] !== pendingSave.returnSP)) return;
    advanceRecording(core.getTStates());
    finishPendingSave(((registerPairs[8] - pendingSave.start) & 0xffff) + 1);
};

/* After every frame: the recorder's tape moves on while recording or
 * winding, the keys of a finished SAVE come up, and the UI hears about it. */
const serviceDeck = () => {
    if (framesSinceTrapLoad < 1000) framesSinceTrapLoad++;
    if (!deckConnected) return;
    const frameCycles = core.getFrameCycleCount();
    if (tape && (deckMode === 'record')) {
        advanceRecording(frameCycles);
        if (pendingSave) checkPendingSave();
        if (soundTake && (++framesSinceSoundSync >= SOUND_SYNC_FRAMES)) syncSoundTake();
        if (tapePositionMs() >= tape.lengthMs) {
            if (pendingSave) pendingSave.recordStopMs = tape.lengthMs;
            endRecording();
            postDeckHint('endOfTape', {});
            deckSound(4);
            postDeckStatus();
        } else if (deckAuto && !pendingSave && (deckReleaseFrames > 0) && (--deckReleaseFrames === 0)) {
            endRecording();
            deckSound(2);
            postDeckStatus();
        } else if (cassetteDirty && (++framesSinceCassetteFlush >= CASSETTE_FLUSH_FRAMES)) {
            flushCassette(false);
        }
    } else if (tape && deckWinding()) {
        windStep(frameCycles / TSTATES_PER_MS);
    }
    movedUntilT = 0;
    framesSinceDeckStatus++;
    const moving = tapeIsPlaying || deckMode === 'record' || deckWinding();
    const loading = framesSinceTrapLoad < TRAP_LOAD_SHOWN_FRAMES;
    if ((moving && (framesSinceDeckStatus >= DECK_STATUS_FRAMES)) || (loading !== loadingPosted)) postDeckStatus();
    if (moving && (framesSinceDeckStatus === 0)) postTapePosition();
};

/* A tape that goes round again (the toolbar's player) and has played to its
 * end starts again from the beginning. */
const rewindIfRunOut = () => {
    if (!tape.wrap || !tape.pulseGenerator.isAtEnd()) return;
    tape.seekToBlock(0);
    tapePositionTstates = 0;
    if (core) core.resetTapePulseBuffer();
    postTapePosition();
};

/* Start the tape when the core has seen a loader start sampling EAR, and stop it
 * once the loader has gone idle. Only a tape that detection started is stopped
 * by it, so a tape the user set playing keeps running. A cassette holds only
 * blocks the tape trap reads, so with instant loading on it is never started:
 * a LOAD with nothing ahead of it waits with the tape still. */
const serviceLoaderDetection = () => {
    const startRequested = core.takeLoaderStartRequest();
    const active = core.takeLoaderActivity() >= LOADER_ACTIVE_READS;
    const portRead = core.takeEarReads() > 0;
    const trapOnly = tape && tape.isCassette && tapeTrapsEnabled;
    if (startRequested && tape && !trapOnly && !tapeIsPlaying && !autoPlaySuppressed && (tape.wrap ? (tape.totalMs > 0) : !tape.pulseGenerator.isAtEnd())) {
        rewindIfRunOut();
        setTapePlaying(true, true);
    } else if (tapeIsPlaying && tapeAutoPlayed) {
        if (active) loaderIdleFrames = 0;
        else if (portRead) loaderIdleFrames++;
        if (loaderIdleFrames >= LOADER_IDLE_FRAMES) setTapePlaying(false);
    }
};

const postTapeInfo = () => {
    if (!tape) return;
    postMessage({
        message: 'tapeInfo',
        segments: tape.segments,
        totalMs: tape.totalMs,
        totalBytes: tape.totalBytes,
        positionMs: tapePositionTstates / TSTATES_PER_MS,
        blockIndex: tape.nextBlockIndex,
        nextBlockMs: nextBlockMs(),
        kind: tape.isCassette ? 'cassette' : 'game',
        lengthMs: tapeLengthMs(),
        blankFromMs: tape.isCassette ? tape.blankFromMs : tape.totalMs,
        writeProtect: !tape.isCassette || tape.writeProtect,
    });
};

/* A seek has moved the tape. Moving it is all that happens here: something
 * still has to read it, so the UI is told whether a load is already in
 * flight, to know whether one needs starting. */
const postTapeSeeked = (quiet) => {
    postMessage({
        message: 'tapeSeeked',
        loadInFlight: framesSinceTapeTrap < TRAP_IDLE_FRAMES || tapeIsPlaying,
        quiet: !!quiet,
        kind: tape ? (tape.isCassette ? 'cassette' : 'game') : null,
    });
};

// Where on the tape's timeline the next block starts, for a tape that can say; null otherwise.
const nextBlockMs = () => ((tape && tape.nextBlockStartMs) ? tape.nextBlockStartMs() : null);

const postTapePosition = () => {
    postMessage({
        message: 'tapePosition',
        positionMs: tapePositionTstates / TSTATES_PER_MS,
        blockIndex: tape ? tape.nextBlockIndex : 0,
        nextBlockMs: nextBlockMs(),
    });
    framesSincePositionPost = 0;
};

const loadCore = (baseUrl) => {
    WebAssembly.instantiateStreaming(
        fetch(new URL('jsspeccy-core.wasm', baseUrl), {})
    ).then(results => {
        core = results.instance.exports;
        memory = core.memory;
        memoryData = new Uint8Array(memory.buffer);
        workerFrameData = memoryData.subarray(core.FRAME_BUFFER, core.FRAME_BUFFER + FRAME_BUFFER_SIZE);
        registerPairs = new Uint16Array(core.memory.buffer, core.REGISTERS, 12);
        tapePulses = new Uint16Array(core.memory.buffer, core.TAPE_PULSES, core.TAPE_PULSES_LENGTH);
        soundEdges = new Uint32Array(core.memory.buffer, core.SOUND_EDGES, core.SOUND_EDGES_LENGTH);
        // the tape recorder may have been connected before the core was ready
        core.setSaveTraps(deckConnected);

        postMessage({
            'message': 'ready',
        });
    }).catch(err => {
        // a missing module, or one sent as some other type than application/wasm
        postMessage({ message: 'coreFailed', error: String((err && err.message) || err) });
    });
}

const loadMemoryPage = (page, data) => {
    memoryData.set(data, core.MACHINE_MEMORY + page * 0x4000);
};

/* Writes a cartridge's bytes into drive `drive`'s slice of MICRODRIVE_DATA
 * and tells the core about it. `data` is a full .mdr image (blocks*543
 * bytes, optionally with one trailing write-protect byte); a shorter
 * cartridge than the slot last held is fine, the slot is blanked first.
 * Flushes whatever cartridge was already in the drive first, so swapping
 * doesn't silently drop an unsaved change. `seq` is the page's number for
 * this insert, which the cartridge's flushes carry. */
const insertMicrodrive = (drive, data, token, seq) => {
    flushMicrodrive(drive);
    const bytes = new Uint8Array(data);
    const blockLen = core.MICRODRIVE_BLOCK_LEN;
    let dataLen = bytes.length;
    let writeProtect = false;
    if (dataLen % blockLen === 1) {
        writeProtect = !!bytes[dataLen - 1];
        dataLen -= 1;
    }
    const blocks = Math.floor(dataLen / blockLen);
    const offset = core.MICRODRIVE_DATA + drive * core.MICRODRIVE_DRIVE_BYTES;
    memoryData.fill(0xff, offset, offset + core.MICRODRIVE_DRIVE_BYTES);
    memoryData.set(bytes.subarray(0, blocks * blockLen), offset);
    core.insertMicrodrive(drive, blocks, writeProtect);
    mdrTokens[drive] = token;
    mdrSeqs[drive] = seq ?? null;
    mdrBlocks[drive] = blocks;
    mdrFramesSinceFlush[drive] = 0;
};

/* The drives' mechanism, which a saved session keeps beside the cartridges
 * (see getMicrodriveMechanism in the core): per drive its motor, head and
 * the counters of the half under the head, the COMMS CLK line, and the
 * block-halves whose preamble is part written, as [index, state]; every
 * other half's state follows from what is on the cartridge. */
const MDR_MECHANISM_FIELDS = 7;
const PREAMBLE_BYTES = 8 * 512;

const takeMicrodriveMechanism = () => {
    const drives = [];
    for (let d = 0; d < 8; d++) {
        const fields = [];
        for (let f = 0; f < MDR_MECHANISM_FIELDS; f++) fields.push(core.getMicrodriveMechanism(d, f));
        drives.push(fields);
    }
    const preambles = [];
    for (let i = 0; i < PREAMBLE_BYTES; i++) {
        const state = memoryData[core.MICRODRIVE_PREAMBLE + i];
        if ((state !== 0) && (state !== 0xff)) preambles.push([i, state]);
    }
    return { commsClk: !!core.getIF1CommsClk(), drives, preambles };
};

/* Puts back what takeMicrodriveMechanism took, once the cartridges are in
 * their drives again, since inserting one resets its drive. */
const setMicrodriveMechanism = (mechanism) => {
    if (!interface1Enabled || !mechanism || !Array.isArray(mechanism.drives)) return;
    const valid = (v) => Number.isInteger(v) && (v >= 0) && (v <= 0xffffffff);
    mechanism.drives.slice(0, 8).forEach((fields, d) => {
        if (!Array.isArray(fields)) return;
        fields.slice(0, MDR_MECHANISM_FIELDS).forEach((v, f) => {
            if (valid(v)) core.setMicrodriveMechanism(d, f, v);
        });
    });
    if (Array.isArray(mechanism.preambles)) {
        for (const entry of mechanism.preambles) {
            if (!Array.isArray(entry)) continue;
            const [i, state] = entry;
            if (Number.isInteger(i) && (i >= 0) && (i < PREAMBLE_BYTES) && Number.isInteger(state) && (state >= 1) && (state <= 12)) {
                memoryData[core.MICRODRIVE_PREAMBLE + i] = state;
            }
        }
    }
    core.setIF1CommsClk(!!mechanism.commsClk);
};

const ejectMicrodrive = (drive) => {
    flushMicrodrive(drive);
    core.ejectMicrodrive(drive);
    mdrTokens[drive] = null;
    mdrSeqs[drive] = null;
    mdrBlocks[drive] = 0;
};

/* Reads drive `drive`'s current bytes out of MICRODRIVE_DATA (if it's
 * inserted and dirty, or unconditionally for any inserted cartridge when
 * `force` is set) and posts them back as a .mdr image, also for a cartridge
 * with no token, so the page still sees what was saved on it. Returns
 * whether anything was sent. */
const flushMicrodrive = (drive, force) => {
    if (!mdrBlocks[drive]) return false;
    if (!force && !(core.getMicrodriveModified() & (1 << drive))) return false;
    const blockLen = core.MICRODRIVE_BLOCK_LEN;
    const dataLen = mdrBlocks[drive] * blockLen;
    const offset = core.MICRODRIVE_DATA + drive * core.MICRODRIVE_DRIVE_BYTES;
    const image = new Uint8Array(dataLen + 1);
    image.set(memoryData.subarray(offset, offset + dataLen));
    image[dataLen] = core.getMicrodriveWriteProtect(drive) ? 1 : 0;
    core.clearMicrodriveModified(drive);
    mdrFramesSinceFlush[drive] = 0;
    postMessage({
        message: 'microdriveData',
        drive,
        token: mdrTokens[drive],
        seq: mdrSeqs[drive],
        data: image.buffer,
    }, [image.buffer]);
    return true;
};

/* Called once per frame: posts LED/head-position status on change (or at
 * least every MDR_STATUS_INTERVAL_FRAMES, so the UI's head animation stays
 * smooth), and flushes a dirty drive once its motor stops, or periodically
 * anyway if it's been spinning and dirty for a long single save. */
const serviceMicrodrives = () => {
    if (!core.getMicrodriveMotors) return; // core predates this feature (shouldn't happen, but be defensive)
    const motors = core.getMicrodriveMotors();
    mdrFramesSinceStatus++;
    if (motors !== mdrLastMotors || mdrFramesSinceStatus >= MDR_STATUS_INTERVAL_FRAMES) {
        mdrLastMotors = motors;
        mdrFramesSinceStatus = 0;
        const heads = [];
        for (let d = 0; d < 8; d++) heads.push(core.getMicrodriveHeadPos(d));
        postMessage({ message: 'microdriveStatus', motors, heads });
    }
    const modifiedMask = core.getMicrodriveModified();
    for (let d = 0; d < 8; d++) {
        if (!(modifiedMask & (1 << d))) continue;
        mdrFramesSinceFlush[d]++;
        const motorOn = (motors & (1 << d)) !== 0;
        if (!motorOn || mdrFramesSinceFlush[d] >= MDR_FORCE_FLUSH_FRAMES) {
            flushMicrodrive(d);
        }
    }
};

/* Called once per emulated frame while the ZX Printer is connected: passes
 * on any rows printed since the last call, with the paper left and whether
 * the motor is running, and posts again whenever the motor starts or stops. */
let printerEnabled = false;
let interface1Enabled = false;
let printerLastMotor = false;
const servicePrinter = () => {
    if (!printerEnabled) return;
    const count = core.getPrinterRowCount();
    const motor = !!core.getPrinterMotor();
    if (!count && motor === printerLastMotor) return;
    printerLastMotor = motor;
    const rows = memoryData.slice(core.PRINTER_ROWS, core.PRINTER_ROWS + count * core.PRINTER_ROW_BYTES);
    core.clearPrinterRows();
    postMessage({ message: 'printerOutput', rows, paper: core.getPrinterPaper(), motor }, [rows.buffer]);
};

const SNAPSHOT_REGISTERS = ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR', 'PC'];

/* Throws if `snapshot` can't be loaded whole, so that one which can't
 * leaves the machine as it was rather than half changed. */
const checkSnapshot = (snapshot) => {
    if (![48, 128, 5].includes(snapshot.model)) throw 'Unsupported machine: ' + snapshot.model;
    if (!snapshot.registers || !SNAPSHOT_REGISTERS.every(r => Number.isInteger(snapshot.registers[r]))) {
        throw 'The snapshot has no complete set of registers';
    }
    if (!snapshot.ulaState) throw 'The snapshot has no border or paging state';
    for (const page in snapshot.memoryPages) {
        if (!/^[0-7]$/.test(page) || (snapshot.memoryPages[page].length !== 0x4000)) {
            throw 'The snapshot has an invalid RAM page: ' + page;
        }
    }
};

const loadSnapshot = (snapshot) => {
    checkSnapshot(snapshot);
    core.setMachineType(snapshot.model);
    for (let page in snapshot.memoryPages) {
        loadMemoryPage(page, snapshot.memoryPages[page]);
    }
    SNAPSHOT_REGISTERS.slice(0, 12).forEach((r, i) => {
        registerPairs[i] = snapshot.registers[r];
    });
    core.setPC(snapshot.registers.PC);
    core.setIFF1(snapshot.registers.iff1);
    core.setIFF2(snapshot.registers.iff2);
    core.setIM(snapshot.registers.im);
    core.setHalted(!!snapshot.halted);
    // Straight after EI an interrupt must wait for one more instruction.
    core.setInterruptible(!snapshot.eilast);

    core.writePort(0x00fe, snapshot.ulaState.borderColour);
    if (snapshot.model != 48) {
        core.writePort(0x7ffd, snapshot.ulaState.pagingFlags);
    }
    if (snapshot.ay) {
        for (let reg = 0; reg < 16; reg++) {
            core.writePort(0xfffd, reg);
            core.writePort(0xbffd, snapshot.ay.registers[reg] || 0);
        }
        core.writePort(0xfffd, snapshot.ay.selected);
    }
    // A saved session also records the Interface 1 paging and the printer
    // mechanism, which snapshot files don't carry.
    if ('interface1Paged' in snapshot) core.setInterface1Paged(!!snapshot.interface1Paged);
    if ('betadiskPaged' in snapshot) core.setBetadiskPaged(!!snapshot.betadiskPaged);
    if (snapshot.printer) {
        core.setPrinterMechanism(snapshot.printer.mechanism, snapshot.printer.phase);
        // the dots already burned on the row under the stylus
        const row = snapshot.printer.row;
        if (Array.isArray(row) && (row.length === 32)) memoryData.set(row.map(b => b & 0xff), core.PRINTER_ROW);
    }

    // A count past the end of the frame, which only a damaged file holds, wraps
    // round into it; left as it is, the machine would stand still for minutes.
    core.setTStates((snapshot.tstates >>> 0) % core.getFrameCycleCount());
};

/* The whole machine as it stands between two frames, in the structure the
 * snapshot parsers produce, plus what a saved session keeps beside it: the
 * Interface 1 paging, the printer mechanism, the live image of every
 * cartridge in a drive (it may hold writes not yet flushed), and the drives'
 * mechanism. */
const takeSnapshot = () => {
    const model = core.getMachineType();
    const registers = {};
    ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'].forEach((r, i) => {
        registers[r] = registerPairs[i];
    });
    registers.PC = core.getPC();
    registers.iff1 = !!core.getIFF1();
    registers.iff2 = !!core.getIFF2();
    registers.im = core.getIM();

    const memoryPages = {};
    const pages = (model == 48) ? [5, 2, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const page of pages) {
        const start = core.MACHINE_MEMORY + page * 0x4000;
        memoryPages[page] = memoryData.slice(start, start + 0x4000);
    }

    const ayRegisters = [];
    for (let reg = 0; reg < 16; reg++) ayRegisters.push(core.getAYRegister(reg));

    // the sound being recorded goes in the cassette as far as it has got
    syncSoundTake();

    const drives = [];
    for (let d = 0; d < 8; d++) {
        if (!mdrBlocks[d]) continue;
        const dataLen = mdrBlocks[d] * core.MICRODRIVE_BLOCK_LEN;
        const offset = core.MICRODRIVE_DATA + d * core.MICRODRIVE_DRIVE_BYTES;
        const image = new Uint8Array(dataLen + 1);
        image.set(memoryData.subarray(offset, offset + dataLen));
        image[dataLen] = core.getMicrodriveWriteProtect(d) ? 1 : 0;
        drives.push({ drive: d, token: mdrTokens[d], data: image });
    }

    return {
        model,
        registers,
        memoryPages,
        tstates: core.getTStates(),
        halted: !!core.getHalted(),
        eilast: !core.getInterruptible(),
        ulaState: { borderColour: core.getBorderColour(), pagingFlags: core.getPagingValue() },
        ay: { selected: core.getSelectedAYRegister(), registers: ayRegisters },
        interface1Connected: interface1Enabled,
        interface1Paged: !!core.getInterface1Paged(),
        betadiskPaged: !!core.getBetadiskPaged(),
        zxPrinter: printerEnabled,
        printer: {
            mechanism: core.getPrinterMechanism(),
            phase: core.getPrinterPhase(),
            row: Array.from(memoryData.subarray(core.PRINTER_ROW, core.PRINTER_ROW + 32)),
        },
        drives,
        microdriveMechanism: takeMicrodriveMechanism(),
        tapePositionMs: tapePositionMs(),
        // the cassette in the tape recorder, as it is now: it may hold recordings not posted back yet
        cassette: (tape && tape.isCassette)
            ? { token: cassetteToken, data: tape.toTZX(), positionMs: tapePositionMs(), writeProtect: tape.writeProtect }
            : null,
    };
};

const trapTapeLoad = () => {
    if (!tape) return;
    // Winding lifts the tape off the head, and recording plays nothing back.
    if (deckMoving()) return;
    framesSinceTapeTrap = 0;
    if (!tape.isCassette) tape.catchPlayingBlock();
    const fromMs = tapePositionMs();
    /* The block read is the first from the head whose pilot tone a loader
     * can still catch. A cassette finds it from the position; a game tape
     * too while it stands still, but playing, its queue of pulses says where
     * the head is, and the position is only where the pulses queued so far
     * have got to. */
    const block = tape.getNextLoadableBlock((tape.isCassette || !tapeIsPlaying) ? fromMs : null);
    if (!block) {
        // A block only a loader can read: LD-BYTES runs on, and loader detection plays the tape to it.
        if (tape.playsInRealTime) return;
        // Nothing more on the tape: LOAD waits, as it would for a real one.
        if (deckConnected && (nothingAheadAt !== fromMs)) {
            nothingAheadAt = fromMs;
            postDeckHint('nothingAhead', {});
        }
        return;
    }

    if (tape.isCassette) {
        // A cassette's counter moves on to the end of the block just read.
        tapePositionTstates = tape.lastLoadedEndMs * TSTATES_PER_MS;
        tape.seekToMs(tape.lastLoadedEndMs);
        if (tapeIsPlaying) core.resetTapePulseBuffer();
        postTapePosition();
    } else {
        // Advance the cassette counter: an instant (trapped) load jumps straight to
        // the end of the block it read.
        tapePositionTstates = tape.lastLoadedEndMs * TSTATES_PER_MS;
        /* A later part played in real time carries on from here: in the recorder
         * from where its counter now is, otherwise from the next block, with
         * what was left of any block playing dropped. */
        if (deckConnected && !tapeIsPlaying) {
            tape.seekToMs(tapePositionMs());
        } else {
            tape.pulseGenerator.reset();
            if (tapeIsPlaying) core.resetTapePulseBuffer();
        }
        postTapePosition();
    }
    if (deckConnected) {
        framesSinceTrapLoad = 0;
        nothingAheadAt = null;
        deckJump = { fromMs, toMs: tapePositionMs(), kind: 'load' };
        postDeckStatus();
    }

    /* get expected block type and load vs verify flag from AF' */
    const af_ = registerPairs[4];
    const expectedBlockType = af_ >> 8;
    const shouldLoad = af_ & 0x0001;  // LOAD rather than VERIFY
    let addr = registerPairs[8];  /* IX */
    const requestedLength = registerPairs[2];  /* DE */
    const actualBlockType = block[0];

    let success = true;
    if (expectedBlockType != actualBlockType) {
        success = false;
    } else {
        let offset = 1;
        let doneBytes = 0;
        let checksum = actualBlockType;
        let lastByte = 0;
        while (doneBytes < requestedLength) {
            if (offset >= block.length) {
                /* have run out of bytes to load */
                success = false;
                break;
            }
            const byte = block[offset++];
            checksum ^= byte;
            lastByte = byte;
            if (!shouldLoad && (core.peek(addr) !== byte)) {
                /* VERIFY stops at the first byte that differs, with IX on it (LD-VERIFY at 0x05BD) */
                success = false;
                break;
            }
            if (shouldLoad) core.poke(addr, byte);
            doneBytes++;
            addr = (addr + 1) & 0xffff;
        }

        // if loading is going right, we should still have a checksum byte left to read
        if (success) success = (offset < block.length);
        if (success) {
            const expectedChecksum = block[offset];
            lastByte = expectedChecksum;
            checksum ^= expectedChecksum;
            success = (checksum === 0);
        }

        /* Leave the registers as LD-BYTES itself does on return: IX past the
         * last byte stored or verified, DE counting the bytes still wanted, H
         * holding the running parity (0 on success) and L the last byte read.
         * Loaders run code from the block they just loaded that picks up from
         * IX, e.g. Tomahawk's BASIC decrypts itself relative to it. */
        registerPairs[8] = addr;  /* IX */
        registerPairs[2] = (requestedLength - doneBytes) & 0xffff;  /* DE */
        registerPairs[3] = ((checksum & 0xff) << 8) | lastByte;  /* HL */
    }

    if (success) {
        /* set carry to indicate success */
        registerPairs[0] |= 0x0001;
    } else {
        /* reset carry to indicate failure */
        registerPairs[0] &= 0xfffe;
    }
    core.setPC(0x05e2);  /* address at which to exit the tape trap */
}

/* The ROM's line editor waiting for a key, if one is, for the on-screen
 * keyboard (see runtime/keyboard-legends.js): {kind, cursor}, kind 48 or 128,
 * cursor 'K', 'L', 'C', 'E' or 'G'; null while anything else runs. IY holds
 * 0x5C3A whenever the ROM runs. The 48K editor (48 BASIC, INPUT in either
 * BASIC, TR-DOS) keeps its error return on the stack, ERR_SP pointing at
 * ED-ERROR (0x107F), where a running program's is MAIN-4. The 128 BASIC
 * editor runs in ROM 0 and keeps its flags in bank 7 at 0xEC0D: bit 7 waiting
 * for a key, bit 1 a menu showing. */
const editorState = () => {
    if (registerPairs[9] !== 0x5c3a) return null;
    const word = (addr) => core.peek(addr) | (core.peek((addr + 1) & 0xffff) << 8);
    const mode = core.peek(0x5c41);  // MODE: 1 extended, 2 graphics
    const capsLock = !!(core.peek(0x5c6a) & 0x08);  // FLAGS2 bit 3
    const cursor = (mode === 1) ? 'E' : ((mode === 2) ? 'G' : (capsLock ? 'C' : 'L'));
    if (word(word(0x5c3d)) === 0x107f) {
        // FLAGS bit 3 clear: a keyword comes next
        const keyword = (mode === 0) && !(core.peek(0x5c3b) & 0x08);
        return { kind: 48, cursor: keyword ? 'K' : cursor };
    }
    if ((core.getMachineType() !== 48) && !(core.getPagingValue() & 0x10) && (core.getPC() < 0x4000)) {
        const flags = memoryData[core.MACHINE_MEMORY + (7 * 0x4000) + 0x2c0d];
        if ((flags & 0x80) && !(flags & 0x02)) return { kind: 128, cursor };
    }
    return null;
};

/* At the start of a frame: the recorder's sounds for it, the motor's and
 * winding's as they are now, and a key's still waiting to be made. */
const startDeckSounds = () => {
    updateDeckSound();
    if (pendingDeckSound) {
        if ((performance.now() - pendingDeckSound.time) < DECK_SOUND_STALE_MS) core.playDeckSound(pendingDeckSound.kind);
        pendingDeckSound = null;
    }
};

// A playing tape's next frame's worth of pulses, for the core to play through the frame.
const playTapePulses = () => {
    if (!tape || !tapeIsPlaying) return;
    const tapePulseBufferTstateCount = core.getTapePulseBufferTstateCount();
    const tapePulseWriteIndex = core.getTapePulseWriteIndex();
    // a 128K with paging locked is in 48K mode
    const in48KMode = (core.getMachineType() === 48) || !!(core.getPagingValue() & 0x20);
    const [newTapePulseWriteIndex, tstatesGenerated, tapeStopped] = tape.pulseGenerator.emitPulses(
        tapePulses, tapePulseWriteIndex, 80000 - tapePulseBufferTstateCount, in48KMode
    );
    core.setTapePulseBufferState(newTapePulseWriteIndex, tapePulseBufferTstateCount + tstatesGenerated);
    // Advance the cassette counter by the tape actually played this frame.
    tapePositionTstates += tstatesGenerated;
    framesSincePositionPost++;
    if (tapeStopped || framesSincePositionPost >= 5) postTapePosition();
    if (tapeStopped) {
        setTapePlaying(false);
        deckSound(4);  // the recorder's auto stop
    }
};

/* A frame with the machine standing still, for the recorder running while
 * the machine is off or paused: the tape moves as it would through a
 * frame, playing, recording or winding, and the audio is what the recorder
 * alone makes (see runIdleFrame in the core). Returns whether the recorder
 * still has anything going on: the tape moving, or a sound of its own not
 * yet died away, which only counts while there is audio to make it in. */
const runIdleFrame = (withAudio) => {
    startDeckSounds();
    playTapePulses();
    core.runIdleFrame();
    serviceDeck();
    return tapeIsPlaying || deckMoving() || (withAudio && core.isDeckSounding());
};

const runEmulatedFrame = () => {
    if (framesSinceTapeTrap < TRAP_IDLE_FRAMES) framesSinceTapeTrap++;

    startDeckSounds();
    playTapePulses();

    let status = core.runFrame();
    while (status) {
        inFrame = true;
        switch (status) {
            case 1:
                throw("Unrecognised opcode!");
            case 2:
                trapTapeLoad();
                break;
            case 3:
                trapTapeSave();
                break;
            case 4:
                trapSaveReturn();
                break;
            default:
                throw("runFrame returned unexpected result: " + status);
        }
        inFrame = false;

        status = core.resumeFrame();
    }
    serviceLoaderDetection();
    serviceDeck();
    serviceMicrodrives();
    servicePrinter();
};

onmessage = (e) => {
    switch (e.data.message) {
        case 'loadCore':
            loadCore(e.data.baseUrl);
            break;
        case 'runFrame': {
            const frameBuffer = e.data.frameBuffer;
            const frameData = new Uint8Array(frameBuffer);

            let audioBufferLeft = null;
            let audioBufferRight = null;
            let audioLength = 0;
            if ('audioBufferLeft' in e.data) {
                audioBufferLeft = e.data.audioBufferLeft;
                audioBufferRight = e.data.audioBufferRight;
                audioLength = audioBufferLeft.byteLength / 4;
            }

            try {
                core.setAudioSamplesPerFrame(audioLength);
                runEmulatedFrame();
                if (tapeTrapsEnabled) {
                    const fastLoadStart = performance.now();
                    while (tapeIsPlaying && tapeAutoPlayed && (performance.now() - fastLoadStart) < FAST_LOAD_MS)
                        runEmulatedFrame();
                }
            } catch (err) {
                /* The UI waits for every frame it sends to come back, so a
                 * failed one still returns its buffers, unfilled. */
                inFrame = false;
                console.error(err);
                const buffers = audioLength ? [frameBuffer, audioBufferLeft, audioBufferRight] : [frameBuffer];
                postMessage({
                    message: 'frameFailed',
                    error: String((err && err.message) || err),
                    frameBuffer,
                    ...(audioLength ? { audioBufferLeft, audioBufferRight } : {}),
                }, buffers);
                break;
            }

            frameData.set(workerFrameData);
            const editor = editorState();
            if (audioLength) {
                const leftSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_LEFT, audioLength);
                const rightSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_RIGHT, audioLength);
                const leftData = new Float32Array(audioBufferLeft);
                const rightData = new Float32Array(audioBufferRight);
                leftData.set(leftSource);
                rightData.set(rightSource);
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                    audioBufferLeft,
                    audioBufferRight,
                    editor,
                }, [frameBuffer, audioBufferLeft, audioBufferRight]);
            } else {
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                    editor,
                }, [frameBuffer]);
            }

            break;
        }
        case 'runIdleFrame': {
            // The recorder's frame while the machine stands still: audio only.
            let audioLength = 0;
            if ('audioBufferLeft' in e.data) audioLength = e.data.audioBufferLeft.byteLength / 4;
            core.setAudioSamplesPerFrame(audioLength);
            const busy = runIdleFrame(audioLength > 0);
            if (audioLength) {
                const { audioBufferLeft, audioBufferRight } = e.data;
                new Float32Array(audioBufferLeft).set(new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_LEFT, audioLength));
                new Float32Array(audioBufferRight).set(new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_RIGHT, audioLength));
                postMessage({ message: 'idleFrameCompleted', busy, audioBufferLeft, audioBufferRight }, [audioBufferLeft, audioBufferRight]);
            } else {
                postMessage({ message: 'idleFrameCompleted', busy });
            }
            break;
        }
        case 'keyDown':
            core.keyDown(e.data.row, e.data.mask);
            break;
        case 'keyUp':
            core.keyUp(e.data.row, e.data.mask);
            break;
        case 'joystickKeyDown':
            core.joystickKeyDown(e.data.row, e.data.mask);
            break;
        case 'joystickKeyUp':
            core.joystickKeyUp(e.data.row, e.data.mask);
            break;
        case 'setKempstonState':
            core.setKempstonState(e.data.state);
            break;
        case 'setMachineType':
            if (pendingSave) finishPendingSave(null);
            core.setMachineType(e.data.type);
            break;
        case 'reset':
            if (pendingSave) finishPendingSave(null);
            core.reset();
            break;
        case 'loadMemory':
            loadMemoryPage(e.data.page, e.data.data);
            break;
        case 'renderScreen': {
            // The screen as memory holds it, the CPU not run.
            core.renderStaticFrame();
            const frameBuffer = e.data.frameBuffer;
            new Uint8Array(frameBuffer).set(workerFrameData);
            postMessage({ message: 'screenRendered', frameBuffer }, [frameBuffer]);
            break;
        }
        case 'barrier':
            // answered after everything posted before it
            postMessage({ message: 'barrier', id: e.data.id });
            break;
        case 'getSnapshot': {
            let snapshot = null;
            try {
                snapshot = takeSnapshot();
            } catch (err) {
                postMessage({ message: 'snapshot', id: e.data.id, snapshot: null, error: String(err) });
                break;
            }
            const transfers = Object.values(snapshot.memoryPages).map(p => p.buffer)
                .concat(snapshot.drives.map(d => d.data.buffer));
            if (snapshot.cassette) transfers.push(snapshot.cassette.data.buffer);
            postMessage({ message: 'snapshot', id: e.data.id, snapshot }, transfers);
            break;
        }
        case 'applyPokes': {
            /* Apply a list of {bank, address, value} pokes (.POK semantics,
             * as FUSE takes them: bank 0-7 is that 128K RAM page, for an
             * address from 0xC000 on a machine that pages its RAM; otherwise,
             * and with bank bit 3 set, the poke goes through the current
             * paging, as a Multiface's would). A poke given as {location,
             * value} goes straight to that byte, as undoing one does.
             * Replies with the bytes that were overwritten and where each
             * was, so the UI can put them back later, whatever is paged in
             * by then. */
            const writeMap = new Uint8Array(core.memory.buffer, core.MEMORY_PAGE_WRITE_MAP, 4);
            const pagesRAM = core.getMachineType() !== 48;
            const locationOf = (p) => {
                if (Number.isInteger(p.location)) return p.location;
                const address = p.address & 0xffff;
                const byBank = !(p.bank & 0x08) && pagesRAM && (address >= 0xc000);
                const page = byBank ? (p.bank & 0x07) : writeMap[address >> 14];
                return core.MACHINE_MEMORY + (page * 0x4000) + (address & 0x3fff);
            };
            const originals = [];
            const locations = [];
            for (const p of e.data.pokes) {
                const location = locationOf(p);
                locations.push(location);
                originals.push(memoryData[location]);
                memoryData[location] = p.value;
            }
            postMessage({
                message: 'pokesApplied',
                id: e.data.id,
                originals,
                locations,
            });
            break;
        }
        case 'loadSnapshot':
            if (pendingSave) finishPendingSave(null);
            try {
                loadSnapshot(e.data.snapshot);
            } catch (err) {
                postMessage({ message: 'fileOpened', id: e.data.id, mediaType: 'snapshot', error: String(err) });
                break;
            }
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'snapshot',
            });
            break;
        case 'openTAPFile':
        case 'openTZXFile': {
            let opened;
            try {
                opened = (e.data.message === 'openTAPFile') ? new TAPFile(e.data.data) : new TZXFile(e.data.data);
            } catch (err) {
                postMessage({ message: 'fileOpened', id: e.data.id, mediaType: 'tape', error: String(err) });
                break;
            }
            // A cassette in the recorder makes way, and goes back to the box.
            releaseTape('replaced');
            tape = opened;
            tape.wrap = !deckConnected;
            resetTapeState();
            tapePositionTstates = 0;
            framesSinceTapeTrap = TRAP_IDLE_FRAMES;
            nothingAheadAt = null;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
                quiet: !!e.data.quiet,
            });
            postTapeInfo();
            if (deckConnected) postDeckStatus();
            break;
        }
        case 'insertCassette': {
            /* A cassette into the tape recorder: a TZX file as runtime/cassette.js
             * writes it, `token` the UI's id for it, wound to where it was left. */
            let cassette;
            try {
                cassette = new CassetteTape(e.data.data, { writeProtect: !!e.data.writeProtect });
            } catch (err) {
                postMessage({ message: 'fileOpened', id: e.data.id, mediaType: 'cassette', error: String((err && err.message) || err) });
                break;
            }
            releaseTape('replaced');
            tape = cassette;
            cassetteToken = e.data.token ?? null;
            cassetteSeq = e.data.seq ?? null;
            cassetteDirty = false;
            resetTapeState();
            const positionMs = Math.max(0, Math.min(Number(e.data.positionMs) || 0, cassette.lengthMs));
            tapePositionTstates = positionMs * TSTATES_PER_MS;
            tape.seekToMs(positionMs);
            if (core) core.resetTapePulseBuffer();
            framesSinceTapeTrap = TRAP_IDLE_FRAMES;
            nothingAheadAt = null;
            postMessage({ message: 'fileOpened', id: e.data.id, mediaType: 'cassette', quiet: true });
            postTapeInfo();
            postDeckStatus();
            break;
        }
        case 'seekTape':
            if (tape) {
                autoPlaySuppressed = false;
                const atPart = Number.isFinite(e.data.positionMs);
                const toMs = atPart ? e.data.positionMs : (tape.blockStartMs[e.data.index] || 0);
                if (deckConnected) {
                    // The recorder winds there, and reports the seek on arriving.
                    windTo(toMs, { quiet: !!e.data.quiet }, !!e.data.quiet);
                    break;
                }
                if (atPart) tape.seekToMs(toMs);
                else tape.seekToBlock(e.data.index);
                tapePositionTstates = toMs * TSTATES_PER_MS;
                if (core) core.resetTapePulseBuffer();
                postTapePosition();
                postTapeSeeked(e.data.quiet);
            }
            break;
        case 'windTape':
            // The recorder winds to a position, e.g. a part picked from its panel.
            if (tape) windTo(Number(e.data.positionMs) || 0, null, !!e.data.quiet);
            break;
        case 'ejectTape':
            releaseTape(e.data.reason || 'eject');
            tape = null;
            resetTapeState();
            tapePositionTstates = 0;
            framesSinceTapeTrap = TRAP_IDLE_FRAMES;
            nothingAheadAt = null;
            if (core) core.resetTapePulseBuffer();
            postMessage({ message: 'tapeEjected' });
            if (deckConnected) postDeckStatus();
            break;

        case 'playTape':
            if (deckConnected) {
                pressDeckKey('play');
            } else if (tape) {
                autoPlaySuppressed = false;
                rewindIfRunOut();
                setTapePlaying(true);
            }
            break;
        case 'stopTape':
            if (deckConnected) {
                pressDeckKey('stop');
            } else if (tape) {
                autoPlaySuppressed = true;
                setTapePlaying(false);
            }
            break;
        case 'deckKey':
            pressDeckKey(e.data.key);
            break;
        case 'flushCassette':
            // The UI wants the cassette's latest bytes kept now, e.g. to show it in the box.
            flushCassette(false);
            break;
        case 'flushMicrodrives':
            // every drive with writes not yet sent back, as the emulator is about to stop
            for (let d = 0; d < 8; d++) flushMicrodrive(d);
            break;
        case 'setTapeDeck': {
            /* Connects or disconnects the tape recorder. Disconnecting stops
             * recording and winding, and a cassette in it has been parked by
             * the UI first; a game tape stays in, playing as it was. */
            const connected = !!e.data.connected;
            if (connected === deckConnected) break;
            if (!connected) {
                if (deckMode === 'record') endRecording();
                if (deckWinding()) endWind(false);
                deckMode = 'stop';
                deckAuto = false;
            }
            deckConnected = connected;
            if (connected && tapeIsPlaying) deckMode = 'play';
            // before the core has loaded, loadCore passes this on
            if (core) core.setSaveTraps(connected);
            if (tape && !tape.isCassette) {
                tape.wrap = !connected;
                // Connected, the tape carries on from where the counter says it is.
                if (connected && !tapeIsPlaying) tape.seekToMs(tapePositionMs());
            }
            updateCoreTapeState();
            updateDeckSound();
            postMotor();
            postDeckStatus();
            if (tape) postTapeInfo();
            break;
        }
        case 'setCassetteWriteProtect':
            if (tape && tape.isCassette) {
                tape.writeProtect = !!e.data.value;
                if (tape.writeProtect && (deckMode === 'record')) {
                    endRecording();
                    deckSound(2);
                }
                postTapeInfo();
                postDeckStatus();
            }
            break;
        case 'undoCassetteRecording':
            // Puts back what the last recording erased, and takes the recording off.
            if (tape && tape.isCassette && undoBlocks && (deckMode !== 'record')) {
                tape.restoreBlocks(undoBlocks);
                tape.seekToMs(tapePositionMs());
                undoBlocks = null;
                postDeckHint('undoGone', {});
                cassetteDirty = true;
                flushCassette(false);
                postTapeInfo();
                postDeckStatus();
            }
            break;
        case 'setTapeTraps':
            tapeTrapsEnabled = e.data.value;
            core.setTapeTraps(e.data.value);
            break;
        case 'setInterface1':
            // Flush every dirty drive before unpaging - disconnecting never
            // ejects a cartridge, but it's the natural moment to save it.
            if (!e.data.enabled) {
                for (let d = 0; d < 8; d++) flushMicrodrive(d);
            }
            interface1Enabled = !!e.data.enabled;
            core.setInterface1Enabled(interface1Enabled);
            break;
        case 'setPrinter':
            printerEnabled = !!e.data.enabled;
            core.setPrinterEnabled(printerEnabled);
            if (!printerEnabled && printerLastMotor) {
                printerLastMotor = false;
                postMessage({ message: 'printerOutput', rows: new Uint8Array(0), paper: core.getPrinterPaper(), motor: false });
            }
            break;
        case 'setPrinterPaper':
            // Confirmed straight back, so the page's paper count ends on
            // this value even if a report of the old roll was already on
            // its way.
            core.setPrinterPaper(e.data.rows);
            postMessage({ message: 'printerOutput', rows: new Uint8Array(0), paper: core.getPrinterPaper(), motor: printerLastMotor });
            break;
        case 'setPrinterFeed':
            core.setPrinterFeed(!!e.data.on);
            break;
        case 'insertMicrodrive':
            insertMicrodrive(e.data.drive, e.data.data, e.data.token, e.data.seq);
            break;
        case 'ejectMicrodrive':
            ejectMicrodrive(e.data.drive);
            break;
        case 'setMicrodriveMechanism':
            setMicrodriveMechanism(e.data.mechanism);
            break;
        case 'setMicrodriveWriteProtect':
            core.setMicrodriveWriteProtect(e.data.drive, !!e.data.value);
            // The flag travels in the image, which goes back at once to be kept.
            if (mdrBlocks[e.data.drive]) flushMicrodrive(e.data.drive, true);
            break;
        case 'setMicrodriveToken':
            if (mdrTokens[e.data.drive] === e.data.from) mdrTokens[e.data.drive] = e.data.token;
            break;
        case 'setCassetteToken':
            if (tape && tape.isCassette && (cassetteSeq === e.data.seq)) cassetteToken = e.data.token;
            break;
        case 'renameMicrodrive':
            // Renames the live copy, so nothing written since the last flush
            // is lost, then posts the whole image back straight away.
            if (mdrBlocks[e.data.drive]) {
                const offset = core.MICRODRIVE_DATA + e.data.drive * core.MICRODRIVE_DRIVE_BYTES;
                setCartridgeName(memoryData.subarray(offset, offset + mdrBlocks[e.data.drive] * core.MICRODRIVE_BLOCK_LEN), e.data.name);
                flushMicrodrive(e.data.drive, true);
            }
            break;
        default:
            console.log('message received by worker:', e.data);
    }
};
