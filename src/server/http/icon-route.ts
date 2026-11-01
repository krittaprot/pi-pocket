/**
 * The icon surfaces: `/app-icon.png` draws the app's own icon in chosen colors; `/icons/<id>/<rev>/<file>` serves a
 * design folder's files; `/apple-touch-icon.png`, the page, and `/manifest.webmanifest` follow the design and colors this
 * browser chose (its cookies), else the owner's (`icon-store.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../errors.ts";
import {
    ICON_DESIGN_COOKIE,
    type IconDesign,
    iconDesignById,
    iconDesignFile,
    isIconDesignId,
    MAX_ICON_FILE,
    ORIGINAL_ICON,
} from "../icon-designs.ts";
import { storedIcon } from "../icon-store.ts";
import { APP_ICON, type IconColors, MIN_ICON, renderIcon } from "../icon-render.ts";
import { WEB } from "./assets.ts";
import { readChecked, SVG_CSP } from "./io.ts";

/** The largest icon the route draws: no sign-in is needed, and the drawing runs on the main thread. */
const MAX_SIZE = 512;
const CACHE = 32;
/** New drawings a second, for the whole server: a client that changes a color in each request never finds one kept. */
const DRAWS_PER_SECOND = 8;
const drawn = new Map<string, Buffer>();
const budget = { second: 0, draws: 0 };

/**
 * `renderIcon` with the size capped, and the last icons drawn kept (the least recently used goes first). Null for colors
 * that are not hex; "busy" when this second's drawings are used up.
 */
function draw(colors: IconColors, size: number, maskable = false): Buffer | null | "busy" {
    const n = Math.min(MAX_SIZE, Math.max(MIN_ICON, Math.round(size)));
    const key = `${Object.values(colors).join(".").toLowerCase()}/${n}/${maskable}`;
    const kept = drawn.get(key);

    if (kept !== undefined) {
        drawn.delete(key);
        drawn.set(key, kept);

        return kept;
    }

    const second = Math.floor(Date.now() / 1000);

    if (budget.second !== second) {
        budget.second = second;
        budget.draws = 0;
    }

    if (budget.draws >= DRAWS_PER_SECOND) {
        return "busy";
    }

    const png = renderIcon(colors, n, maskable);

    if (png !== null) {
        budget.draws++;
        drawn.set(key, png);

        if (drawn.size > CACHE) {
            drawn.delete(drawn.keys().next().value!);
        }
    }

    return png;
}

export function iconRoute(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    const colors = { ...APP_ICON };

    for (const name of Object.keys(colors) as (keyof IconColors)[]) {
        const value = url.searchParams.get(name);

        if (value !== null) {
            colors[name] = `#${value}`;
        }
    }

    const size = Number(url.searchParams.get("size") ?? 180);

    if (!Number.isFinite(size)) {
        throw new HttpError(400, "The size is a number");
    }

    const png = draw(colors, size, url.searchParams.get("maskable") === "1");

    if (png === "busy") {
        response.writeHead(503, { "retry-after": "1", "cache-control": "no-store" });
        response.end();

        return;
    }

    if (png === null) {
        throw new HttpError(400, "Colors are 3 or 6 hex digits");
    }

    // The colors are in the address, so a copy never goes stale.
    response.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "public, max-age=31536000, immutable",
    });
    response.end(request.method === "HEAD" ? undefined : png);
}

/** A cookie's value, as `web/app-icon.js` writes it: plain characters, no spaces. */
function cookieValue(request: IncomingMessage, name: string): string | undefined {
    const found = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.cookie ?? "");

    return found?.[1];
}

const HEX = "(?:[0-9a-f]{3}|[0-9a-f]{6})";
const COOKIE = new RegExp(`(?:^|;\\s*)pocket_icon=(${HEX}(?:\\.${HEX}){4})(?:;|$)`, "i");

/** The colors in the request's `pocket_icon` cookie (`frame.card.ring1.ring2.pi`, which `web/app-icon.js` keeps), or null. */
function cookieColors(request: IncomingMessage, dataDir: string): string[] | null {
    return (
        COOKIE.exec(request.headers.cookie ?? "")?.[1]?.split(".") ??
        storedIcon(dataDir).colors ??
        null
    );
}

/**
 * The design in this browser's cookie (`pocket_icon_design`, which `web/app-icon.js` keeps), or the owner's, or null.
 * The cookie's literal `original` is an explicit choice of the app's own icon: it does not fall back to the owner's
 * design. A design whose folder is gone is null too, so the app's own icon shows.
 */
function designFor(request: IncomingMessage, dataDir: string): IconDesign | null {
    const value = cookieValue(request, ICON_DESIGN_COOKIE);

    if (value !== undefined) {
        const id = value.trim();

        if (id === ORIGINAL_ICON) {
            return null;
        }

        if (isIconDesignId(id)) {
            return iconDesignById(WEB, dataDir, id);
        }
    }

    const stored = storedIcon(dataDir).design;

    return stored === null ? null : iconDesignById(WEB, dataDir, stored);
}

/** What a request's cookies choose: a design, else the colors to draw the app's own icon in (or neither). */
export type IconChoice = { design: IconDesign | null; colors: string[] | null };

