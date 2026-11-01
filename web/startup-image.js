// The picture iOS shows while Pi Pocket starts. Without one it shows white until the first paint; with one made here,
// it shows the theme's background. `theme.js` calls `applyStartupImage` with the color it chose.

/** The last picture made, by its color and size: a look that settles on the same one makes no other. */
let applied = null;

/**
 * The device's screen in portrait, in device pixels: iOS turns the picture to fit, and matches one by the screen it was
 * made for.
 *
 * @returns {{ width: number; height: number }}
 */
export function startupSize() {
    const width = Math.round(screen.width * devicePixelRatio);
    const height = Math.round(screen.height * devicePixelRatio);

    return { width: Math.min(width, height), height: Math.max(width, height) };
}

/**
 * Draw the startup picture in `color` and make it the one iOS shows, replacing any other. It does nothing elsewhere
 * than iOS. The picture is a canvas of the whole screen in device pixels, filled with the color, kept as a PNG data
 * URL; the color and the screen's size decide which one, so the same look is drawn once.
 *
 * @param {string} color The background, as CSS takes a color: `#13141c`, or the value of a theme's `--o-bg`.
 * @returns {string | null} The picture's address, or null where none was made.
 */
export function applyStartupImage(color) {
    // iOS gives navigator a `standalone` property; no other browser shows a startup picture.
    if (typeof navigator === "undefined" || !("standalone" in navigator)) {
        return null;
    }

    const { width, height } = startupSize();
    const key = `${color} ${width}x${height}`;

    if (applied?.key === key) {
        return applied.href;
    }

    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");

    if (context === null) {
        return null;
    }

    context.fillStyle = color;
    context.fillRect(0, 0, width, height);

    const href = canvas.toDataURL("image/png");

    // One picture at a time: it is made for this screen, so it needs no media query.
    let link = document.querySelector('link[rel="apple-touch-startup-image"]');

    if (link === null) {
        link = document.createElement("link");
        link.rel = "apple-touch-startup-image";
        document.head.append(link);
    }

    link.removeAttribute("media");
    link.href = href;
    applied = { key, href };

    return href;
}
