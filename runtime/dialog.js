/*
 * runtime/dialog.js: the window the File menu's dialogs open in.
 *
 * DialogFrame is the one window UIController keeps: a light, rounded window
 * over a dimmed page, with a title bar that drags it (double-click
 * maximizes it), a maximize and a close button, a body the dialog fills,
 * a footer with a status line, and a grip that resizes it. Where each
 * dialog was left and its size are remembered in this browser's
 * localStorage, by the dialog's id, and not in saved sessions. The window sits
 * inside the emulator's container, so it shows in fullscreen too, and the
 * keys typed into it stop there instead of reaching the Spectrum.
 *
 * openDialog(ui, emu, opts) opens a dialog in it: the machine pauses while it
 * is open, and Escape, the close button and ui.hideDialog() all close it and
 * set the machine going again as it was.
 *
 * The dialogs share the class names in DIALOG_CSS (all starting "jsd-"),
 * built with h() and button().
 */

import closeIcon from './icons/close.svg';

const PLACES_KEY = 'jsspeccy-dialogs';
const MIN_W = 340;
const MIN_H = 260;
const MARGIN = 12;       // the least gap between the window and the page's edge
const KEEP_VISIBLE = 80; // how much of the title bar dragging leaves on the page

const maximizeIcon = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="none" stroke="#000" stroke-width="2"/></svg>';
const restoreIcon = '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="12" height="12" rx="1.5" fill="none" stroke="#000" stroke-width="2"/><path d="M8 8V5.5C8 4.7 8.7 4 9.5 4h9c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5H16" fill="none" stroke="#000" stroke-width="2"/></svg>';

const ACCENT = '#33aa66';