/**
 * The design and colors this request gets, read once: the page's links, the home-screen icon, and the manifest all use
 * it (`http.ts`).
 */
export function iconChoice(request: IncomingMessage, dataDir: string): IconChoice {
    return { design: designFor(request, dataDir), colors: cookieColors(request, dataDir) };
}

/** Write one design file, as it was scanned: a copy under the version in its address never goes stale. */
function sendDesignFile(
    request: IncomingMessage,
    response: ServerResponse,
    served: NonNullable<ReturnType<typeof iconDesignFile>>,
): void {
    const body = readChecked(served.stat, MAX_ICON_FILE);

    response.writeHead(200, {
        "content-type": served.type,
        "content-length": body.length,
        // Only under the version the files are now is the address immutable; an older one serves them as they are.
        "cache-control": served.current
            ? "public, max-age=31536000, immutable"
            : "public, no-cache",
        "x-content-type-options": "nosniff",
        ...(served.type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : body);
}

/**
 * `/icons/<id>/<file>` (a built-in design's plain address, which older pages use) and `/icons/<id>/<rev>/<file>` (every
 * design's, with the version in the address).
 */
export function iconsRoute(
    request: IncomingMessage,
    response: ServerResponse,
    parts: string[],
    dataDir: string,
): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Files are only read");
    }

    const [id, second, third] = parts;
    const name = parts.length === 2 ? second : parts.length === 3 ? third : undefined;
    const rev = parts.length === 3 ? second : undefined;
    const served =
        id === undefined || name === undefined || parts.length > 3
            ? undefined
            : iconDesignFile(WEB, dataDir, id, rev, name);

    // A data folder's design has only its versioned address: the plain one belongs to the app's own files.
    if (served === undefined || (parts.length === 2 && !served.design.builtIn)) {
        throw new HttpError(404, "Not found");
    }

    sendDesignFile(request, response, served);
}

/** The icon for a request with no cookie, as a phone's own fetch of the icon is: the design's, else the owner's colors. */
export function appleTouchIcon(
    request: IncomingMessage,
    response: ServerResponse,
    choice: IconChoice,
): boolean {
    if (choice.design !== null) {
        const stat = choice.design.files.get("apple-touch-icon.png");

        if (stat !== undefined) {
            try {
                const png = readChecked(stat, MAX_ICON_FILE);

                response.writeHead(200, {
                    "content-type": "image/png",
                    "content-length": png.length,
                    "cache-control": "no-cache",
                });
                response.end(request.method === "HEAD" ? undefined : png);

                return true;
            } catch {
                // The folder changed under the request: the file below, as it was.
            }
        }
    }

    if (choice.colors === null) {
        return false;
    }

    const [frame, card, ring1, ring2, pi] = choice.colors as [
        string,
        string,
        string,
        string,
        string,
    ];
    const png = draw(
        {
            frame: `#${frame}`,
            card: `#${card}`,
            ring1: `#${ring1}`,
            ring2: `#${ring2}`,
            pi: `#${pi}`,
        },
        180,
    );

    // Too many drawings this second: the app's own icon file goes instead.
    if (png === null || png === "busy") {
        return false;
    }

    response.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : png);

    return true;
}

const address = (colors: string[], size: number, maskable = false) => {
    const [frame, card, ring1, ring2, pi] = colors as [string, string, string, string, string];
    const query = new URLSearchParams({ frame, card, ring1, ring2, pi, size: String(size) });

    if (maskable) {
        query.set("maskable", "1");
    }

    return `/app-icon.png?${query}`;
};

/**
 * The home-screen icon's address for the design in the cookie, or the owner's, else the colors', or null. iOS may read
 * the icon from the page as served, so the page carries it.
 */
export function iconAddress(choice: IconChoice): string | null {
    if (choice.design !== null) {
        return choice.design.touch;
    }

    return choice.colors === null ? null : address(choice.colors, 180);
}

/** The tab's icon for the design in the cookie, or null for the page's own (`web/icon.svg`). */
export function tabAddress(choice: IconChoice): string | null {
    return choice.design?.tab ?? null;
}

/**
 * The web app manifest with the icons and colors of the cookie, or null without one (the file is served as it is).
 * iOS and Android read the manifest's icons too, and an icon there that is not the page's own wins over it.
 */
export function manifestFor(file: string, choice: IconChoice): string | null {
    if (choice.design !== null) {
        return JSON.stringify({
            ...(JSON.parse(file) as Record<string, unknown>),
            background_color: choice.design.background,
            theme_color: choice.design.background,
            icons: choice.design.icons,
        });
    }

    const colors = choice.colors;

    if (colors === null) {
        return null;
    }

    const manifest = JSON.parse(file) as Record<string, unknown>;
    const icon = (size: number, maskable: boolean) => ({
        src: address(colors, size, maskable),
        sizes: `${size}x${size}`,
        type: "image/png",
        ...(maskable ? { purpose: "maskable" } : {}),
    });

    return JSON.stringify({
        ...manifest,
        background_color: `#${colors[0]}`,
        theme_color: `#${colors[0]}`,
        icons: [icon(192, false), icon(512, false), icon(512, true)],
    });
}
