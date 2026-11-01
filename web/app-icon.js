// The app's icons: the tab's icon and the home-screen icon (`apple-touch-icon`, which iOS and Android's "add to home
// screen" shortcut read). Appearance's App icon chooses between designs (`icon-designs.ts`).
//
// Original: the app's own icon, drawn here in its fixed charcoal colors, or in the colors in use when the person asks it
// to match the theme; the server draws its home-screen PNG. The other designs are the folders the server lists at
// `/api/icon-designs`. The web app manifest's icons follow the same cookies: the server answers `/manifest.webmanifest`
// with them (`src/server/http/icon-route.ts`).

const SIZE = 512;
const APPLE = 180;

// The app's own icon, which "Match the theme's colors" leaves alone: the same colors as `APP_ICON` in icon-render.ts.
export const ORIGINAL_COLORS = {
    "--o-bg": "#1a1b26",
    "--o-bg-darker": "#13141c",
    "--o-orange": "#ff9e64",
    "--o-cyan": "#33ccff",
    "--o-green": "#00ff99",
};

const DEFAULTS = ORIGINAL_COLORS;

/** The icon as SVG text, from the palette's variables (`themeVars`): the drawing of `icon.svg` in the palette's colors. */
export function iconSvg(vars) {
    const color = (name) => vars[name] ?? DEFAULTS[name];

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
        <defs>
            <linearGradient id="ring" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stop-color="${color("--o-cyan")}" />
                <stop offset="1" stop-color="${color("--o-green")}" />
            </linearGradient>
        </defs>
        <rect width="${SIZE}" height="${SIZE}" fill="${color("--o-bg-darker")}" />
        <rect x="40" y="40" width="432" height="432" rx="75" fill="${color("--o-bg")}" stroke="url(#ring)" stroke-width="12" />
        <text x="256" y="350" font-family="Georgia, 'Times New Roman', serif" font-size="280" text-anchor="middle" fill="${color("--o-orange")}">π</text>
    </svg>`;
}

const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/**
 * The app's own icon as a card: its fixed charcoal colors, which is what it is unless the person asks it to match the
 * theme. The other cards come from the server (`loadDesigns`).
 */
export const ORIGINAL_DESIGN = {
    id: "original",
    name: "Original",
    detail: "The app's own π icon",
    thumb: svgUrl(iconSvg(DEFAULTS)),
    background: DEFAULTS["--o-bg"],
};

/**
 * The designs the server has (`GET /api/icon-designs`), once loaded: empty until then, and kept after the first good
 * answer. The app's own icon is not among them.
 */
let designs = [];
let loading = null;

/** The server's designs, loading them once. A failure leaves just the app's own icon, and is tried again next time. */
export function loadDesigns() {
    if (designs.length > 0) {
        return Promise.resolve(designs);
    }

    if (loading !== null) {
        return loading;
    }

    loading = fetch("/api/icon-designs")
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
            const list = Array.isArray(body)
                ? body
                : Array.isArray(body?.designs)
                  ? body.designs
                  : [];

            designs = list.filter((each) => typeof each?.id === "string");

            return designs;
        })
        .catch(() => designs)
        .finally(() => {
            loading = null;
        });

    return loading;
}

/** The design with `id`: the app's own, one the server listed, or null while the list is not here (or is gone). */
export const designOf = (id) =>
    id === "original" ? ORIGINAL_DESIGN : (designs.find((each) => each.id === id) ?? null);

/**
 * A palette color as the server takes it: hex with no `#`, 3 or 6 digits. Its alpha is dropped (an icon is opaque), and a
 * color in another form is the app's own.
 */
const hex = (vars, name) => {
    const value = (vars[name] ?? "").trim().replace("#", "").toLowerCase();
    const opaque = /^[0-9a-f]{8}$/.test(value)
        ? value.slice(0, 6)
        : /^[0-9a-f]{4}$/.test(value)
          ? value.slice(0, 3)
          : value;

    return /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(opaque) ? opaque : DEFAULTS[name].replace("#", "");
};

/**
 * The home-screen icon's address: the server draws the PNG (`src/server/icon-render.ts`). A phone fetches it when the
 * icon is added, and does not take a `data:` or `blob:` address for it.
 */
const homeIconUrl = (vars) => {
    const color = (name) => hex(vars, name);
    const query = new URLSearchParams({
        frame: color("--o-bg-darker"),
        card: color("--o-bg"),
        ring1: color("--o-cyan"),
        ring2: color("--o-green"),
        pi: color("--o-orange"),
        size: String(APPLE),
    });

    return `/app-icon.png?${query}`;
};

/**
 * The colors in a cookie, `frame.card.ring1.ring2.pi` in hex: iOS may read the icon from the page as it is served, before
 * any script runs, so the server puts the address in the page from this cookie (`src/server/http/icon-route.ts`).
 */
const COOKIE = "pocket_icon";
const cookieValue = (vars) =>
    ["--o-bg-darker", "--o-bg", "--o-cyan", "--o-green", "--o-orange"]
        .map((name) => hex(vars, name))
        .join(".");

/** The design in a cookie of its own: the server reads it as it reads the colors, for the page and the manifest. */
const DESIGN_COOKIE = "pocket_icon_design";

const keep = (name, value, seconds) => {
    document.cookie = `${name}=${value}; path=/; max-age=${seconds}; samesite=lax`;
};

function setLink(rel, href, type) {
    let link = document.querySelector(`link[rel="${rel}"]`);

    if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        document.head.append(link);
    }

    if (type) {
        link.type = type;
    }

    link.href = href;
}

