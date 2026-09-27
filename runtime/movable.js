/*
 * runtime/movable.js: lets the dark panels (the tape recorder's, a
 * Microdrive's, the printer's, and the card asking before a session is
 * restored) be dragged by their title bar, and some of them resized from a
 * grip in their corner.
 *
 * A panel that has been dragged or resized opens again where it was left,
 * at the size it had; one never touched opens at its own place, beside its
 * device. A double-click on the title bar forgets both and
 * puts it back. Places are kept in this browser's localStorage, by the
 * panel's id, as offsets within the emulator's container, and never in saved
 * sessions.
 */

const PLACES_KEY = 'jsspeccy-panels';
const DRAG_THRESHOLD = 3;   // pixels the pointer moves before a press on the title bar is a drag
const KEEP_VISIBLE = 60;    // how much of the title bar is kept on the page

// Presses on these start no drag: they have work of their own.
const NO_DRAG = 'button, input, select, textarea, a, [data-no-drag]';

function loadPlaces() {
    try {
        const saved = JSON.parse(localStorage.getItem(PLACES_KEY));
        if (saved && typeof saved === 'object') return saved;
    } catch (e) { /* unreadable: every panel opens at its own place */ }
    return {};
}

function savePlaces(places) {
    try {
        localStorage.setItem(PLACES_KEY, JSON.stringify(places));
    } catch (e) { /* private browsing / quota / disabled storage: just don't persist it */ }
}

function updatePlace(id, place) {
    const places = loadPlaces();
    savePlaces({ ...places, [id]: { ...places[id], ...place } });
}

function forgetPlace(id) {
    const places = loadPlaces();
    delete places[id];
    savePlaces(places);
}

/* Follows a pointer pressed on `handle`: onMove(dx, dy) once it has moved
 * past DRAG_THRESHOLD, and onEnd() when it lets go after that. */
function followDrag(handle, onStart, onMove, onEnd) {
    handle.addEventListener('pointerdown', (e) => {
        if ((e.button !== 0) || ((e.target !== handle) && e.target.closest(NO_DRAG))) return;
        const x0 = e.clientX;
        const y0 = e.clientY;
        let dragging = false;
        handle.setPointerCapture(e.pointerId);
        const move = (m) => {
            const dx = m.clientX - x0;
            const dy = m.clientY - y0;
            if (!dragging) {
                if ((Math.abs(dx) < DRAG_THRESHOLD) && (Math.abs(dy) < DRAG_THRESHOLD)) return;
                dragging = true;
                onStart();
            }
            onMove(dx, dy);
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            if (dragging) onEnd();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}

/* Makes `panel`, absolutely placed inside `container`, draggable by
 * `handle`. opts.id is the key its place is kept by. opts.resize, if given,
 * adds a grip that resizes it: {minWidth, minHeight, stretch}, where stretch
 * lists the elements (its scrolling lists) that take up the height a
 * resized panel is given. opts.onReset is called after a double-click has
 * put it back, to place it anew.
 *
 * Returns {place()}: place() puts the panel where it was dragged to and
 * returns true, or returns false for one never dragged, which its owner
 * then places itself. */
export function makeMovable(panel, handle, container, opts) {
    const { id, resize, onReset } = opts;
    Object.assign(handle.style, { cursor: 'move', userSelect: 'none', touchAction: 'none' });
    if (!handle.title) handle.title = 'Drag to move, double-click to put back';

    /* Kept inside the window: the title bar stays where it can be grabbed,
     * whatever has changed since it was put there. */
    function moveTo(left, top) {
        const box = container.getBoundingClientRect();
        const width = panel.offsetWidth;
        const x = Math.min(Math.max(box.left + left, KEEP_VISIBLE - width), window.innerWidth - KEEP_VISIBLE);
        const y = Math.min(Math.max(box.top + top, 0), window.innerHeight - 30);
        Object.assign(panel.style, { left: Math.round(x - box.left) + 'px', top: Math.round(y - box.top) + 'px', transform: 'none' });
    }

    /* A resized panel is as big as it was left, with its lists taking up the
     * height; one never resized has its own width and sizes its height to
     * what it shows. */
    const ownWidth = panel.style.width;
    function applySize(width, height) {
        if (!resize) return;
        const sized = Number.isFinite(width) && Number.isFinite(height);
        panel.style.width = sized ? (Math.max(resize.minWidth, width) + 'px') : ownWidth;
        panel.style.height = sized ? (Math.max(resize.minHeight, height) + 'px') : '';
        for (const e of resize.stretch) {
            if (!e.dataset.maxHeight) e.dataset.maxHeight = e.style.maxHeight;
            Object.assign(e.style, sized
                ? { maxHeight: 'none', flex: '1 1 0', minHeight: '0' }
                : { maxHeight: e.dataset.maxHeight, flex: '', minHeight: '' });
        }
    }

    let start = null;
    followDrag(handle,
        () => { start = { left: panel.offsetLeft, top: panel.offsetTop }; },
        (dx, dy) => moveTo(start.left + dx, start.top + dy),
        () => updatePlace(id, { left: panel.offsetLeft, top: panel.offsetTop }));

    handle.addEventListener('dblclick', (e) => {
        if ((e.target !== handle) && e.target.closest(NO_DRAG)) return;
        forgetPlace(id);
        applySize(null, null);
        panel.style.transform = '';
        if (onReset) onReset();
    });

    if (resize) {
        const grip = document.createElement('div');
        Object.assign(grip.style, {
            position: 'absolute', right: '0', bottom: '0', width: '14px', height: '14px', cursor: 'nwse-resize',
            touchAction: 'none', zIndex: '1',
            background: 'linear-gradient(135deg, transparent 0 50%, #777 50% 56%, transparent 56% 68%, #777 68% 74%, transparent 74% 86%, #777 86% 92%, transparent 92%)',
        });
        grip.title = 'Drag to resize';
        panel.appendChild(grip);
        let size = null;
        // Resizing pins the panel where it is, so it grows from there,
        // rather than from its device, which some are anchored to by their
        // bottom edge.
        followDrag(grip,
            () => {
                size = { width: panel.offsetWidth, height: panel.offsetHeight };
                updatePlace(id, { left: panel.offsetLeft, top: panel.offsetTop });
            },
            (dx, dy) => applySize(size.width + dx, size.height + dy),
            () => updatePlace(id, { width: panel.offsetWidth, height: panel.offsetHeight }));
        const saved = loadPlaces()[id];
        if (saved) applySize(saved.width, saved.height);
    }

    return {
        place() {
            const saved = loadPlaces()[id];
            if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return false;
            moveTo(saved.left, saved.top);
            return true;
        },
    };
}
