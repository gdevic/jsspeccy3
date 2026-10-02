/*
 * runtime/rainbow.js: the four stripes on the Spectrum's case, shared by
 * every rainbow drawn around the machine (the menu bar, the Help and About
 * boxes, the Microdrives, the cassettes), so they all match the keyboard's.
 */

/* Colours and slope taken from the keyboard image (zx_keyboard.png): red,
 * yellow, green, blue from left to right, each band leaning right as it
 * rises, about 0.33 across for every 1 up. */
export const RAINBOW = ['#d0412e', '#e2b13c', '#5fa847', '#3a7cc4'];
export const RAINBOW_SLOPE = 0.33;

/* The stripes as a strip's right end carries them, as the keyboard's right
 * end does: bands `bandW` wide across, the last running off the strip's
 * right edge, cut by it, with the strip showing `inset` wide in the corner
 * below. An SVG, so the slanted edges are smooth, in which each band reaches
 * under the next so that no seam shows between them; it is anchored at the
 * strip's bottom right corner and never stretched, so the bands keep their
 * slope in a strip of any height up to STRIPES_H. Returns the CSS background
 * and its width, for the element that carries it at the strip's right end. */
const STRIPES_H = 200;

export function rainbowStripes(bandW, inset) {
    const width = inset + (RAINBOW.length * bandW), end = width - inset;
    const rise = +(STRIPES_H * RAINBOW_SLOPE).toFixed(2);
    const bands = RAINBOW.map((colour, i) => {
        const x = end - ((RAINBOW.length - i) * bandW);
        return `<polygon points='${x},${STRIPES_H} ${end},${STRIPES_H} ${end + rise},0 ${x + rise},0' fill='${colour}'/>`;
    });
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${STRIPES_H}'>${bands.join('')}</svg>`;
    return {
        width,
        background: `url("data:image/svg+xml,${encodeURIComponent(svg)}") right bottom / ${width}px ${STRIPES_H}px no-repeat`,
    };
}
