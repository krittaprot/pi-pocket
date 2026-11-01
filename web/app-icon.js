// The app's icons: the tab's icon and the home-screen icon (`apple-touch-icon`, which iOS and Android's "add to home
// screen" shortcut read). Appearance's App icon chooses between designs (`icon-designs.ts`).
//
// Original: the app's own icon, drawn here in the colors in use, and the server draws its home-screen PNG. The other
// designs are the files in `web/icons/<id>/`. The web app manifest's icons follow the same cookies: the server answers
// `/manifest.webmanifest` with them (`src/server/http/icon-route.ts`).

const SIZE = 512;
const APPLE = 180;
// What a palette lacks keeps the app's own icon color.
const DEFAULTS = {
    "--o-bg": "#1a1b26",
    "--o-bg-darker": "#13141c",
    "--o-orange": "#ff9e64",
    "--o-cyan": "#33ccff",
    "--o-green": "#00ff99",
};

/**
 * The designs Appearance offers, in its order: the app's own icon, then a folder of ready-made files each. A design the
 * server does not have falls back to the app's own icon: the page asks for files that are not there otherwise.
 */
export const DESIGNS = [
    {
        id: "original",
        name: "Original",
        detail: "The app's own icon, in the colors of the theme in use",
        thumb: "/apple-touch-icon.png",
    },
    {
        id: "light",
        name: "Light",
        detail: "A white tile with the π in ink",
        thumb: "/icons/light/thumb.png",
        tab: "/icons/light/icon.svg",
        touch: "/icons/light/apple-touch-icon.png",
    },
    {
        id: "icon-dark",
        name: "Cards, ink",
        detail: "A deck of cards on an ink tile",
        thumb: "/icons/icon-dark/thumb.png",
        tab: "/icons/icon-dark/icon.svg",
        touch: "/icons/icon-dark/apple-touch-icon.png",
    },
    {
        id: "icon-light",
        name: "Cards, paper",
        detail: "A deck of cards on a paper tile",
        thumb: "/icons/icon-light/thumb.png",
        tab: "/icons/icon-light/icon.svg",
        touch: "/icons/icon-light/apple-touch-icon.png",
    },
    {
        id: "pocket-dark",
        name: "Pocket, ink",
        detail: "The π inside a pocket, on an ink tile",
        thumb: "/icons/pocket-dark/thumb.png",
        tab: "/icons/pocket-dark/icon-192.png",
        touch: "/icons/pocket-dark/apple-touch-icon.png",
    },
    {
        id: "pocket-light",
        name: "Pocket, paper",
        detail: "The π inside a pocket, on a paper tile",
        thumb: "/icons/pocket-light/thumb.png",
        tab: "/icons/pocket-light/icon-192.png",
        touch: "/icons/pocket-light/apple-touch-icon.png",
    },
];

/** The design with `id`, or the app's own icon for one this app does not have. */
export const designOf = (id) => DESIGNS.find((each) => each.id === id) ?? DESIGNS[0];

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

/** The colors in use, `frame.card.ring1.ring2.pi`, and whether this browser reports them: only the owner's may. */
let colorsInUse = null;
let reports = false;
/** The design in use, as `applyIcons` last put it on the page. */
let designInUse = "original";

/** Once the person is known: the owner's browser reports the colors (a guest's or a viewer's would be refused). */
export function reportIconsAs(owner) {
    reports = owner;

    if (owner && colorsInUse !== null) {
        void reportToServer(colorsInUse, designInUse === "original" ? null : designInUse);
    }
}

/**
 * Put the icons of `design` on the page: the tab's, and the home screen's. The app's own icon follows `vars`; a design is
 * the files of its folder. The same colors and design again do nothing.
 */
export function applyIcons(vars, id = "original") {
    const design = designOf(id);
    const key = JSON.stringify([design.id, ...Object.keys(DEFAULTS).map((name) => vars[name])]);

    if (key === applied) {
        return;
    }

    applied = key;

    if (design.id === "original") {
        setLink("icon", svgUrl(iconSvg(vars)), "image/svg+xml");
        setLink("apple-touch-icon", homeIconUrl(vars));
    } else {
        setLink("icon", design.tab, design.tab.endsWith(".svg") ? "image/svg+xml" : "image/png");
        setLink("apple-touch-icon", design.touch);
    }

    colorsInUse = cookieValue(vars);
    designInUse = design.id;
    keep(COOKIE, colorsInUse, 31536000);
    // The app's own icon clears the design, so the page and the manifest of the next load are the colors' again.
    keep(
        DESIGN_COOKIE,
        design.id === "original" ? "" : design.id,
        design.id === "original" ? 0 : 31536000,
    );

    if (reports) {
        void reportToServer(colorsInUse, design.id === "original" ? null : design.id);
    }
}
