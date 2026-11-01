/**
 * The app icon designs a person can choose in Appearance: each is a folder in `web/icons/<id>/`, and the owner's are
 * folders in `<dataDir>/icons/<id>/`. A folder holds the same files as the app's own icon in `web/`, plus a `design.json`
 * with its name, its one-line description, and the color a manifest puts behind it. `original`, the app's icon drawn in
 * the colors in use (`icon-render.ts`) or in its own charcoal (`web/app-icon.js`), has no folder.
 *
 * The files are read by the page (`web/app-icon.js`), by the manifest, and by a phone that adds a home-screen icon
 * (`http/icon-route.ts`), so a design is checked here once, in one place. The scan is kept for a moment, so a request
 * does not read every folder again; a changed file changes the design's `rev`, which is in every address it serves.
 */
import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The cookie `web/app-icon.js` keeps this browser's design in, read here and in `http/icon-route.ts`. */
export const ICON_DESIGN_COOKIE = "pocket_icon_design";

/** A design's id: a folder name of lowercase words joined by dashes, as `icon-dark` is. */
export const ICON_DESIGN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The app's own icon, in the cookie: a choice of its own, not the owner's stored design. */
export const ORIGINAL_ICON = "original";

/** Whether `value` could name a design, without reading a folder: what the API takes from a browser. */
export const isIconDesignId = (value: unknown): value is string =>
    typeof value === "string" && value !== ORIGINAL_ICON && ICON_DESIGN_ID.test(value);

/** The files of a design's folder, which are all it may serve. `design.json` is read, never served. */
const FILES = [
    "apple-touch-icon.png",
    "favicon-32.png",
    "icon-1024.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "icon.svg",
    "thumb.png",
    "design.json",
] as const;

/** The files every design has: `thumb.png` and the tab's icons are optional. */
const NEEDED = [
    "design.json",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "apple-touch-icon.png",
] as const;

/** The files a browser may ask for: the art, never the folder's `design.json`. */
export const ICON_FILES = new Set<string>(FILES.filter((file) => file !== "design.json"));

/** The largest design file served: a 1024-pixel PNG is well under it. */
export const MAX_ICON_FILE = 8 * 1024 * 1024;

/** How long a scan is kept before the folders are read again: a file changed in place changes its design's rev. */
const SCAN_TTL = 1000;

export type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string };

/** One of a design's files, as it was when the folder was scanned. */
export type IconFile = {
    file: string;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
};

export type IconDesign = {
    id: string;
    name: string;
    detail: string;
    /** `#rrggbb`, what a manifest puts behind and around the icon. */
    background: string;
    /** In `web/icons/`, with the app: its files are also served at `/icons/<id>/<file>`. */
    builtIn: boolean;
    /** Changes when any of its files do: every address it serves carries it. */
    rev: string;
    dir: string;
    files: ReadonlyMap<string, IconFile>;
    /** The browser tab's icon: the SVG, else the 32px favicon, else the 192px PNG. */
    tab: string;
    /** What iOS and Android keep on the home screen: `apple-touch-icon`. */
    touch: string;
    /** The card's picture: `thumb.png`, else the home screen's icon. */
    thumb: string;
    /** What `/manifest.webmanifest` lists, in the order a browser wants them. */
    icons: ManifestIcon[];
};

/** A design as the API lists it, in Appearance's cards. */
export type IconDesignInfo = {
    id: string;
    name: string;
    detail: string;
    thumb: string;
    tab: string;
    touch: string;
    background: string;
};

/** A design folder that cannot be used, and why. */
class DesignProblem extends Error {}

/** What a design's `design.json` says. */
type DesignJson = { name: string; detail: string; background: string };

interface Scan {
    at: number;
    designs: Map<string, IconDesign>;
    list: IconDesignInfo[];
}

/** Scans by built-in and data folder, kept for SCAN_TTL. */
const scans = new Map<string, Scan>();
/** Folders already told about, so a scan every second does not repeat the warning. */
const warned = new Set<string>();
/** Each file's hash, by path, as long as its size and time are those it was read at: a rescan reads only what changed. */
const hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

