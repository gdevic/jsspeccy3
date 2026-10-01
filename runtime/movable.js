/*
 * runtime/movable.js: lets the dark panels (the tape recorder's, a
 * Microdrive's, the printer's, and the card asking before a session is
 * restored) be dragged by their title bar, and some of them resized from a
 * grip in their corner; and lets the devices standing beside the Spectrum
 * (the recorder, the Microdrives, the printer) be dragged about by their
 * body, trailing their cable from the Spectrum.
 *
 * A panel that has been dragged or resized opens again where it was left,
 * at the size it had; one never touched opens at its own place, beside its
 * device. A double-click on the title bar forgets both and puts it back.
 *
 * A device is moved as a whole, in its own drawn units, away from where its
 * owner stands it, anywhere, off the page included: its cable is redrawn to
 * follow, stretched between the socket on the Spectrum and the device's
 * rear. Devices never overlap one another: a drag slides along another
 * device rather than into it, and one left overlapping another (after a
 * zoom, or another device appearing) is put back where its owner stands
 * it. A click on a device's cable puts it back too, along with any other
 * device that has been moved into the place it goes back to.
 *
 * Places are kept in this browser's localStorage, by the panel's or device's
 * id, as offsets within the emulator's container (a panel) or in drawn units
 * from where the owner stands it (a device), and never in saved sessions.
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
 * past DRAG_THRESHOLD, and onEnd() when it lets go after that. The pointer
 * is captured only once it is a drag, so a plain press still clicks
 * whatever it was pressed on; the click that ends a drag goes nowhere. The
 * press is followed on the window, so letting go anywhere ends it. */