/**
 * A phone fetches the page and the icon in a session of its own, with no cookie: the owner's browser tells the server the
 * colors and the design too (`reportIconsAs`). Not awaited; a failure only leaves the cookie's own.
 */
async function reportToServer(colors, design) {
    try {
        const response = await fetch("/api/app-icon", {
            method: "PUT",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ colors, design }),
        });

        if (!response.ok && response.status !== 401 && response.status !== 403) {
            console.warn(
                `Pi Pocket: the icon colors were not kept by the server (${response.status}).`,
            );
        }
    } catch (error) {
        console.warn("Pi Pocket: the icon colors could not be sent to the server.", error);
    }
}

let applied = "";
/** The last design asked for, while its files are still loading: a late answer does not undo a newer choice. */
let asked = null;

/** The colors in use, `frame.card.ring1.ring2.pi`, and whether this browser reports them: only the owner's may. */
let colorsInUse = null;
let reports = false;
/** The design in use, as `applyIcons` last put it on the page. */
let designInUse = "original";

/** Once the person is known: the owner's browser reports the colors (a guest's or a viewer's would be refused). */
export function reportIconsAs(owner) {
    reports = owner;

    if (owner && colorsInUse !== null) {
        void reportToServer(colorsInUse, designInUse);
    }
}

const paletteKey = (vars) => Object.keys(DEFAULTS).map((name) => vars[name]);

/**
 * Put the icons of `design` on the page: the tab's, and the home screen's. The app's own icon follows `vars` only when
 * `follows` is on; otherwise it keeps its charcoal colors. A design is the files of its folder. The same choice again
 * does nothing.
 */
export function applyIcons(vars, id = "original", follows = false) {
    const wanted = typeof id === "string" && id !== "" ? id : "original";
    const design = designOf(wanted);

    if (design === null) {
        // The server's list is not here yet (or that design is gone): draw it once it is, or the app's own icon.
        asked = wanted;
        void loadDesigns().then((list) => {
            if (asked !== wanted) {
                return;
            }

            applied = "";
            applyIcons(
                vars,
                list.some((each) => each.id === wanted) ? wanted : "original",
                follows,
            );
        });

        return;
    }

    const key =
        design.id === "original"
            ? JSON.stringify(["original", follows, follows ? paletteKey(vars) : "fixed"])
            : JSON.stringify([design.id, design.tab, design.touch]);

    if (key === applied) {
        return;
    }

    applied = key;
    asked = null;

    if (design.id === "original") {
        // Off keeps the charcoal icon whatever theme is in use.
        const colors = follows ? vars : DEFAULTS;

        setLink("icon", svgUrl(iconSvg(colors)), "image/svg+xml");
        setLink("apple-touch-icon", homeIconUrl(colors));
        colorsInUse = cookieValue(colors);
    } else {
        setLink("icon", design.tab, design.tab.endsWith(".svg") ? "image/svg+xml" : "image/png");
        setLink("apple-touch-icon", design.touch);
        colorsInUse = cookieValue(DEFAULTS);
    }

    designInUse = design.id;
    keep(COOKIE, colorsInUse, 31536000);
    // The app's own icon is a choice of its own too: the server must not fall back to the owner's other design.
    keep(DESIGN_COOKIE, design.id, 31536000);

    if (reports) {
        void reportToServer(colorsInUse, design.id);
    }
}
