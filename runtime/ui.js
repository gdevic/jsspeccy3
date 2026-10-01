import EventEmitter from 'events';

import { CharPicker } from './char-picker.js';
import { DialogFrame } from './dialog.js';
import playIcon from './icons/play.svg';

/* The menu bar above the display and the toolbar below it: light, in the
 * dialogs' style (dialog.js), with the four stripes of the Spectrum's case
 * at the right end of each. The classes all start "jsb-"; .jsb-compact on
 * a bar makes everything in it smaller, for a narrow display. */
const ACCENT = '#33aa66';
const STRIPES = 'linear-gradient(115deg, transparent 0 22%, #e0352b 22% 40%, #f2b705 40% 58%, #2fa84f 58% 76%, #12a4c9 76% 94%, transparent 94%)';

const BAR_CSS = `
.jsb-menubar, .jsb-toolbar { position: relative; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 2px;
    padding: 3px 6px; font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #1f2328; user-select: none; }
.jsb-menubar { top: 0; background: linear-gradient(#fbfcfd, #f0f2f5); border-bottom: 1px solid #d9dde2; }
.jsb-toolbar { bottom: 0; background: linear-gradient(#f0f2f5, #e7eaee); border-top: 1px solid #d9dde2; }
.jsb-menubar::after { content: ''; position: absolute; top: 0; bottom: 0; right: -4px; width: 64px;
    background: ${STRIPES}; opacity: 0.9; pointer-events: none; }
.jsb-menubar.jsb-compact::after { display: none; }
.jsb-menubar *, .jsb-toolbar * { box-sizing: border-box; }
.jsb-menu { position: relative; }
.jsb-title { font: inherit; padding: 4px 10px; border: none; border-radius: 6px; background: transparent; color: inherit;
    cursor: pointer; white-space: nowrap; transition: background 0.1s; }
.jsb-title:hover { background: rgba(0, 0, 0, 0.07); }
.jsb-title:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: -1px; }
.jsb-menu.open .jsb-title { background: #1f2328; color: #fff; }
.jsb-compact .jsb-title { font-size: 11px; padding: 2px 6px; border-radius: 5px; }
.jsb-list { position: absolute; left: 0; top: calc(100% + 3px); z-index: 10; display: none; min-width: 180px; margin: 0;
    padding: 5px; list-style: none; background: #fff; border-radius: 9px; font-size: 13px;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12), 0 10px 28px rgba(0, 0, 0, 0.22); }
.jsb-menu.open .jsb-list { display: block; }
.jsb-item { position: relative; display: block; width: 100%; padding: 6px 12px 6px 27px; border: none; border-radius: 6px;
    background: transparent; font: inherit; color: inherit; text-align: left; white-space: nowrap; cursor: pointer; }
.jsb-item:hover, .jsb-item:focus-visible { background: #e6f6ea; color: #14532d; outline: none; }
.jsb-mark { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 15px; text-align: center;
    font-weight: bold; color: ${ACCENT}; }
.jsb-slider { display: flex; align-items: center; gap: 8px; padding: 7px 12px 6px; }
.jsb-slider input { flex: 1; min-width: 0; margin: 0; accent-color: ${ACCENT}; }
.jsb-slider span { width: 40px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; color: #5f6670; }
.jsb-right { display: flex; flex-direction: row-reverse; align-items: center; gap: 2px; margin-left: auto; }
.jsb-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; height: 28px; min-width: 30px;
    padding: 0; border: none; border-radius: 7px; background: transparent; color: inherit; cursor: pointer;
    transition: background 0.1s; }
.jsb-btn:hover { background: rgba(0, 0, 0, 0.08); }
.jsb-btn:active { background: rgba(0, 0, 0, 0.14); }
.jsb-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: -1px; }
.jsb-btn:disabled { opacity: 0.35; cursor: default; background: transparent; }
.jsb-btn svg { display: block; height: 20px; width: auto; }
.jsb-btn.text { padding: 0 9px; background: #fff; border: 1px solid #c3c8cf; font-family: Consolas, Monaco, monospace;
    font-size: 12px; font-variant-numeric: tabular-nums; letter-spacing: 0.3px; }
.jsb-btn.text:hover { background: #f6f7f9; border-color: #aeb4bc; }
.jsb-compact .jsb-btn { height: 22px; min-width: 24px; border-radius: 5px; }
.jsb-compact .jsb-btn svg { height: 16px; }
.jsb-compact .jsb-btn.text { padding: 0 5px; font-size: 10px; }
`;

