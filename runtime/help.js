/*
 * runtime/help.js: the Help menu's dialogs.
 *
 * openInstructions(ui, emu, opts) opens a quick guide: a card for each part
 * of the emulator, each a short list of "do this" and "get that", with the
 * toolbar's own icons. opts.sandbox leaves out what a sandbox does not
 * offer, and opts.playZX says whether File -> PlayZX open... is there.
 *
 * openAbout(ui, emu) opens the About box: the version, where the source and
 * the online emulator are, and where this fork comes from.
 *
 * Both open in the dialog window (dialog.js), which pauses the machine
 * while it is open.
 */

import { openDialog, h } from './dialog.js';

import sessionSaveIcon from './icons/session-save.svg';
import sessionRestoreIcon from './icons/session-restore.svg';
import resetIcon from './icons/reset.svg';
import pauseIcon from './icons/pause.svg';
import tapePlayIcon from './icons/tape_play.svg';
import ejectIcon from './icons/eject.svg';
import tapeRecorderIcon from './icons/tape-recorder.svg';
import keyboardIcon from './icons/keyboard.svg';
import microdriveIcon from './icons/microdrive.svg';
import printerIcon from './icons/printer.svg';
import fullscreenIcon from './icons/fullscreen.svg';

const REPO_URL = 'https://github.com/gdevic/jsspeccy3';
const README_URL = 'https://github.com/gdevic/jsspeccy3/tree/dev#readme';
const ONLINE_URL = 'https://baltazarstudios.com/files/jsspeccy/';
const ORIGINAL_URL = 'https://github.com/gasman/jsspeccy3';
const PLAYZX_ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.baltazarstudios.playzxtapes';

// The Spectrum's bright colours, softened: the card's accent, a darker one for text, and a tint.
const COLOURS = {
    red: ['#e0352b', '#a8231b', '#fdecea'],
    orange: ['#f07a18', '#a44d05', '#fff0e3'],
    yellow: ['#f2b705', '#7d5b00', '#fff6d9'],
    green: ['#2fa84f', '#1d7a37', '#e6f6ea'],
    cyan: ['#12a4c9', '#0b6f89', '#e2f5fa'],
    blue: ['#3b5bdb', '#2a3f9e', '#e8edfc'],
    magenta: ['#c43dab', '#8e2179', '#f9e8f6'],
};

// The four stripes on the Spectrum's case.
const RAINBOW = 'linear-gradient(115deg, transparent 0 28%, #e0352b 28% 42%, #f2b705 42% 56%, #2fa84f 56% 70%, #12a4c9 70% 84%, transparent 84%)';