const DIALOG_CSS = `
.jsd-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(12, 14, 18, 0.45); cursor: default;
    font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.4; color: #1f2328; text-align: left; }
.jsd-overlay *, .jsd-overlay *::before, .jsd-overlay *::after { box-sizing: border-box; }
.jsd-window { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 10px; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 18px 48px rgba(0, 0, 0, 0.45); outline: none; }
.jsd-header { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 8px 9px 16px; cursor: move;
    user-select: none; touch-action: none; background: linear-gradient(#f9fafb, #eceef1); border-bottom: 1px solid #d9dde2; }
.jsd-titles { flex: 1; min-width: 0; }
.jsd-title { font-size: 15px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jsd-subtitle { font-size: 12px; color: #5f6670; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jsd-subtitle:empty { display: none; }
.jsd-hbtn { flex: none; width: 28px; height: 28px; padding: 0; border: none; border-radius: 6px; background: transparent;
    display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0.65; }
.jsd-hbtn:hover { background: rgba(0, 0, 0, 0.08); opacity: 1; }
.jsd-hbtn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: -2px; }
.jsd-hbtn svg { display: block; width: 16px; height: 16px; }
.jsd-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.jsd-footer { flex: none; display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 6px 26px 6px 16px;
    background: #f6f7f9; border-top: 1px solid #e1e4e8; font-size: 12px; color: #5f6670; }
.jsd-status { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; overflow-wrap: anywhere; }
.jsd-status.error { color: #b3261e; }
.jsd-status.ok { color: #22804a; }
.jsd-aside { flex: none; color: #8a9099; font-size: 11px; }
.jsd-aside a { color: inherit; }
.jsd-grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none;
    background: linear-gradient(135deg, transparent 0 52%, #aab0b8 52% 57%, transparent 57% 67%, #aab0b8 67% 72%,
    transparent 72% 82%, #aab0b8 82% 87%, transparent 87%); }
.jsd-maximized .jsd-grip { display: none; }

.jsd-bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px;
    border-bottom: 1px solid #e6e8eb; }
.jsd-scroll { flex: 1; min-height: 0; overflow: auto; padding: 8px 12px 14px; }
.jsd-grow { flex: 1; min-width: 0; }
.jsd-note { color: #5f6670; font-size: 12px; }
.jsd-faint { color: #8a9099; font-size: 11px; }
.jsd-mono { font-family: Consolas, Monaco, monospace; }
.jsd-empty { padding: 36px 16px; text-align: center; color: #6a717b; }
.jsd-empty b { display: block; font-size: 14px; color: #3d434a; margin-bottom: 4px; }
.jsd-error-text { color: #b3261e; }

.jsd-input { font: inherit; font-size: 14px; color: #1f2328; background: #fff; padding: 7px 10px; border: 1px solid #c3c8cf;
    border-radius: 6px; outline: none; min-width: 0; transition: border-color 0.12s, box-shadow 0.12s; }
.jsd-input:focus { border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(51, 170, 102, 0.22); }
.jsd-input.small { font-size: 12px; padding: 4px 7px; }
.jsd-search { padding-left: 32px; background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5' fill='none' stroke='%23889' stroke-width='2.2'/%3E%3Cpath d='M15.5 15.5 21 21' stroke='%23889' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat 10px center / 16px; }
select.jsd-input { padding-right: 6px; }

.jsd-btn { font: inherit; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    padding: 6px 12px; border: 1px solid #c3c8cf; border-radius: 6px; background: #fff; color: #1f2328; cursor: pointer;
    white-space: nowrap; transition: background 0.12s, border-color 0.12s; }
.jsd-btn:hover { background: #f1f3f5; border-color: #aeb4bc; }
.jsd-btn:active { background: #e6e9ed; }
.jsd-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
.jsd-btn:disabled { opacity: 0.5; cursor: default; }
.jsd-btn.primary { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; font-weight: bold; }
.jsd-btn.primary:hover { background: #2c9459; border-color: #2c9459; }
.jsd-btn.accent { color: #22804a; border-color: #9fd3b5; font-weight: bold; }
.jsd-btn.accent:hover { background: #e8f5ee; border-color: ${ACCENT}; }
.jsd-btn.danger { color: #b3261e; }
.jsd-btn.danger:hover { background: #fdecea; border-color: #e6a9a4; }
.jsd-btn.danger.armed { background: #b3261e; border-color: #b3261e; color: #fff; }
.jsd-btn.ghost { border-color: transparent; background: transparent; }
.jsd-btn.ghost:hover { background: #eef0f3; }
.jsd-btn.small { padding: 3px 8px; font-size: 11px; border-radius: 5px; }
.jsd-btn .jsd-ico svg { display: block; width: 14px; height: 14px; }
.jsd-btn.primary .jsd-ico svg { filter: invert(1); }

.jsd-tabs { display: inline-flex; padding: 3px; gap: 2px; background: #eceef1; border-radius: 8px; }
.jsd-tab { font: inherit; font-size: 12px; padding: 5px 14px; border: none; border-radius: 6px; background: transparent;
    color: #4a5058; cursor: pointer; }
.jsd-tab:hover { color: #1f2328; }
.jsd-tab.active { background: #fff; color: #1f2328; font-weight: bold; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); }

.jsd-letters { display: flex; flex-wrap: wrap; gap: 3px; }
.jsd-letter { font: inherit; font-size: 12px; min-width: 26px; height: 26px; padding: 0 5px; border: 1px solid #d3d7dc;
    border-radius: 5px; background: #fff; color: #3d434a; cursor: pointer; }
.jsd-letter:hover { border-color: ${ACCENT}; color: #1f2328; }
.jsd-letter.active { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; font-weight: bold; }

.jsd-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px; cursor: pointer;
    border-left: 3px solid transparent; }
.jsd-row + .jsd-row { margin-top: 1px; }
.jsd-row:hover { background: #f2f4f6; }
.jsd-row.selected { background: #e8f5ee; border-left-color: ${ACCENT}; }
.jsd-row-main { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.jsd-row-title { font-weight: bold; }
.jsd-row-meta { color: #5f6670; font-size: 12px; }
.jsd-row-extra { color: #8a6d00; font-size: 12px; }
.jsd-row .jsd-btn { flex: none; }
.jsd-heading { display: flex; align-items: center; gap: 8px; margin: 4px 2px 8px; }
.jsd-heading h3 { margin: 0; font-size: 15px; }

.jsd-badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: #eceef1; color: #4a5058;
    white-space: nowrap; }
.jsd-badge.accent { background: #e8f5ee; color: #22804a; }
.jsd-badge.warn { background: #fff3d6; color: #8a5a00; }

.jsd-help { margin: 12px 4px; padding: 12px 14px; border-radius: 8px; background: #f6f7f9; border: 1px solid #e6e8eb;
    color: #3d434a; line-height: 1.6; }
.jsd-help code, .jsd-kbd { font-family: Consolas, Monaco, monospace; font-size: 12px; padding: 0 4px; border-radius: 4px;
    background: #fff; border: 1px solid #d9dde2; }

.jsd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; padding: 4px; }
.jsd-card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid #dfe2e6; border-radius: 9px;
    background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); transition: box-shadow 0.15s, border-color 0.15s; }
.jsd-card:hover { border-color: #c6cbd1; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.09); }
.jsd-card.current { border-color: ${ACCENT}; box-shadow: 0 0 0 1px ${ACCENT}; }
.jsd-card-top { display: flex; align-items: center; gap: 8px; }
.jsd-card-actions { display: flex; flex-direction: column; gap: 5px; margin-top: auto; padding-top: 8px; border-top: 1px solid #eef0f2; }
.jsd-card-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.jsd-card-row .jsd-faint { margin-right: 2px; }
.jsd-card-top + * { margin-top: 2px; }
.jsd-swatch { flex: none; width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(0, 0, 0, 0.35); cursor: pointer; }
.jsd-swatch.static { cursor: default; }
.jsd-starter-item { padding: 5px 0 1px; border-top: 1px solid #eef0f2; }
.jsd-starter-item .jsd-card-row { gap: 6px; }
.jsd-label { flex: 1; min-width: 0; font: inherit; font-weight: bold; font-size: 14px; color: #1f2328; padding: 2px 4px;
    border: 1px solid transparent; border-radius: 4px; background: transparent; }
.jsd-label:hover:not(:disabled) { border-color: #d9dde2; }
.jsd-label:focus { outline: none; border-color: ${ACCENT}; background: #fff; box-shadow: 0 0 0 3px rgba(51, 170, 102, 0.22); }
.jsd-label:disabled { color: #5f6670; font-weight: normal; font-style: italic; }
.jsd-panel { margin: 0 4px 12px; padding: 12px; border: 1px solid #cfe7d9; border-radius: 9px; background: #f3faf6;
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

.jsd-section { border: 1px solid #e3e6ea; border-radius: 8px; margin-bottom: 8px; overflow: clip; background: #fff; }
.jsd-section-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; user-select: none; background: #fff; }
.jsd-section-head:hover { background: #f5f6f8; }
.jsd-section.open > .jsd-section-head { position: sticky; top: -8px; z-index: 1; background: #f5f6f8; border-bottom: 1px solid #e3e6ea; }
.jsd-chevron { flex: none; width: 12px; font-size: 16px; line-height: 1; text-align: center; color: #8a9099; transition: transform 0.15s; }
.jsd-section.open .jsd-chevron { transform: rotate(90deg); }
.jsd-check { display: flex; align-items: center; gap: 10px; padding: 7px 12px 7px 30px; cursor: pointer; }
.jsd-check + .jsd-check { border-top: 1px solid #f0f1f3; }
.jsd-check:hover { background: #f8f9fa; }
.jsd-check.on { background: #f0f9f4; }
.jsd-check input[type=checkbox] { flex: none; width: 16px; height: 16px; margin: 0; accent-color: ${ACCENT}; cursor: pointer; }
.jsd-detail { flex: none; min-height: 32px; padding: 7px 16px; border-top: 1px solid #e6e8eb; background: #fafbfc;
    font-size: 12px; color: #3d434a; overflow-wrap: anywhere; }
.jsd-applied { flex: none; max-height: 30%; overflow: auto; padding: 8px 16px; border-top: 1px solid #e6e8eb; background: #f3faf6; }
.jsd-applied-item { font-family: Consolas, Monaco, monospace; font-size: 12px; padding: 1px 0; overflow-wrap: anywhere; }

.jsd-spinner { flex: none; display: inline-block; width: 13px; height: 13px; border: 2px solid #cfd4da; border-top-color: ${ACCENT};
    border-radius: 50%; animation: jsd-spin 0.8s linear infinite; }
@keyframes jsd-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .jsd-spinner { animation-duration: 2.4s; } }
`;