export class MenuBar {
    // `teardown` is the signal that takes the menus' document listeners away
    constructor(container, teardown) {
        this.teardown = teardown;
        const style = document.createElement('style');
        style.textContent = BAR_CSS;
        container.appendChild(style);
        this.elem = document.createElement('div');
        this.elem.className = 'jsb-menubar';
        container.appendChild(this.elem);
        this.currentMouseenterEvent = null;
        this.currentMouseoutEvent = null;
        this.menus = [];
        this.compact = false;
    }

    addMenu(title) {
        const menu = new Menu(this.elem, title, this.teardown);
        this.menus.push(menu);
        return menu;
    }

    /* Smaller menu titles, so that they fit one row on a narrow display. */
    setCompact(compact) {
        this.compact = compact;
        this.elem.classList.toggle('jsb-compact', compact);
    }

    enterFullscreen() {
        this.elem.style.position = 'absolute';
    }
    exitFullscreen() {
        this.elem.style.position = '';
    }
    show() {
        this.elem.style.visibility = 'visible';
    }
    hide() {
        this.elem.style.visibility = 'hidden';
    }
    onmouseenter(e) {
        if (this.currentMouseenterEvent) {
            this.elem.removeEventListener('mouseenter', this.currentMouseenterEvent);
        }
        if (e) {
            this.elem.addEventListener('mouseenter', e);
        }
        this.currentMouseenterEvent = e;
    }
    onmouseout(e) {
        if (this.currentMouseoutEvent) {
            this.elem.removeEventListener('mouseleave', this.currentMouseoutEvent);
        }
        if (e) {
            this.elem.addEventListener('mouseleave', e);
        }
        this.currentMouseoutEvent = e;
    }
}

export class Menu {
    constructor(container, title, teardown) {
        this.teardown = teardown;
        this.elem = document.createElement('div');
        this.elem.className = 'jsb-menu';
        container.appendChild(this.elem);

        const button = document.createElement('button');
        button.className = 'jsb-title';
        button.innerText = title;
        this.elem.appendChild(button);
        this.button = button;

        this.list = document.createElement('ul');
        this.list.className = 'jsb-list';
        this.elem.appendChild(this.list);

        button.addEventListener('click', () => {
            if (this.isOpen()) {
                this.close();
            } else {
                this.open();
            }
        })
        document.addEventListener('click', (e) => {
            if (e.target != button && this.isOpen()) this.close();
        }, { signal: teardown })
    }

    isOpen() {
        return this.elem.classList.contains('open');
    }

    open() {
        this.elem.classList.add('open');
    }

    close() {
        this.elem.classList.remove('open');
    }

    /* An item: its title, with a mark in the gutter before it when it is
     * the chosen one of its kind (a bullet) or switched on (a tick). */
    addItem(title, onClick) {
        const li = document.createElement('li');
        this.list.appendChild(li);
        const button = document.createElement('button');
        button.className = 'jsb-item';
        const mark = document.createElement('span');
        mark.className = 'jsb-mark';
        button.append(mark, title);
        if (onClick) {
            button.addEventListener('click', onClick);
        }
        li.appendChild(button);
        const setMark = (text) => { mark.textContent = text; };
        return {
            setBullet: () => setMark('•'),
            unsetBullet: () => setMark(''),
            setCheckbox: () => setMark('✓'),
            unsetCheckbox: () => setMark(''),
        }
    }