const HELP_CSS = `
.jsh-scroll { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 4px; background: #f3f4f7; }
.jsh-hero { position: relative; overflow: hidden; display: flex; align-items: center; gap: 12px; margin-bottom: 14px;
    padding: 11px 150px 11px 16px; border-radius: 12px; background: #16181d; color: #e9ecf1; font-size: 13px; }
.jsh-hero b { color: #fff; font-size: 15px; }
.jsh-hero::after { content: ''; position: absolute; top: 0; right: -6px; bottom: 0; width: 140px; background: ${RAINBOW}; }
.jsh-cards { column-width: 300px; column-gap: 14px; }
.jsh-card { break-inside: avoid; margin-bottom: 14px; background: #fff; border-radius: 12px; overflow: hidden;
    border-top: 4px solid var(--c); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 14px rgba(0, 0, 0, 0.06); }
.jsh-head { display: flex; align-items: center; gap: 9px; padding: 8px 12px; background: var(--t); color: var(--d);
    font-size: 14px; font-weight: bold; }
.jsh-emoji { flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--c); display: flex;
    align-items: center; justify-content: center; font-size: 15px; line-height: 1; box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.15); }
.jsh-row { display: grid; grid-template-columns: minmax(0, 45%) minmax(0, 1fr); gap: 10px; align-items: start;
    padding: 5px 12px; font-size: 12.5px; line-height: 1.45; }
.jsh-row + .jsh-row { border-top: 1px dashed #e9ebef; }
.jsh-do { font-weight: bold; color: var(--d); overflow-wrap: anywhere; }
.jsh-get { color: #3d434a; overflow-wrap: anywhere; }
.jsh-tip { margin: 2px 10px 10px; padding: 6px 9px; border-radius: 8px; background: var(--t); color: #4a5058; font-size: 11.5px; }
.jsh-k { display: inline-block; font-family: Consolas, Monaco, monospace; font-size: 11.5px; font-weight: bold; line-height: 1.35;
    padding: 0 5px; border-radius: 4px; background: #fff; color: #1f2328; border: 1px solid #c9ced5; border-bottom-width: 2px;
    white-space: nowrap; }
.jsh-m { display: inline-block; max-width: 100%; padding: 0 6px; border-radius: 10px; background: var(--t); color: var(--d); line-height: 1.5; }
.jsh-c { font-family: Consolas, Monaco, monospace; font-size: 12px; color: #1f2328; background: #f1f2f4; padding: 0 4px; border-radius: 4px; }
.jsh-ico { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; width: 26px; height: 24px;
    border-radius: 5px; background: #f1f2f4; border: 1px solid #d3d7dc; }
.jsh-ico svg { display: block; width: 16px; height: 16px; }
.jsh-ico.text { width: auto; padding: 0 5px; font-family: Consolas, Monaco, monospace; font-size: 11px; font-weight: bold; color: #1f2328; }

.jsa-scroll { flex: 1; min-height: 0; overflow: auto; background: #fff; }
.jsa-hero { position: relative; overflow: hidden; padding: 20px 20px 18px; background: #16181d; color: #fff; }
.jsa-hero::after { content: ''; position: absolute; top: 0; right: -10px; bottom: 0; width: 150px; background: ${RAINBOW}; }
.jsa-name { position: relative; z-index: 1; font-size: 28px; font-weight: bold; letter-spacing: 0.5px; }
.jsa-version { display: inline-block; vertical-align: middle; margin-left: 8px; padding: 2px 9px; border-radius: 10px;
    background: #f2b705; color: #16181d; font-size: 13px; font-weight: bold; letter-spacing: 0; }
.jsa-tagline { position: relative; z-index: 1; margin-top: 3px; color: #b8bec7; font-size: 13px; }
.jsa-links { padding: 10px 12px 4px; }
.jsa-link { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 10px; }
.jsa-link:hover { background: var(--t); }
.jsa-link .jsh-emoji { width: 34px; height: 34px; font-size: 17px; }
.jsa-link-text { min-width: 0; }
.jsa-link-title { font-weight: bold; font-size: 13.5px; color: #1f2328; }
.jsa-link-url { display: block; font-size: 12px; color: var(--d); text-decoration: none; overflow-wrap: anywhere; }
.jsa-link-url:hover { text-decoration: underline; }
.jsa-link-note { font-size: 12px; color: #5f6670; }
.jsa-fork { margin: 6px 22px 18px; padding: 10px 12px; border-radius: 10px; background: #f3f4f7; color: #3d434a; font-size: 12.5px; line-height: 1.5; }
.jsa-fork a { color: #2a3f9e; font-weight: bold; }
`;

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Markup for the cards: a key to press, a menu path, BASIC, and a toolbar button.
const k = (key) => `<span class="jsh-k">${escapeHtml(key)}</span>`;
const m = (...path) => `<span class="jsh-m">${path.map(escapeHtml).join(' › ')}</span>`;
const c = (code) => `<span class="jsh-c">${escapeHtml(code)}</span>`;
const icon = (svg) => `<span class="jsh-ico">${svg}</span>`;
const textIcon = (text) => `<span class="jsh-ico text">${escapeHtml(text)}</span>`;

/* The cards, in reading order. A row is [what to do, what it does], with
 * {full: true} for what a sandbox does not offer and {playZX: true} for
 * what needs PlayZX; a card with full: true is left out of a sandbox
 * altogether. */