const scanKey = (web: string, dataDir: string) => `${web}\0${dataDir}`;

/** Tell the owner once about a folder that is not read. */
function warn(dir: string, reason: string): void {
    const key = `${dir}\0${reason}`;

    if (warned.has(key)) {
        return;
    }

    warned.add(key);
    console.warn(`Pi Pocket: the icon design folder ${dir} is not read: ${reason}.`);
}

/** `design.json`: a name, a detail, and a `#rrggbb` background. */
function parseDesignJson(text: string): DesignJson {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        throw new DesignProblem("its design.json is not JSON");
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new DesignProblem("its design.json is not an object");
    }

    const { name, detail, background } = value as Record<string, unknown>;

    if (typeof name !== "string" || name.trim() === "") {
        throw new DesignProblem('its design.json has no "name"');
    }

    if (typeof detail !== "string" || detail.trim() === "") {
        throw new DesignProblem('its design.json has no "detail"');
    }

    if (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background)) {
        throw new DesignProblem('its design.json has no "#rrggbb" background');
    }

    return { name: name.trim(), detail: detail.trim(), background };
}

/** A file's bytes' hash, read again only when its size or time says it may have changed. */
function contentHash(file: string, size: number, mtimeMs: number): string {
    const kept = hashes.get(file);

    if (kept !== undefined && kept.size === size && kept.mtimeMs === mtimeMs) {
        return kept.hash;
    }

    try {
        const hash = createHash("sha256").update(readFileSync(file)).digest("base64url");

        hashes.set(file, { size, mtimeMs, hash });

        return hash;
    } catch {
        // Gone since it was listed: a version of what was checked, which the next scan reads again.
        return `${size}:${mtimeMs}`;
    }
}

/** Read one design folder: what it serves, or why it cannot. */
function readDesign(dir: string, id: string, builtIn: boolean): IconDesign {
    const files = new Map<string, IconFile>();

    for (const name of FILES) {
        let stats;

        try {
            stats = lstatSync(join(dir, name));
        } catch {
            continue;
        }

        // A link or a folder in a file's place is not the file: a required one leaves the design unread.
        if (!stats.isFile()) {
            continue;
        }

        files.set(name, {
            file: join(dir, name),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            dev: stats.dev,
            ino: stats.ino,
        });
    }

    const missing = NEEDED.filter((name) => !files.has(name));

    if (missing.length > 0) {
        throw new DesignProblem(`it has no ${missing.join(", ")}`);
    }

    let manifest: DesignJson;

    try {
        manifest = parseDesignJson(readFileSync(files.get("design.json")!.file, "utf8"));
    } catch (error) {
        throw error instanceof DesignProblem
            ? error
            : new DesignProblem(`its design.json cannot be read: ${(error as Error).message}`);
    }

    // The version is a hash of the files' bytes: a file is read again only when its size or time changed, so a rescan
    // does not read every design again, and the same art keeps the same address.
    const hash = createHash("sha256");

    for (const name of FILES) {
        const stat = files.get(name);

        if (stat !== undefined) {
            hash.update(`${name}\0${contentHash(stat.file, stat.size, stat.mtimeMs)}\0`);
        }
    }

    const rev = hash.digest("base64url").slice(0, 12);
    const url = (name: string) => `/icons/${id}/${rev}/${name}`;
    const has = (name: string) => files.has(name);
    const tab = has("icon.svg")
        ? "icon.svg"
        : has("favicon-32.png")
          ? "favicon-32.png"
          : "icon-192.png";

    return {
        id,
        ...manifest,
        builtIn,
        rev,
        dir,
        files,
        tab: url(tab),
        touch: url("apple-touch-icon.png"),
        thumb: url(has("thumb.png") ? "thumb.png" : "apple-touch-icon.png"),
        icons: [
            { src: url("icon-192.png"), sizes: "192x192", type: "image/png" },
            { src: url("icon-512.png"), sizes: "512x512", type: "image/png" },
            {
                src: url("icon-maskable-512.png"),
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
            },
            ...(has("icon.svg")
                ? [{ src: url("icon.svg"), sizes: "any", type: "image/svg+xml" }]
                : []),
        ],
    };
}

