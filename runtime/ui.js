import EventEmitter from 'events';

import playIcon from './icons/play.svg';
import closeIcon from './icons/close.svg';


export class MenuBar {
    constructor(container) {
        this.elem = document.createElement('div');
        this.elem.style.display = 'flow-root';
        this.elem.style.backgroundColor = '#eee';
        this.elem.style.fontFamily = 'Arial, Helvetica, sans-serif';
        this.elem.style.top = '0';
        this.elem.style.width = '100%';
        container.appendChild(this.elem);
        this.currentMouseenterEvent = null;
        this.currentMouseoutEvent = null;
        this.menus = [];
        this.compact = false;
    }

    addMenu(title) {
        const menu = new Menu(this.elem, title);
        menu.setCompact(this.compact);
        this.menus.push(menu);
        return menu;
    }

    /* Smaller menu titles, so that they fit one row on a narrow display. */
    setCompact(compact) {
        this.compact = compact;
        for (const menu of this.menus) menu.setCompact(compact);
    }

    enterFullscreen() {
        this.elem.style.position = 'absolute';
    }
    exitFullscreen() {
        this.elem.style.position = 'static';
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
    constructor(container, title) {
        const elem = document.createElement('div');
        elem.style.float = 'left';
        elem.style.position = 'relative';
        container.appendChild(elem);

        const button = document.createElement('button');
        button.style.margin = '2px';
        button.innerText = title;
        elem.appendChild(button);
        this.button = button;

        this.list = document.createElement('ul');
        this.list.style.position = 'absolute';
        this.list.style.width = '150px';
        this.list.style.backgroundColor = '#eee';
        this.list.style.listStyleType = 'none';
        this.list.style.margin = '0';
        this.list.style.padding = '0';
        this.list.style.border = '1px solid #888';
        this.list.style.display = 'none';
        elem.appendChild(this.list);

        button.addEventListener('click', () => {
            if (this.isOpen()) {
                this.close();
            } else {
                this.open();
            }
        })
        document.addEventListener('click', (e) => {
            if (e.target != button && this.isOpen()) this.close();
        })
    }

    isOpen() {
        return this.list.style.display == 'block';
    }

    setCompact(compact) {
        Object.assign(this.button.style, compact
            ? { margin: '1px', padding: '1px 4px', fontSize: '11px' }
            : { margin: '2px', padding: '', fontSize: '' });
    }

    open() {
        this.list.style.display = 'block';
    }

    close() {
        this.list.style.display = 'none';
    }

    addItem(title, onClick) {
        const li = document.createElement('li');
        this.list.appendChild(li);
        const button = document.createElement('button');
        button.innerText = title;
        button.style.width = '100%';
        button.style.textAlign = 'left';
        button.style.borderWidth = '0';
        button.style.paddingTop = '4px';
        button.style.paddingBottom = '4px';

        // eww.
        button.addEventListener('mouseenter', () => {
            button.style.backgroundColor = '#ddd';
        });
        button.addEventListener('mouseout', () => {
            button.style.backgroundColor = 'inherit';
        });
        if (onClick) {
            button.addEventListener('click', onClick);
        }
        li.appendChild(button);
        return {
            setBullet: () => {
                button.innerText = String.fromCharCode(0x2022) + ' ' + title;
            },
            unsetBullet: () => {
                button.innerText = title;
            },
            setCheckbox: () => {
                button.innerText = String.fromCharCode(0x2713) + ' ' + title;
            },
            unsetCheckbox: () => {
                button.innerText = title;
            },
        }
    }
}

export class Toolbar {
    constructor(container) {
        this.elem = document.createElement('div');
        this.elem.style.backgroundColor = '#ccc';
        this.elem.style.bottom = '0';
        this.elem.style.width = '100%';
        container.appendChild(this.elem);
        this.currentMouseenterEvent = null;
        this.currentMouseoutEvent = null;
        this.buttons = [];
        this.textButtons = [];
        this.compact = false;
    }
    addButton(icon, opts, onClick) {
        opts = opts || {};
        const button = new ToolbarButton(icon, opts, onClick);
        if (opts.align == 'right') button.elem.style.float = 'right';
        button.setCompact(this.compact);
        this.buttons.push(button);
        this.elem.appendChild(button.elem);
        return button;
    }
    /* Smaller buttons, so that they fit one row on a narrow display. */
    setCompact(compact) {
        this.compact = compact;
        for (const button of this.buttons) button.setCompact(compact);
        for (const button of this.textButtons) Toolbar.styleTextButton(button, compact);
    }
    static styleTextButton(button, compact) {
        Object.assign(button.style, compact
            ? { margin: '1px', padding: '0 3px', fontSize: '10px', height: '22px' }
            : { margin: '2px', padding: '', fontSize: '12px', height: '26px' });
    }
    addTextButton(text, opts, onClick) {
        /* A toolbar button that shows text (used for the cassette counter) rather
         * than an SVG icon. Returns a handle with setText/setLabel/enable/disable. */
        opts = opts || {};
        const button = document.createElement('button');
        button.style.fontFamily = 'monospace';
        button.style.verticalAlign = 'middle';
        Toolbar.styleTextButton(button, this.compact);
        this.textButtons.push(button);
        button.innerText = text;
        if (opts.label) button.title = opts.label;
        if (opts.align == 'right') button.style.float = 'right';
        if (onClick) button.addEventListener('click', onClick);
        this.elem.appendChild(button);
        return {
            elem: button,
            setText: (t) => { button.innerText = t; },
            setLabel: (l) => { button.title = l; },
            disable: () => { button.disabled = true; button.style.opacity = '0.5'; },
            enable: () => { button.disabled = false; button.style.opacity = '1'; },
        };
    }
    enterFullscreen() {
        this.elem.style.position = 'absolute';
    }
    exitFullscreen() {
        this.elem.style.position = 'static';
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
        this.compact = false;
        this.setCompact(false);
        this.setIcon(icon);
        if (opts.label) this.setLabel(opts.label);
        this.elem.addEventListener('click', onClick);
    }
    setIcon(icon) {
        this.elem.innerHTML = icon;
        this.elem.firstChild.style.height = this.compact ? '16px' : '20px';
        this.elem.firstChild.style.verticalAlign = 'middle';
    }
    setCompact(compact) {
        this.compact = compact;
        Object.assign(this.elem.style, compact ? { margin: '1px', padding: '1px 2px' } : { margin: '2px', padding: '' });
        if (this.elem.firstChild) this.elem.firstChild.style.height = compact ? '16px' : '20px';
    }
    setLabel(label) {
        this.elem.title = label;
    }
    disable() {
        this.elem.disabled = true;
        this.elem.firstChild.style.opacity = '0.5';
    }
    enable() {
        this.elem.disabled = false;
        this.elem.firstChild.style.opacity = '1';
    }
}


export class UIController extends EventEmitter {
    constructor(container, emulator, opts) {
        super();
        this.canvas = emulator.canvas;
        this.uiEnabled = ('uiEnabled' in opts) ? opts.uiEnabled : true;

        /* build UI elements */
        if (this.uiEnabled) {
            this.dialog = document.createElement('div');
            this.dialog.style.display = 'none';
            container.appendChild(this.dialog);
            const dialogCloseButton = document.createElement('button');
            dialogCloseButton.innerHTML = closeIcon;
            dialogCloseButton.style.float = 'right';
            dialogCloseButton.style.border = 'none';
            dialogCloseButton.firstChild.style.height = '20px';
            dialogCloseButton.firstChild.style.verticalAlign = 'middle';
            this.dialog.appendChild(dialogCloseButton);
            dialogCloseButton.addEventListener('click', () => {
                this.hideDialog();
            })
            this.dialogBody = document.createElement('div');
            this.dialogBody.style.clear = 'both';
            this.dialog.appendChild(this.dialogBody);
        }

        this.appContainer = document.createElement('div');
        container.appendChild(this.appContainer);
        this.appContainer.style.position = 'relative';
        this.appContainer.style.outline = 'none';

        if (this.uiEnabled) {
            this.menuBar = new MenuBar(this.appContainer);
        }
        this.appContainer.appendChild(this.canvas);
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.display = 'block';

        if (this.uiEnabled) {
            this.toolbar = new Toolbar(this.appContainer);
        }

        /* Until the machine first starts there is no picture, so the display
         * shows a switched-off TV: dark glass, darker towards the corners,
         * with a faint reflection and scanlines. Starting it plays the
         * picture tube's power-on (see powerOn). */
        this.screenOff = document.createElement('div');
        Object.assign(this.screenOff.style, {
            position: 'absolute', pointerEvents: 'none', overflow: 'hidden',
            background: [
                'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 28%, rgba(255,255,255,0) 42%)',
                'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 3px)',
                'radial-gradient(ellipse at 50% 45%, #2e3531 0%, #1d2320 55%, #0b0d0c 100%)',
            ].join(', '),
            boxShadow: 'inset 0 0 50px rgba(0,0,0,0.85)',
        });
        // first in the container, so the menus' drop-down lists and the start
        // button are drawn over it
        this.appContainer.insertBefore(this.screenOff, this.appContainer.firstChild);

        this.startButton = document.createElement('button');
        this.startButton.innerHTML = playIcon;
        this.appContainer.appendChild(this.startButton);
        this.startButton.style.position = 'absolute';
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

        /* The menu bar, toolbar and on-screen keyboard are built and toggled after
         * this point, each time changing where the canvas sits inside the
         * container, so re-centre the overlay whenever the container resizes. */
        if (window.ResizeObserver) {
            new ResizeObserver(() => {this.centerStartButton();}).observe(this.appContainer);
        }

        /* variables for tracking zoom / fullscreen state */
        this.zoom = null;
        this.isFullscreen = false;
        this.uiIsHidden = false;
        this.allowUIHiding = true;
        this.hideUITimeout = null;
        this.ignoreNextMouseMove = false;

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
                    document.addEventListener('mousemove', fullscreenMouseMove);
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
                if (ev.dataTransfer.items) {
                    // Use DataTransferItemList interface to access the file(s)
                    for (const item of ev.dataTransfer.items) {
                        // If dropped items aren't files, reject them
                        if (item.kind === 'file') {
                            const file = item.getAsFile();
                            loadList = loadList.then(() => {
                                emulator.openFile(file);
                            });
                        }
                    }
                } else {
                    // Use DataTransfer interface to access the file(s)
                    for (const file of ev.dataTransfer.files) {
                        loadList = loadList.then(() => {
                            emulator.openFile(file);
                        });
                    }
                }
                loadList.then(() => {
                    if (emulator.isInitiallyPaused) emulator.start();
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
        this.setCompactUI(displayWidth < 480);
        this.centerStartButton();
        this.emit('setZoom', factor);
    }

    /* Keeps the start button centred on the display, and the switched-off
     * TV covering it. */
    /* On a narrow display (100% zoom) the menu bar and toolbar use smaller
     * buttons, so each stays on a single row. */
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
    }

    /* The picture tube warming up, the first time the machine starts: a bright
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

    enterFullscreen() {
        this.appContainer.requestFullscreen();
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
    showDialog() {
        this.dialog.style.display = 'block';
        this.dialog.style.position = 'absolute';
        this.dialog.style.backgroundColor = '#eee';
        this.dialog.style.zIndex = '100';
        this.dialog.style.width = '75%';
        this.dialog.style.height = '80%';
        this.dialog.style.left = '12%';
        this.dialog.style.top = '10%';
        this.dialog.style.overflow = 'scroll';  // TODO: less hacky scrolling that doesn't hide the close button
        this.dialogBody.style.paddingLeft = '8px';
        this.dialogBody.style.paddingRight = '8px';
        this.dialogBody.style.paddingBottom = '8px';

        return this.dialogBody;
    }
    hideDialog() {
        this.dialog.style.display = 'none';
        this.dialogBody.innerHTML = '';
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
        document.addEventListener('keydown', this._tapePopupKeyHandler);
        setTimeout(() => document.addEventListener('click', this._tapePopupClickHandler), 0);
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
    unload() {
        if (this.uiEnabled) {
            this.dialog.remove();
        }
        this.appContainer.remove();
    }
}