const CARDS = [
    {
        emoji: '⚡', title: 'Get going', colour: 'green',
        rows: [
            [`${textIcon('▶')} on the screen`, 'Switch the machine on'],
            ['Drop a file on the screen', 'Open it: snapshot, tape, ZIP, cartridge or session', { full: true }],
            [m('File', 'Open…'), 'The same, from a file picker', { full: true }],
            [m('File', 'Find games…'), 'Search the Internet Archive', { full: true }],
            [m('File', 'PlayZX open…'), 'Browse ~10,800 tapes; Enter or double-click loads', { playZX: true }],
            [m('Machine'), '48K, 48K gw03, 128K or Pentagon; choosing one reboots'],
        ],
        tip: 'Snapshots: SZX, Z80, SNA. Tapes: TAP, TZX. Any of them inside a ZIP.',
    },
    {
        emoji: '🧰', title: 'Toolbar', colour: 'blue',
        rows: [
            [`${icon(sessionSaveIcon)} ${icon(sessionRestoreIcon)}`, 'Save the whole session to the PC · restore one', { full: true }],
            [icon(resetIcon), 'Reset'],
            [icon(pauseIcon), 'Pause · resume'],
            [`${icon(tapePlayIcon)} ${icon(ejectIcon)}`, 'Start or stop the tape · eject it'],
            [textIcon('0:12/3:40'), 'Tape counter: click to jump to any part'],
            [icon(tapeRecorderIcon), 'Connect or disconnect the tape recorder', { full: true }],
            [icon(keyboardIcon), 'Show or hide the on-screen keyboard'],
            [icon(microdriveIcon), 'Connect or disconnect Interface 1 and Microdrives', { full: true }],
            [icon(printerIcon), 'Connect or disconnect the ZX Printer', { full: true }],
            [icon(fullscreenIcon), 'Fullscreen'],
        ],
        tip: 'Hover any button for its name. Nothing is reset when a device is connected.',
    },
    {
        emoji: '⌨️', title: 'PC keyboard', colour: 'yellow',
        rows: [
            [`${k('Shift')} or ${k('`')}`, 'CAPS SHIFT'],
            [k('Ctrl'), 'SYMBOL SHIFT'],
            [`${k('Shift')} + ${k('Ctrl')}`, 'Extended mode (E cursor)'],
            [k('Backspace'), 'DELETE'],
            [`${k('←')} ${k('↑')} ${k('↓')} ${k('→')}`, 'Cursor keys'],
            [`${k('"')} ${k(';')} ${k(':')} ${k('+')} ${k('=')} …`, 'Typed as on the PC, via SYMBOL SHIFT'],
            ['Numeric keypad', 'Digits'],
        ],
        tip: 'Keys reach the Spectrum only while it runs and has the focus: click the screen first.',
    },
    {
        emoji: '🎹', title: 'On-screen keyboard', colour: 'magenta',
        rows: [
            ['Click any legend', 'Enters that keyword or symbol, in any BASIC or TR-DOS'],
            ['Hover a legend', 'The line below names it and the keys it presses'],
            ['Hold the click', 'The key repeats'],
            [`${k('Shift')} + click a colour`, 'INK instead of PAPER'],
            [`${k('Shift')} + click a graphic`, 'The inverted block'],
            ['Tap a shift', 'Latched (blue) for the next key'],
            ['Tap it twice', 'Locked (ringed); tap again to free it'],
            ['One shift, then the other', 'Extended mode'],
            [m('Options', 'Simple keyboard'), 'The mouse presses whole keys'],
            ['Touchscreen', 'One finger per key, several at once'],
        ],
    },
    {
        emoji: '🔍', title: 'Characters on the screen', colour: 'cyan',
        rows: [
            [m('Options', 'Character picker'), 'Switches it on'],
            ['Click a character', 'Shows which it is, its CHR$ code and its keys'],
            ['Double-click it', 'Types it'],
            [`${k('Esc')} or click elsewhere`, 'Closes the bubble'],
        ],
        tip: 'The pointing hand over the picture means it is clickable.',
    },
    {
        emoji: '📼', title: 'Tapes', colour: 'red',
        rows: [
            [m('Options', 'Auto-load tapes'), 'An opened tape runs LOAD "" by itself', { full: true }],
            [m('Options', 'Instant tape loading'), 'On: loads in a flash. Off: real time, stripes and all'],
            ['Turbo and custom loaders', 'Detected and played for them'],
            ['Multi-load game', 'Click the counter to pick the next part'],
        ],
    },
    {
        emoji: '📻', title: 'Tape recorder', colour: 'orange', full: true,
        rows: [
            [c('SAVE "name"'), 'Records onto your cassette'],
            [c('LOAD ""'), 'Reads the next block ahead of the head: wind there first'],
            ['Play', 'Plays from where the tape is, mid-block included'],
            ['Click the recorder', 'The tape map; click a part to wind to it'],
            ['Type in', 'Types the LOAD command of a part into the Spectrum; press Enter'],
            ['Click the counter', 'Type a reading (0025 or 0:25) and it winds there'],
            ['Hold Record yourself', 'Records the beeper sound too'],
            ['Opened tapes', 'Play in it, write-protected'],
            ['Spectrum off or paused', 'The recorder still winds, plays and records'],
            [m('File', 'Tape cassettes…'), 'The box: blank C60s, TAP/TZX in and out, ZIP'],
        ],
        tip: 'Recording erases what it goes over; the recorder offers to undo it.',
    },
    {
        emoji: '💽', title: 'Microdrives', colour: 'blue', full: true,
        rows: [
            [c('FORMAT "m";1;"name"'), 'Format the cartridge in drive 1'],
            [c('SAVE *"m";1;"name"'), 'Save'],
            [c('LOAD *"m";1;"name"'), 'Load'],
            [c('CAT 1'), 'List the files'],
            ['Click a drive', 'Files, write-protect, Eject, Cartridge box, Save to PC'],
            ['Type in', 'Types the LOAD * command of a file into the Spectrum; press Enter'],
            ['Drop an .mdr on a drive', 'Inserts it'],
            [m('File', 'Microdrive cartridges…'), 'The cartridge box'],
        ],
        tip: 'Use a 48K machine, or 48 BASIC on a 128K.',
    },
    {
        emoji: '🖨️', title: 'ZX Printer', colour: 'magenta', full: true,
        rows: [
            [`${c('LPRINT')} ${c('LLIST')} ${c('COPY')}`, 'Print on the silver roll'],
            ['Mouse wheel or drag the paper', 'Scroll back through the printout'],
            ['Hold FEED (right tower)', 'Feeds blank paper'],
            ['Click the printer', 'New roll, tear off, save as PNG'],
            ['Roll runs out', 'Printing waits: new roll, or BREAK'],
        ],
    },
    {
        emoji: '💾', title: 'Sessions', colour: 'green', full: true,
        rows: [
            [icon(sessionSaveIcon), 'One ZIP: machine, tapes, cassettes, cartridges, printout, settings'],
            [`${icon(sessionRestoreIcon)} or drop the ZIP`, 'Shows what it holds and asks first'],
        ],
        tip: 'The parts inside the ZIP (SZX, TZX, MDR, PNG) work on their own too.',
    },
    {
        emoji: '🎮', title: 'Joystick & gamepad', colour: 'cyan',
        rows: [
            [m('Joystick'), 'Kempston, Cursor, Sinclair 1 or 2'],
            [m('Controller'), 'Which pad plays, when there are several'],
            ['Pad not listed?', 'Press a button on it'],
            ['Stick or d-pad', 'Directions; any other button fires'],
        ],
    },
    {
        emoji: '🎯', title: 'Cheats', colour: 'red', full: true,
        rows: [
            [m('File', 'Pokes…'), 'Finds the loaded game\'s cheats'],
            ['Tick a cheat', 'Applied at once'],
            ['Untick it', 'Undone'],
        ],
    },
    {
        emoji: '🖥️', title: 'Display', colour: 'yellow',
        rows: [
            [m('Display'), '100% to 400%; the slider catches on whole and half sizes'],
            [m('Display', 'Fullscreen'), 'The menus hide; move the mouse to bring them back'],
            [k('Esc'), 'Leaves fullscreen'],
        ],
        tip: 'The size is remembered for the next visit.',
    },
    {
        emoji: '🖱️', title: 'Dialogs & panels', colour: 'blue',
        rows: [
            ['Drag the title bar', 'Move it'],
            ['Drag the corner', 'Resize it'],
            ['Double-click the title', 'Maximize a dialog · put a panel back'],
            [k('Esc'), 'Closes a dialog'],
        ],
        tip: 'The machine pauses while a dialog is open, and each opens where it was left.',
    },
    {
        emoji: '🖐️', title: 'Move the devices', colour: 'orange', full: true,
        rows: [
            ['Drag the recorder, drives or printer', 'Wherever you like; the lead stretches to follow'],
            ['Push one into another', 'It slides along it: they never overlap'],
            ['Click a lead', 'Puts that device back, and any in its way'],
        ],
        tip: 'Open hand: drag it. Pointing finger: click it. Where they stand is kept in this browser, not in sessions.',
    },
];

function cardStyle(card, colour) {
    const [accent, dark, tint] = COLOURS[colour];
    card.style.setProperty('--c', accent);
    card.style.setProperty('--d', dark);
    card.style.setProperty('--t', tint);
}

function emojiBadge(emoji) {
    return h('span', 'jsh-emoji', { textContent: emoji, ariaHidden: 'true' });
}

export function openInstructions(ui, emu, opts) {
    const o = opts || {};
    const dialog = openDialog(ui, emu, {
        id: 'instructions', title: 'Instructions', subtitle: 'Everything worth knowing, at a glance',
        width: 880, height: 660,
    });
    const scroll = h('div', 'jsh-scroll');
    const hero = h('div', 'jsh-hero');
    hero.innerHTML = (o.sandbox ? '<b>Hover it, click it.</b>' : '<b>Hover it, click it, drop things on it.</b>')
        + '<span>Almost everything does something, as the real thing would.</span>';
    const cards = h('div', 'jsh-cards');
    for (const card of CARDS) {
        if (card.full && o.sandbox) continue;
        const rows = card.rows.filter(([, , flags]) => !(flags && ((flags.full && o.sandbox) || (flags.playZX && !o.playZX))));
        const elem = h('section', 'jsh-card');
        cardStyle(elem, card.colour);
        const head = h('div', 'jsh-head');
        head.append(emojiBadge(card.emoji), h('span', '', { textContent: card.title }));
        elem.appendChild(head);
        for (const [what, result] of rows) {
            const row = h('div', 'jsh-row');
            row.append(h('div', 'jsh-do', { innerHTML: what }), h('div', 'jsh-get', { innerHTML: result }));
            elem.appendChild(row);
        }
        if (card.tip) elem.appendChild(h('div', 'jsh-tip', { textContent: '💡 ' + card.tip }));
        cards.appendChild(elem);
    }
    scroll.append(hero, cards);
    dialog.body.append(h('style', '', { textContent: HELP_CSS }), scroll);
    const readme = h('a', '', { href: README_URL, target: '_blank', rel: 'noopener', textContent: 'README' });
    dialog.aside.append('The whole story: the ', readme);
    return dialog;
}

/* A row of the About box: an emoji badge, a title, and under it the link,
 * shown as `label` or else as its address, and `note` if given. */
function aboutLink(emoji, colour, title, url, note, label) {
    const row = h('div', 'jsa-link');
    cardStyle(row, colour);
    const text = h('div', 'jsa-link-text');
    text.append(h('div', 'jsa-link-title', { textContent: title }), h('a', 'jsa-link-url', {
        href: url, target: '_blank', rel: 'noopener', textContent: label || url.replace(/^https:\/\//, '').replace(/\/$/, ''),
    }));
    if (note) text.appendChild(note);
    row.append(emojiBadge(emoji), text);
    return row;
}

export function openAbout(ui, emu) {
    const dialog = openDialog(ui, emu, {
        id: 'about', title: 'About', width: 480, height: 480,
    });
    const scroll = h('div', 'jsa-scroll');

    const hero = h('div', 'jsa-hero');
    const name = h('div', 'jsa-name', { textContent: 'JSSpeccy 3' });
    name.appendChild(h('span', 'jsa-version', { textContent: 'v' + __JSSPECCY_VERSION__ }));
    hero.append(name, h('div', 'jsa-tagline', { textContent: 'A ZX Spectrum emulator for the browser' }));

    const links = h('div', 'jsa-links');
    links.append(
        aboutLink('🐙', 'blue', 'Source code on GitHub', REPO_URL),
        aboutLink('▶️', 'green', 'Play online, always running', ONLINE_URL),
        aboutLink('📱', 'orange', 'PlayZX games catalog on Android', PLAYZX_ANDROID_URL,
            h('div', 'jsa-link-note', { textContent: 'The PlayZX catalog of games is also available as an Android app' }),
            'Get it on Google Play'),
    );

    const fork = h('div', 'jsa-fork');
    const original = h('a', '', { href: ORIGINAL_URL, target: '_blank', rel: 'noopener', textContent: 'JSSpeccy 3' });
    fork.append('A heavily modified fork of ', original, ', written by Matt Westcott.');

    scroll.append(hero, links, fork);
    dialog.body.append(h('style', '', { textContent: HELP_CSS }), scroll);
    dialog.aside.append('Licensed under the GPL v3');
    return dialog;
}