    /* A slider row. Dragging it reports each new value through onInput, in
     * steps of opts.step, and the thumb catches on any of opts.marks it
     * comes within opts.snap of; onChange follows when it is let go. While
     * the pointer holds it, the list stays put on screen, even when what it
     * changes moves the page under it. */
    addSlider(opts) {
        const li = document.createElement('li');
        li.className = 'jsb-slider';
        const input = document.createElement('input');
        Object.assign(input, { type: 'range', min: opts.min, max: opts.max, step: 'any' });
        // the marks, drawn as ticks under the track
        const ticks = document.createElement('datalist');
        ticks.id = 'jsspeccy-slider-marks-' + (Menu.sliderCount = (Menu.sliderCount || 0) + 1);
        for (const mark of opts.marks) {
            const option = document.createElement('option');
            option.value = mark;
            ticks.appendChild(option);
        }
        input.setAttribute('list', ticks.id);
        const label = document.createElement('span');
        li.append(input, ticks, label);
        this.list.appendChild(li);

        const perUnit = Math.round(1 / opts.step);
        const snapped = (raw) => {
            const mark = opts.marks.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
            if (Math.abs(mark - raw) <= opts.snap) return mark;
            return Math.round(raw * perUnit) / perUnit;
        };
        let value = null;
        const show = (v) => {
            value = v;
            input.value = v;
            label.textContent = opts.format(v);
        };

        const unpin = () => {
            Object.assign(this.list.style, { position: 'absolute', left: '', top: '' });
            window.removeEventListener('pointerup', unpin);
            window.removeEventListener('pointercancel', unpin);
        };
        input.addEventListener('pointerdown', () => {
            const rect = this.list.getBoundingClientRect();
            Object.assign(this.list.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px' });
            window.addEventListener('pointerup', unpin, { signal: this.teardown });
            window.addEventListener('pointercancel', unpin, { signal: this.teardown });
        });
        input.addEventListener('input', () => {
            const v = snapped(+input.value);
            input.value = v;
            if (v === value) return;
            show(v);
            opts.onInput(v);
        });
        input.addEventListener('change', () => opts.onChange(value));
        // a range is clicked when let go, which would close the list
        li.addEventListener('click', (e) => e.stopPropagation());

        return {
            setValue: show,
            setEnabled: (enabled) => {
                input.disabled = !enabled;
                li.style.opacity = enabled ? '' : '0.5';
            },
        };
    }
}

export class Toolbar {
    constructor(container) {
        this.elem = document.createElement('div');
        this.elem.className = 'jsb-toolbar';
        container.appendChild(this.elem);
        // Buttons aligned right stand from the right end, the first added outermost.
        this.right = document.createElement('div');
        this.right.className = 'jsb-right';
        this.elem.appendChild(this.right);
        this.currentMouseenterEvent = null;
        this.currentMouseoutEvent = null;
        this.compact = false;
    }
    place(elem, opts) {
        if (opts.align == 'right') this.right.appendChild(elem); else this.elem.insertBefore(elem, this.right);
    }
    addButton(icon, opts, onClick) {
        opts = opts || {};
        const button = new ToolbarButton(icon, opts, onClick);
        this.place(button.elem, opts);
        return button;
    }
    /* Smaller buttons, so that they fit one row on a narrow display. */
    setCompact(compact) {
        this.compact = compact;
        this.elem.classList.toggle('jsb-compact', compact);
    }
    addTextButton(text, opts, onClick) {
        /* A toolbar button that shows text (used for the cassette counter) rather
         * than an SVG icon. Returns a handle with setText/setLabel/enable/disable. */
        opts = opts || {};
        const button = document.createElement('button');
        button.className = 'jsb-btn text';
        button.innerText = text;
        if (opts.label) button.title = opts.label;
        if (onClick) button.addEventListener('click', onClick);
        this.place(button, opts);
        return {
            elem: button,
            setText: (t) => { button.innerText = t; },
            setLabel: (l) => { button.title = l; },
            disable: () => { button.disabled = true; },
            enable: () => { button.disabled = false; },
        };
    }
    enterFullscreen() {
        this.elem.style.position = 'absolute';
    }
    exitFullscreen() {
        this.elem.style.position = '';
    }
    show() {
        this.elem.style.visibility = 'visible';
    }
    hide() {
        this.elem.style.visibility = 'hidden';
    }
    onmouseenter(e) {
        if (this.currentMouseenterEvent) {
            this.elem.removeEventListener('mouseenter', this.currentMouseenterEvent);
        }
        if (e) {
            this.elem.addEventListener('mouseenter', e);
        }
        this.currentMouseenterEvent = e;
    }
    onmouseout(e) {
        if (this.currentMouseoutEvent) {
            this.elem.removeEventListener('mouseleave', this.currentMouseoutEvent);
        }
        if (e) {
            this.elem.addEventListener('mouseleave', e);
        }
        this.currentMouseoutEvent = e;
    }
}

class ToolbarButton {
    constructor(icon, opts, onClick) {
        this.elem = document.createElement('button');
        this.elem.className = 'jsb-btn';
        this.setIcon(icon);
        if (opts.label) this.setLabel(opts.label);
        this.elem.addEventListener('click', onClick);
    }
    setIcon(icon) {
        this.elem.innerHTML = icon;
    }
    setLabel(label) {
        this.elem.title = label;
    }
    disable() {
        this.elem.disabled = true;
    }
    enable() {
        this.elem.disabled = false;
    }
}


export class UIController extends EventEmitter {
    constructor(container, emulator, opts) {
        super();
        this.canvas = emulator.canvas;
        this.uiEnabled = ('uiEnabled' in opts) ? opts.uiEnabled : true;

        /* What the emulator hangs on the page outside its own elements - its
         * document and window listeners, given `teardown` as their signal,
         * and the ResizeObservers passed to keepObserver - goes when it is
         * unloaded. */
        this.teardownController = new AbortController();
        this.teardown = this.teardownController.signal;
        this.observers = [];

        this.appContainer = document.createElement('div');
        container.appendChild(this.appContainer);
        this.appContainer.style.position = 'relative';
        this.appContainer.style.outline = 'none';
        this.leftSide = new Set();  // see makeRoomOnLeft

        if (this.uiEnabled) {
            this.menuBar = new MenuBar(this.appContainer, this.teardown);
        }
        this.appContainer.appendChild(this.canvas);
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.display = 'block';

        if (this.uiEnabled) {
            this.toolbar = new Toolbar(this.appContainer);
            // the File menu's dialogs open in it (see dialog.js)
            this.dialogFrame = new DialogFrame(this.appContainer, this.teardown);
        }

        /* Until the machine first starts there is no picture, so the display
         * shows a switched-off TV (see showScreenOff); it comes back when the
         * machine is switched off, such as by restoring a session saved with
         * it off. Starting it plays the picture tube's power-on (see
         * powerOn). */
        this.screenOff = null;
        this.showScreenOff();

        this.startButton = document.createElement('button');
        this.startButton.innerHTML = playIcon;
        this.appContainer.appendChild(this.startButton);
        this.startButton.style.position = 'absolute';
        this.startButton.style.zIndex = '2';
        this.startButton.style.top = '50%';
        this.startButton.style.left = '50%';
        this.startButton.style.width = '96px';
        this.startButton.style.height = '64px';
        this.startButton.style.marginLeft = '-48px';
        this.startButton.style.marginTop = '-32px';
        this.startButton.style.backgroundColor = 'rgba(160, 160, 160, 0.7)';
        this.startButton.style.border = 'none';
        this.startButton.style.borderRadius = '4px';
        this.startButton.firstChild.style.height = '56px';
        this.startButton.firstChild.style.verticalAlign = 'middle';
        this.startButton.addEventListener('mouseenter', () => {
            this.startButton.style.backgroundColor = 'rgba(128, 128, 128, 0.7)';
        });
        this.startButton.addEventListener('mouseleave', () => {
            this.startButton.style.backgroundColor = 'rgba(160, 160, 160, 0.7)';
        });
        this.startButton.addEventListener('click', (e) => {
            emulator.start();
        });
        emulator.on('start', () => {
            this.startButton.style.display = 'none';
            this.powerOn();
        });
        emulator.on('pause', () => {
            this.startButton.style.display = 'block';
        });
        emulator.on('powerOff', () => {
            this.showScreenOff();
        });
        emulator.on('notice', (text) => {
            if (this.uiEnabled) this.showNotice(text);
        });
        // Warp's label, with the speed it reaches once measured.
        emulator.on('warp', (on) => {
            if (!this.uiEnabled) return;
            if (on) this.showWarpBadge('Warp');
            else this.hideWarpBadge();
        });
        emulator.on('warpRate', (rate) => {
            if (this.uiEnabled && emulator.warp) this.showWarpBadge(`Warp ×${Math.round(rate)}`);
        });
        emulator.on('powerOnPaused', () => {
            // on, with its picture, but not running: no power-on to watch
            if (this.screenOff) this.screenOff.remove();
            this.screenOff = null;
        });

        // Clicking a character on the screen recognises it, once switched on from the Options menu (see char-picker.js).
        this.charPicker = new CharPicker(this, emulator);

        /* The menu bar, toolbar and on-screen keyboard are built and toggled after
         * this point, each time changing where the canvas sits inside the
         * container, so re-centre the overlays whenever the container resizes,
         * or the menu bar does: its filling in moves the canvas down without
         * always resizing the container. */
        if (window.ResizeObserver) {
            const observer = this.keepObserver(new ResizeObserver(() => {this.centerStartButton();}));
            observer.observe(this.appContainer);
            if (this.menuBar) observer.observe(this.menuBar.elem);
        }

        /* variables for tracking zoom / fullscreen state */
        this.zoom = null;
        this.isFullscreen = false;
        this.uiIsHidden = false;
        this.allowUIHiding = true;
        this.hideUITimeout = null;
        this.ignoreNextMouseMove = false;

        /* Where the emulator last left the page's horizontal scroll, and
         * whether the visitor has moved it since (see keepCentred). */
        this.pageScrollX = window.scrollX;
        this.pageScrolled = false;
        this.onPageScroll = () => {
            if (window.scrollX !== this.pageScrollX) this.pageScrolled = true;
        };
        this.onWindowResize = () => { this.keepCentred(); };
        window.addEventListener('scroll', this.onPageScroll);
        window.addEventListener('resize', this.onWindowResize);

        /* state changes when entering / exiting fullscreen */
        const fullscreenMouseMove = () => {
            if (this.ignoreNextMouseMove) {
                this.ignoreNextMouseMove = false;
                return;
            }
            this.showUI();
            if (this.hideUITimeout) clearTimeout(this.hideUITimeout);
            this.hideUITimeout = setTimeout(() => {this.hideUI();}, 3000);
        }
        this.appContainer.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                this.isFullscreen = true;
                this.canvas.style.width = '100%';
                this.canvas.style.height = '100%';
                this.setCompactUI(false);

                if (this.uiEnabled) {
                    document.addEventListener('mousemove', fullscreenMouseMove, { signal: this.teardown });
                    /* a bogus mousemove event is emitted on entering fullscreen, so ignore it */
                    this.ignoreNextMouseMove = true;

                    this.menuBar.enterFullscreen();
                    this.menuBar.onmouseenter(() => {this.allowUIHiding = false;});
                    this.menuBar.onmouseout(() => {this.allowUIHiding = true;});

                    this.toolbar.enterFullscreen();
                    this.toolbar.onmouseenter(() => {this.allowUIHiding = false;});
                    this.toolbar.onmouseout(() => {this.allowUIHiding = true;});

                    this.hideUI();
                }
                this.centerStartButton();
                this.emit('setZoom', 'fullscreen');
                emulator.focus();
            } else {
                this.isFullscreen = false;
                if (this.uiEnabled) {
                    if (this.hideUITimeout) clearTimeout(this.hideUITimeout);
                    this.showUI();

                    this.menuBar.exitFullscreen();
                    this.menuBar.onmouseenter(null);
                    this.menuBar.onmouseout(null);

                    this.toolbar.exitFullscreen();
                    this.toolbar.onmouseenter(null);
                    this.toolbar.onmouseout(null);

                    document.removeEventListener('mousemove', fullscreenMouseMove);
                }
                this.setZoom(this.zoom);
            }
        })

        this.setZoom(opts.zoom || 1);

        if (!opts.sandbox) {
            /* drag-and-drop for loading files */
            this.appContainer.addEventListener('drop', (ev) => {
                ev.preventDefault();
                let loadList = Promise.resolve();
                // A saved session starts the machine itself, once restored.
                let sawSession = false;
                const open = (file) => {
                    loadList = loadList.then(() => emulator.openFile(file)).then((res) => {
                        if (res && res.mediaType === 'session') sawSession = true;
                    }, (err) => { alert(err); });
                };
                if (ev.dataTransfer.items) {
                    // Use DataTransferItemList interface to access the file(s)
                    for (const item of ev.dataTransfer.items) {
                        // If dropped items aren't files, reject them
                        if (item.kind === 'file') open(item.getAsFile());
                    }
                } else {
                    // Use DataTransfer interface to access the file(s)
                    for (const file of ev.dataTransfer.files) open(file);
                }
                loadList.then(() => {
                    if (emulator.isInitiallyPaused && !sawSession) emulator.start();
                })
            });
            this.appContainer.addEventListener('dragover', (ev) => {
                ev.preventDefault();
            });
        }
    }

    setZoom(factor) {
        this.zoom = factor;
        if (this.isFullscreen) {
            document.exitFullscreen();
            return;  // setZoom will be retriggered once fullscreen has exited
        }
        const displayWidth = 320 * this.zoom;
        const displayHeight = 240 * this.zoom;
        this.canvas.style.width = '' + displayWidth + 'px';
        this.canvas.style.height = '' + displayHeight + 'px';
        this.appContainer.style.width = '' + displayWidth + 'px';
        this.setCompactUI(displayWidth < 640);
        this.centerStartButton();
        this.emit('setZoom', factor);
        this.keepCentred();
    }

    /* Keeps the start button centred on the display, and the switched-off
     * TV covering it. */
    /* On a narrow display (below 200% zoom) the menu bar and toolbar use
     * smaller buttons, so each stays on a single row. */
    setCompactUI(compact) {
        if (!this.uiEnabled) return;
        this.menuBar.setCompact(compact);
        this.toolbar.setCompact(compact);
    }

    centerStartButton() {
        const canvasHeight = this.canvas.offsetHeight;
        if (canvasHeight) {
            this.startButton.style.top = (this.canvas.offsetTop + (canvasHeight / 2)) + 'px';
        } else {
            this.startButton.style.top = '50%';   // not laid out yet; best guess
        }
        if (this.screenOff) {
            Object.assign(this.screenOff.style, {
                left: this.canvas.offsetLeft + 'px', top: this.canvas.offsetTop + 'px',
                width: this.canvas.offsetWidth + 'px', height: canvasHeight + 'px',
            });
        }
        if (this.warpBadge) this.placeWarpBadge();
    }

    /* The tape recorder and the Microdrives stand out past the container's
     * left edge (anchored there with `right: 100%`), where a page can't be
     * scrolled to, so the container gets margins as wide as the widest of
     * them. They go on both sides, so a page that centres the container
     * still centres it where it did; only once the window is too narrow to
     * show them does it move over, and the page then scrolls to them as it
     * does to the printer on the right. Called with the element whenever its
     * size or visibility changes; a hidden one takes no room. A device
     * dragged out beyond its element (marked data-reach) gets room on the
     * left as far as it reaches, and none on the right for that. */
    makeRoomOnLeft(element) {
        this.leftSide.add(element);
        const left = this.appContainer.getBoundingClientRect().left;
        let reach = 0, dragged = 0;
        for (const e of this.leftSide) {
            if (!e.getClientRects().length) continue;
            reach = Math.max(reach, left - e.getBoundingClientRect().left);
            for (const part of e.querySelectorAll('[data-reach]')) dragged = Math.max(dragged, left - part.getBoundingClientRect().left);
        }
        this.appContainer.style.marginLeft = Math.ceil(Math.max(reach, dragged)) + 'px';
        this.appContainer.style.marginRight = Math.ceil(reach) + 'px';
        this.keepCentred();
    }

    /* While the page scrolls sideways, it is kept scrolled so the display
     * sits in the middle of the window, and the recorder and the Microdrives
     * on the left and the printer on the right go out of view equally: after
     * a zoom (the emulator's or the browser's), a resize of the window, or
     * the recorder or the Microdrives coming or going. Once the visitor
     * moves the page's scroll bar it stays where they put it, until
     * everything fits across the window again. */
    keepCentred() {
        if (this.isFullscreen) return;
        const page = document.scrollingElement || document.documentElement;
        if (page.scrollWidth <= page.clientWidth) {
            this.pageScrolled = false;
        } else if (!this.pageScrolled) {
            const box = this.appContainer.getBoundingClientRect();
            const middle = window.scrollX + box.left + (box.width / 2);
            window.scrollTo({ left: middle - (page.clientWidth / 2), behavior: 'instant' });
        }
        // A change of layout can move the scroll too; that is not the visitor.
        this.pageScrollX = window.scrollX;
    }

    /* The switched-off TV: dark glass, darker towards the corners, with a
     * faint reflection and scanlines, over the display. */
    showScreenOff() {
        if (this.screenOff) return;
        this.screenOff = document.createElement('div');
        Object.assign(this.screenOff.style, {
            position: 'absolute', zIndex: '1', pointerEvents: 'none', overflow: 'hidden',
            background: [
                'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 28%, rgba(255,255,255,0) 42%)',
                'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 3px)',
                'radial-gradient(ellipse at 50% 45%, #2e3531 0%, #1d2320 55%, #0b0d0c 100%)',
            ].join(', '),
            boxShadow: 'inset 0 0 50px rgba(0,0,0,0.85)',
        });
        // Stacked above the display, which the power-on's brightness filter
        // would otherwise draw on top of it, and below the menus' drop-down
        // lists and the start button.
        this.appContainer.appendChild(this.screenOff);
        if (this.startButton) this.centerStartButton();
    }

    /* The picture tube warming up, as the machine starts: a bright
     * line flashes across the middle of the black screen, then opens out top
     * and bottom into the picture, which settles from over-bright. Skipped for
     * anyone who asks for reduced motion. */
    powerOn() {
        const screen = this.screenOff;
        if (!screen) return;
        this.screenOff = null;
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduceMotion || !screen.animate) {
            screen.remove();
            return;
        }
        Object.assign(screen.style, { background: 'none', boxShadow: 'none' });
        const DURATION = 420;
        const LINE_END = 0.35;  // share of DURATION the line takes to reach full width

        const shutter = (edge) => {
            const half = document.createElement('div');
            Object.assign(half.style, { position: 'absolute', left: '0', right: '0', height: '50%', background: '#000' });
            half.style[edge] = '0';
            screen.appendChild(half);
            half.animate(
                [{ height: '50%' }, { height: '50%', offset: LINE_END }, { height: '0%' }],
                { duration: DURATION, easing: 'ease-in', fill: 'forwards' }
            );
        };
        shutter('top');
        shutter('bottom');

        const line = document.createElement('div');
        Object.assign(line.style, {
            position: 'absolute', left: '0', right: '0', top: '50%', height: '2px', marginTop: '-1px',
            background: '#fff',
            boxShadow: '0 0 6px 2px rgba(210,235,255,0.9), 0 0 18px 6px rgba(160,200,255,0.5)',
        });
        screen.appendChild(line);
        line.animate(
            [
                { transform: 'scaleX(0)', opacity: 1 },
                { transform: 'scaleX(1)', opacity: 1, offset: LINE_END },
                { transform: 'scaleX(1) scaleY(6)', opacity: 0 },
            ],
            { duration: DURATION, easing: 'ease-out', fill: 'forwards' }
        ).onfinish = () => screen.remove();

        this.canvas.animate(
            [
                { filter: 'brightness(2.2) contrast(0.7)' },
                { filter: 'brightness(2.2) contrast(0.7)', offset: 0.25 },
                { filter: 'none' },
            ],
            { duration: DURATION + 300, easing: 'ease-out' }
        );
    }

    // Resolves once in fullscreen; rejects where the browser refuses it.
    enterFullscreen() {
        return this.appContainer.requestFullscreen();
    }
    exitFullscreen() {
        if (this.isFullscreen) {
            document.exitFullscreen();
        }
    }
    toggleFullscreen() {
        if (this.isFullscreen) {
            this.exitFullscreen();
        } else {
            this.enterFullscreen();
        }
    }

    hideUI() {
        if (this.uiEnabled && this.allowUIHiding && !this.uiIsHidden) {
            this.uiIsHidden = true;
            this.appContainer.style.cursor = 'none';
            this.canvas.style.cursor = '';  // the character picker's pointing hand too
            this.menuBar.hide();
            this.toolbar.hide();
        }
    }
    showUI() {
        if (this.uiEnabled && this.uiIsHidden) {
            this.uiIsHidden = false;
            this.appContainer.style.cursor = 'default';
            this.menuBar.show();
            this.toolbar.show();
        }
    }
    // A short message over the top of the picture that fades by itself.
    showNotice(text) {
        if (!this.noticeElement) {
            const notice = document.createElement('div');
            notice.style.cssText = 'position: absolute; left: 50%; transform: translateX(-50%); z-index: 3; '
                + 'padding: 4px 12px; border-radius: 4px; background: rgba(0, 0, 0, 0.7); color: #fff; '
                + 'font: 13px Arial, Helvetica, sans-serif; pointer-events: none; transition: opacity 0.4s;';
            this.appContainer.appendChild(notice);
            this.noticeElement = notice;
        }
        const notice = this.noticeElement;
        notice.textContent = text;
        notice.style.top = (this.canvas.offsetTop + 8) + 'px';
        notice.style.opacity = '1';
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => { notice.style.opacity = '0'; }, 1200);
    }
    /* A label over the top right of the picture, in the notice's style, that
     * stays for as long as Warp is on: its own element, so a notice comes
     * and goes beside it. */
    showWarpBadge(text) {
        if (!this.warpBadge) {
            const badge = document.createElement('div');
            badge.style.cssText = 'position: absolute; transform: translateX(-100%); z-index: 3; '
                + 'padding: 4px 12px; border-radius: 4px; background: rgba(0, 0, 0, 0.7); color: #fff; '
                + 'font: bold 13px Arial, Helvetica, sans-serif; font-variant-numeric: tabular-nums; '
                + 'white-space: nowrap; pointer-events: none;';
            this.appContainer.appendChild(badge);
            this.warpBadge = badge;
        }
        this.warpBadge.textContent = text;
        this.warpBadge.style.display = 'block';
        this.placeWarpBadge();
    }
    hideWarpBadge() {
        if (this.warpBadge) this.warpBadge.style.display = 'none';
    }
    placeWarpBadge() {
        this.warpBadge.style.top = (this.canvas.offsetTop + 8) + 'px';
        this.warpBadge.style.left = (this.canvas.offsetLeft + this.canvas.offsetWidth - 8) + 'px';
    }
    /* Opens the dialog window, empty, and returns it; see DialogFrame.show
     * for `opts`. Dialogs open through openDialog in dialog.js. */
    showDialog(opts) {
        this.dialogFrame.show(opts || {});
        return this.dialogFrame;
    }
    hideDialog() {
        if (this.dialogFrame) this.dialogFrame.hide();
    }
    /* Small popup listbox anchored above the toolbar, used by the cassette
     * counter to list a tape's segments. `items` is an array of {label, current}
     * and onSelect(index) fires when a row is clicked. Closes on select, Escape,
     * or an outside click. */
    showTapePopup(title, items, onSelect) {
        this.hideTapePopup();
        const popup = document.createElement('div');
        this._tapePopup = popup;
        popup.style.position = 'absolute';
        popup.style.left = '4px';
        popup.style.right = '4px';
        // Anchor just above the toolbar so the popup never covers the on-screen
        // keyboard, which sits below the toolbar when shown.
        const aboveToolbar = (this.toolbar && this.toolbar.elem)
            ? (this.appContainer.clientHeight - this.toolbar.elem.offsetTop)
            : 34;
        popup.style.bottom = aboveToolbar + 'px';
        popup.style.maxHeight = '50%';
        popup.style.overflowY = 'auto';
        popup.style.backgroundColor = '#f4f4f4';
        popup.style.border = '1px solid #888';
        popup.style.zIndex = '150';
        popup.style.fontFamily = 'Arial, Helvetica, sans-serif';
        popup.style.fontSize = '12px';

        const heading = document.createElement('div');
        heading.innerText = title;
        heading.style.fontWeight = 'bold';
        heading.style.padding = '4px 8px';
        heading.style.borderBottom = '1px solid #ccc';
        heading.style.backgroundColor = '#e4e4e4';
        popup.appendChild(heading);

        items.forEach((item, index) => {
            const row = document.createElement('button');
            row.innerText = (item.current ? '▸ ' : '   ') + item.label;
            row.style.display = 'block';
            row.style.width = '100%';
            row.style.textAlign = 'left';
            row.style.border = 'none';
            row.style.borderBottom = '1px solid #e0e0e0';
            row.style.padding = '5px 8px';
            row.style.fontFamily = 'monospace';
            row.style.fontSize = '12px';
            row.style.backgroundColor = item.current ? '#d8e8ff' : 'transparent';
            row.style.cursor = 'pointer';
            row.addEventListener('mouseenter', () => { row.style.backgroundColor = '#cce0ff'; });
            row.addEventListener('mouseleave', () => { row.style.backgroundColor = item.current ? '#d8e8ff' : 'transparent'; });
            row.addEventListener('click', () => {
                this.hideTapePopup();
                onSelect(index);
            });
            popup.appendChild(row);
        });

        this.appContainer.appendChild(popup);

        /* dismiss on Escape or an outside click (deferred so this click doesn't
         * immediately close it) */
        this._tapePopupKeyHandler = (e) => { if (e.key === 'Escape') this.hideTapePopup(); };
        this._tapePopupClickHandler = (e) => { if (!popup.contains(e.target)) this.hideTapePopup(); };
        document.addEventListener('keydown', this._tapePopupKeyHandler, { signal: this.teardown });
        setTimeout(() => document.addEventListener('click', this._tapePopupClickHandler, { signal: this.teardown }), 0);
    }
    hideTapePopup() {
        if (this._tapePopup) {
            this._tapePopup.remove();
            this._tapePopup = null;
        }
        if (this._tapePopupKeyHandler) {
            document.removeEventListener('keydown', this._tapePopupKeyHandler);
            this._tapePopupKeyHandler = null;
        }
        if (this._tapePopupClickHandler) {
            document.removeEventListener('click', this._tapePopupClickHandler);
            this._tapePopupClickHandler = null;
        }
    }
    isTapePopupOpen() {
        return !!this._tapePopup;
    }
    // Keeps a ResizeObserver to be disconnected on unload; returns it.
    keepObserver(observer) {
        this.observers.push(observer);
        return observer;
    }

    unload() {
        this.charPicker.close();
        this.teardownController.abort();
        this.observers.forEach(observer => observer.disconnect());
        window.removeEventListener('scroll', this.onPageScroll);
        window.removeEventListener('resize', this.onWindowResize);
        this.appContainer.remove();
    }
}