/* An element with the given class names and properties. */
export function h(tag, className, props) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (props) Object.assign(e, props);
    return e;
}

/* A dialog button. opts.variant is 'primary', 'accent', 'danger' or 'ghost', opts.small
 * makes it smaller, opts.icon puts an SVG before the label, opts.title is its
 * tooltip. */
export function button(label, opts) {
    const o = opts || {};
    const b = h('button', ['jsd-btn', o.variant, o.small ? 'small' : ''].filter(Boolean).join(' '), { type: 'button' });
    if (o.icon) {
        const icon = h('span', 'jsd-ico');
        icon.innerHTML = o.icon;
        b.appendChild(icon);
    }
    if (label) b.appendChild(h('span', '', { textContent: label }));
    if (o.title) b.title = o.title;
    return b;
}

/* A Delete button that asks once more: the first click arms it with
 * `confirmText` for a few seconds, and a second click then runs onConfirm. */
export function confirmButton(label, confirmText, onConfirm, opts) {
    const b = button(label, { ...(opts || {}), variant: 'danger' });
    const text = b.lastChild;
    let timer = null;
    b.addEventListener('click', () => {
        if (b.classList.contains('armed')) {
            clearTimeout(timer);
            onConfirm();
            return;
        }
        b.classList.add('armed');
        text.textContent = confirmText;
        timer = setTimeout(() => {
            b.classList.remove('armed');
            text.textContent = label;
        }, 3000);
    });
    return b;
}