/** Read the built-in designs, then the owner's: built-in ids are taken, and a folder that clashes is skipped. */
function scanDesigns(web: string, dataDir: string): Scan {
    const designs = new Map<string, IconDesign>();
    const listed: { id: string; design?: IconDesign }[] = [];

    for (const [root, builtIn] of [
        [join(web, "icons"), true],
        [join(dataDir, "icons"), false],
    ] as const) {
        let entries: Dirent[];

        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries
            .filter((each) => each.isDirectory() && !each.name.startsWith("."))
            .sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const dir = join(root, entry.name);
            const id = entry.name;

            if (!ICON_DESIGN_ID.test(id) || id === ORIGINAL_ICON) {
                warn(
                    dir,
                    `its folder's name is not an id: 2 to 48 lowercase words joined by dashes, and not "${ORIGINAL_ICON}"`,
                );
                continue;
            }

            if (designs.has(id)) {
                warn(
                    dir,
                    designs.get(id)!.builtIn
                        ? "its folder has the name of a design that comes with Pi Pocket"
                        : "another folder already has that id",
                );
                continue;
            }

            try {
                const design = readDesign(dir, id, builtIn);

                designs.set(id, design);
                listed.push({ id, design });
            } catch (error) {
                warn(
                    dir,
                    error instanceof DesignProblem
                        ? error.message
                        : `it cannot be read: ${(error as Error).message}`,
                );
            }
        }
    }

    return {
        at: Date.now(),
        designs,
        list: listed.map(({ design }) => ({
            id: design!.id,
            name: design!.name,
            detail: design!.detail,
            thumb: design!.thumb,
            tab: design!.tab,
            touch: design!.touch,
            background: design!.background,
        })),
    };
}

/** The scan of these folders: kept for SCAN_TTL, so requests do not read every design folder again. */
function scanFor(web: string, dataDir: string): Scan {
    const key = scanKey(web, dataDir);
    const kept = scans.get(key);

    if (kept !== undefined && Date.now() - kept.at < SCAN_TTL) {
        return kept;
    }

    const scan = scanDesigns(web, dataDir);

    scans.set(key, scan);

    return scan;
}

/** Every design, built-in ones first, then the owner's, each in folder-name order. */
export function iconDesignList(web: string, dataDir: string): IconDesignInfo[] {
    return scanFor(web, dataDir).list;
}

/** The design with `id`, or null when there is no such folder or it cannot be used. */
export function iconDesignById(web: string, dataDir: string, id: unknown): IconDesign | null {
    return typeof id === "string" ? (scanFor(web, dataDir).designs.get(id) ?? null) : null;
}

/** Whether `id` names a design that can be used now. */
export function hasIconDesign(web: string, dataDir: string, id: unknown): boolean {
    return iconDesignById(web, dataDir, id) !== null;
}

/**
 * A design's file, by its name, and whether `rev` is the version it is now (an address that will never serve anything
 * else). A file that is not one of the art files, or a design that is not there, is undefined.
 */
export function iconDesignFile(
    web: string,
    dataDir: string,
    id: string,
    rev: string | undefined,
    name: string,
): { design: IconDesign; stat: IconFile; current: boolean; type: string } | undefined {
    const design = iconDesignById(web, dataDir, id);

    if (design === null || !ICON_FILES.has(name)) {
        return undefined;
    }

    const stat = design.files.get(name);

    if (stat === undefined) {
        return undefined;
    }

    return {
        design,
        stat,
        current: rev === design.rev,
        type: name.endsWith(".svg") ? "image/svg+xml" : "image/png",
    };
}

/** Read the folders again on the next request: a test making or mending one does not wait for SCAN_TTL. */
export function refreshIconDesigns(web?: string, dataDir?: string): void {
    if (web === undefined || dataDir === undefined) {
        scans.clear();

        return;
    }

    scans.delete(scanKey(web, dataDir));
}