function followDrag(handle, onStart, onMove, onEnd) {
    let swallowClick = false;
    handle.addEventListener('click', (e) => {
        if (!swallowClick) return;
        swallowClick = false;
        e.stopPropagation();
    }, true);
    handle.addEventListener('pointerdown', (e) => {
        if ((e.button !== 0) || ((e.target !== handle) && e.target.closest(NO_DRAG))) return;
        const x0 = e.clientX;
        const y0 = e.clientY;
        let dragging = false;
        const move = (m) => {
            if (m.pointerId !== e.pointerId) return;
            const dx = m.clientX - x0;
            const dy = m.clientY - y0;
            if (!dragging) {
                if ((Math.abs(dx) < DRAG_THRESHOLD) && (Math.abs(dy) < DRAG_THRESHOLD)) return;
                dragging = true;
                handle.setPointerCapture(e.pointerId);
                onStart();
            }
            onMove(dx, dy);
        };
        const up = (m) => {
            if (m.pointerId !== e.pointerId) return;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (!dragging) return;
            swallowClick = true;
            setTimeout(() => { swallowClick = false; }, 0);
            onEnd();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
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

/* ==================== the devices beside the Spectrum ==================== */

const DEVICE_GAP = 2;   // pixels of daylight a drag keeps between two devices
const CABLE_Z = '89';   // the cables' layer, below every device
const devices = [];     // every device made movable, shown or not

// Whether a and b are within `gap` pixels of each other.
function touching(a, b, gap) {
    return (a.left < (b.right + gap)) && (a.right > (b.left - gap))
        && (a.top < (b.bottom + gap)) && (a.bottom > (b.top - gap));
}

/* Puts back any moved device that overlaps another, until none does: after
 * a zoom, a window resize, or a device appearing where another had been
 * moved to. Run once per frame, after every owner has re-placed its
 * device. Overlap proper, not the drag's gap, since a zoom shrinks the gap
 * a drag left. */
let settling = 0;
function scheduleSettle() {
    if (settling) return;
    settling = requestAnimationFrame(() => {
        settling = 0;
        settle();
    });
}
function settle() {
    for (let guard = 0; guard < devices.length; guard++) {
        const shown = devices.filter(d => d.shown());
        const moved = shown.find(d => d.moved() && shown.some(o => (o !== d) && touching(d.rect(), o.rect(), 0)));
        if (!moved) return;
        moved.reset();
    }
}

// The closed hand while a device is dragged, over whatever the pointer is on.
const DRAG_CSS = '[data-dragging], [data-dragging] * { cursor: grabbing !important; }';

/* Makes a device draggable by `body`, the drawn device itself, inside the
 * scaled element its owner stands beside the Spectrum, with `cable` the
 * SVG of its lead to the Spectrum. opts.id keys its place; opts.draw(dx, dy)
 * redraws the cable to the body's rear moved by (dx, dy) drawn units,
 * and a click anywhere on it puts the device back; opts.onMove() is
 * called whenever the body has moved, for the owner to re-place what
 * hangs on it (its panel, the room made on the page).
 *
 * Returns {offset(), dragging(), update()}: offset() is how far the body
 * is moved, in drawn units; dragging() is whether it is being dragged
 * now, while the owner leaves the page's layout alone, since a shift of
 * the page under the pointer would throw the drag off; update() redraws
 * the cable and checks the device's place again, for the owner to call
 * whenever it has placed or scaled the device. */
export function makeDeviceMovable(body, cable, opts) {
    const { id, draw, onMove } = opts;
    let offset = { x: 0, y: 0 };
    // An open hand over the body; its parts that a click works keep their
    // own pointing hand.
    Object.assign(body.style, { userSelect: 'none', touchAction: 'none', cursor: 'grab' });
    body.dataset.reach = '';
    const dragStyle = document.createElement('style');
    dragStyle.textContent = DRAG_CSS;
    body.appendChild(dragStyle);

    const shown = () => body.getClientRects().length > 0;
    const rect = () => body.getBoundingClientRect();
    const scale = () => rect().width / body.offsetWidth;

    /* Every cable runs under every device, its own included, so it is not
     * drawn inside its owner's scaled element (a stacking context of its
     * own, which another device's cable could not go below) but in a layer
     * of its own beneath them all, laid over the slot it leaves there at the
     * same place and scale. */
    const slot = document.createElement('div');
    slot.style.flex = 'none';
    cable.replaceWith(slot);
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', zIndex: CABLE_Z, transformOrigin: '0 0', pointerEvents: 'none', display: 'none' });
    layer.appendChild(cable);

    function placeCable() {
        slot.style.width = cable.getAttribute('width') + 'px';
        slot.style.height = cable.getAttribute('height') + 'px';
        const host = slot.offsetParent;  // the owner's element; none while it is hidden
        const container = host && host.parentNode;
        if (!container || !slot.offsetHeight) {
            layer.style.display = 'none';
            return;
        }
        if (layer.parentNode !== container) container.appendChild(layer);
        const r = slot.getBoundingClientRect();
        const c = container.getBoundingClientRect();
        Object.assign(layer.style, {
            display: 'block',
            left: (r.left - c.left - container.clientLeft + container.scrollLeft) + 'px',
            top: (r.top - c.top - container.clientTop + container.scrollTop) + 'px',
            transform: `scale(${r.height / slot.offsetHeight})`,
        });
    }
    // Shown and hidden with its owner's element, which may not tell.
    if (window.ResizeObserver) new ResizeObserver(placeCable).observe(slot);

    function apply(x, y) {
        offset = { x, y };
        body.style.transform = (x || y) ? `translate(${x}px, ${y}px)` : '';
        draw(x, y);
        placeCable();
    }

    const saved = loadPlaces()[id] || {};
    const num = (v) => (Number.isFinite(v) ? v : 0);
    apply(num(saved.dx), num(saved.dy));

    /* Dragged in page pixels, anywhere at all, off the page included (its
     * cable's click brings it back), but never onto another device:
     * pushed against one, the body slides along it, moving in whichever
     * direction is still free. */
    let drag = null;
    followDrag(body,
        () => {
            const r = rect();
            const s = scale();
            body.dataset.dragging = '';
            drag = {
                from: r, scale: s, last: { x: r.left, y: r.top },
                base: { x: r.left - (offset.x * s), y: r.top - (offset.y * s) },
                others: devices.filter(d => (d.body !== body) && d.shown()).map(d => d.rect()),
            };
        },
        (dx, dy) => {
            const { from, last, base, others } = drag;
            const x = from.left + dx;
            const y = from.top + dy;
            const free = (px, py) => {
                const r = { left: px, top: py, right: px + from.width, bottom: py + from.height };
                return !others.some(o => touching(r, o, DEVICE_GAP));
            };
            const to = free(x, y) ? { x, y } : free(x, last.y) ? { x, y: last.y } : free(last.x, y) ? { x: last.x, y } : last;
            drag.last = to;
            apply((to.x - base.x) / drag.scale, (to.y - base.y) / drag.scale);
            onMove();
        },
        () => {
            drag = null;
            delete body.dataset.dragging;
            updatePlace(id, { dx: offset.x, dy: offset.y });
            onMove();
        });

    function reset() {
        forgetPlace(id);
        apply(0, 0);
        onMove();
    }

    cable.addEventListener('click', () => {
        reset();
        settle();
    });

    const device = {
        body, shown, rect, reset,
        moved: () => (offset.x !== 0) || (offset.y !== 0),
    };
    devices.push(device);

    return {
        offset: () => offset,
        dragging: () => drag !== null,
        update() {
            draw(offset.x, offset.y);
            placeCable();
            scheduleSettle();
        },
    };
}