/* Where each dialog was left, by its id: {width, height}, and {left, top}
 * once it has been moved. Kept in this browser only; a saved session
 * leaves it out. */
function loadPlaces() {
    try {
        const saved = JSON.parse(localStorage.getItem(PLACES_KEY));
        if (saved && typeof saved === 'object') return saved;
    } catch (e) { /* unreadable: every dialog opens at its own size, centred */ }
    return {};
}

function savePlace(id, place) {
    try {
        const places = loadPlaces();
        localStorage.setItem(PLACES_KEY, JSON.stringify({ ...places, [id]: { ...places[id], ...place } }));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

export class DialogFrame {
    constructor(container, teardown) {
        this.overlay = h('div', 'jsd-overlay');
        this.overlay.style.display = 'none';
        this.overlay.appendChild(h('style', '', { textContent: DIALOG_CSS }));

        this.window = h('div', 'jsd-window', { tabIndex: -1 });
        this.window.setAttribute('role', 'dialog');
        this.window.setAttribute('aria-modal', 'true');
        this.overlay.appendChild(this.window);

        this.header = h('div', 'jsd-header');
        const titles = h('div', 'jsd-titles');
        this.titleEl = h('div', 'jsd-title');
        this.subtitleEl = h('div', 'jsd-subtitle');
        titles.append(this.titleEl, this.subtitleEl);
        this.maximizeButton = h('button', 'jsd-hbtn', { type: 'button', title: 'Maximize' });
        this.maximizeButton.innerHTML = maximizeIcon;
        this.closeButton = h('button', 'jsd-hbtn', { type: 'button', title: 'Close (Esc)' });
        this.closeButton.innerHTML = closeIcon;
        this.header.append(titles, this.maximizeButton, this.closeButton);

        this.body = h('div', 'jsd-body');
        this.footer = h('div', 'jsd-footer');
        this.status = h('div', 'jsd-status');
        this.aside = h('div', 'jsd-aside');
        this.footer.append(this.status, this.aside);
        this.grip = h('div', 'jsd-grip', { title: 'Drag to resize' });
        this.window.append(this.header, this.body, this.footer, this.grip);
        container.appendChild(this.overlay);

        this.id = null;
        this.maximized = false;
        this.rect = null;   // {left, top, width, height} while not maximized
        this.onClose = null;

        this.closeButton.addEventListener('click', () => { if (this.onClose) this.onClose(); });
        this.maximizeButton.addEventListener('click', () => this.setMaximized(!this.maximized));
        this.header.addEventListener('dblclick', (e) => {
            if (!e.target.closest('button')) this.setMaximized(!this.maximized);
        });
        // What is typed into the dialog is not for the Spectrum.
        for (const type of ['keydown', 'keyup', 'keypress']) {
            this.overlay.addEventListener(type, (e) => e.stopPropagation());
        }
        // A moved window keeps its place and size; a resized one its size.
        this.dragWith(this.header, (start, dx, dy) => {
            if (this.maximized) return;
            this.place({ ...start, left: start.left + dx, top: start.top + dy });
        }, () => { if (!this.maximized) savePlace(this.id, this.rect); });
        this.dragWith(this.grip, (start, dx, dy) => {
            this.place({ ...start, width: start.width + dx, height: start.height + dy });
        }, () => savePlace(this.id, { width: this.rect.width, height: this.rect.height }));
        window.addEventListener('resize', () => { if (this.isOpen()) this.place(this.rect); }, { signal: teardown });
    }

    /* Calls onMove(startRect, dx, dy) as the pointer drags from `handle`,
     * and onEnd once it lets go, if it moved at all; a click is no drag. */
    dragWith(handle, onMove, onEnd) {
        handle.addEventListener('pointerdown', (e) => {
            if ((e.button !== 0) || e.target.closest('button')) return;
            e.preventDefault();
            handle.setPointerCapture(e.pointerId);
            const start = { ...this.rect };
            const x0 = e.clientX;
            const y0 = e.clientY;
            let moved = false;
            const move = (m) => {
                if ((m.clientX === x0) && (m.clientY === y0)) return;
                moved = true;
                onMove(start, m.clientX - x0, m.clientY - y0);
            };
            const up = () => {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                handle.removeEventListener('pointercancel', up);
                if (moved) onEnd();
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
    }

    /* Puts the window at `rect`, kept on the page: no smaller than the least
     * size, no larger than the page, and with enough of its title bar left
     * showing to drag it back. */
    place(rect) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.round(Math.max(Math.min(MIN_W, vw - (2 * MARGIN)), Math.min(rect.width, vw - (2 * MARGIN))));
        const height = Math.round(Math.max(Math.min(MIN_H, vh - (2 * MARGIN)), Math.min(rect.height, vh - (2 * MARGIN))));
        const left = Math.round(Math.min(Math.max(rect.left, KEEP_VISIBLE - width), vw - KEEP_VISIBLE));
        const top = Math.round(Math.min(Math.max(rect.top, 0), vh - 40));
        this.rect = { left, top, width, height };
        if (!this.maximized) {
            Object.assign(this.window.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
        }
    }

    setMaximized(maximized) {
        this.maximized = maximized;
        this.window.classList.toggle('jsd-maximized', maximized);
        this.maximizeButton.innerHTML = maximized ? restoreIcon : maximizeIcon;
        this.maximizeButton.title = maximized ? 'Restore' : 'Maximize';
        if (maximized) {
            Object.assign(this.window.style, { left: MARGIN + 'px', top: MARGIN + 'px', width: `calc(100% - ${2 * MARGIN}px)`, height: `calc(100% - ${2 * MARGIN}px)` });
        } else {
            this.place(this.rect);
        }
    }

    isOpen() {
        return this.overlay.style.display !== 'none';
    }

    /* Opens the window, empty, for the dialog `opts.id`, where that dialog
     * was last left and at the size it had, kept on the page. One never
     * moved opens centred, and one never resized at opts.width by
     * opts.height. */
    show(opts) {
        this.id = opts.id;
        this.body.replaceChildren();
        this.aside.replaceChildren();
        this.setTitle(opts.title, opts.subtitle);
        this.setStatus('');
        this.overlay.style.display = 'block';
        const saved = loadPlaces()[opts.id] || {};
        const width = Number.isFinite(saved.width) ? saved.width : (opts.width || 600);
        const height = Number.isFinite(saved.height) ? saved.height : (opts.height || 560);
        const fitWidth = Math.min(width, window.innerWidth - (2 * MARGIN));
        const fitHeight = Math.min(height, window.innerHeight - (2 * MARGIN));
        const moved = Number.isFinite(saved.left) && Number.isFinite(saved.top);
        this.maximized = false;
        this.window.classList.remove('jsd-maximized');
        this.maximizeButton.innerHTML = maximizeIcon;
        this.maximizeButton.title = 'Maximize';
        this.place({
            left: moved ? saved.left : ((window.innerWidth - fitWidth) / 2),
            top: moved ? saved.top : Math.max(MARGIN, (window.innerHeight - fitHeight) / 2.4),
            width, height,
        });
        this.window.focus({ preventScroll: true });
    }

    hide() {
        this.overlay.style.display = 'none';
        this.body.replaceChildren();
        this.aside.replaceChildren();
        this.onClose = null;
    }

    setTitle(title, subtitle) {
        this.titleEl.textContent = title || '';
        this.subtitleEl.textContent = subtitle || '';
    }

    /* The footer's status line: `kind` 'busy' adds a spinner, 'error' and
     * 'ok' colour it. */
    setStatus(text, kind) {
        this.status.replaceChildren();
        this.status.className = 'jsd-status' + (((kind === 'error') || (kind === 'ok')) ? ' ' + kind : '');
        if (kind === 'busy') this.status.appendChild(h('span', 'jsd-spinner'));
        if (text) this.status.appendChild(h('span', '', { textContent: text }));
    }
}

/* Opens a dialog in the UI's window, pausing the machine until it closes.
 * opts: id (the key its place and size are remembered by), title, subtitle, width and
 * height, and onClose, called once as it closes. Returns {body, aside,
 * setTitle, setStatus, close, closed}; body is a flex column the dialog
 * fills, usually with a .jsd-bar over a .jsd-scroll. */
export function openDialog(ui, emu, opts) {
    // A dialog already open closes first, putting the machine back as it found it.
    ui.hideDialog();
    const wasRunning = emu.isRunning;
    emu.pause();
    const frame = ui.showDialog(opts);

    let closed = false;
    const onKeyDown = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    };
    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeyDown, true);
        delete ui.hideDialog;
        ui.hideDialog();
        if (opts.onClose) opts.onClose();
        if (wasRunning) emu.start();
        emu.focus();
    }
    // Everything that closes the dialog, its own buttons included, goes through close().
    ui.hideDialog = close;
    frame.onClose = close;
    document.addEventListener('keydown', onKeyDown, { capture: true, signal: ui.teardown });

    return {
        body: frame.body,
        aside: frame.aside,
        setTitle: (title, subtitle) => frame.setTitle(title, subtitle),
        setStatus: (text, kind) => { if (!closed) frame.setStatus(text, kind); },
        close,
        get closed() { return closed; },
    };
}
