/**
 * The app icon designs a person can choose in Appearance: each is a folder in `web/icons/<id>/` with the same files as the
 * app's own icon in `web/`. `original`, the app's icon drawn in the colors in use (`icon-render.ts`), has no folder.
 *
 * The files are read by the page (`web/app-icon.js`), by the manifest, and by a phone that adds a home-screen icon
 * (`http/icon-route.ts`), so a design is checked here once, in one place.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** A design's id: a folder name of lowercase words joined by dashes, as `icon-dark` is. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The files every design has: `original` has none of them, `icon.svg` and a 1024px master are optional. */
const NEEDED = [
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "apple-touch-icon.png",
    "thumb.png",
] as const;

export type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string };

export type IconDesign = {
    id: string;
    /** The browser tab's icon: the SVG when the design has one, else its 192px PNG. */
    tab: string;
    /** What iOS and Android keep on the home screen: `apple-touch-icon`. */
    touch: string;
    /** What `/manifest.webmanifest` lists, in the order a browser wants them. */
    icons: ManifestIcon[];
};

/** The design `id` in `web`: null when it is not an id, has no folder, or lacks a file every design has. */
export function iconDesign(web: string, id: unknown): IconDesign | null {
    if (typeof id !== "string" || id === "original" || !ID.test(id)) {
        return null;
    }

    const dir = join(web, "icons", id);

    if (!NEEDED.every((file) => existsSync(join(dir, file)))) {
        return null;
    }

    const svg = existsSync(join(dir, "icon.svg"));
    const url = (file: string) => `/icons/${id}/${file}`;

    return {
        id,
        tab: url(svg ? "icon.svg" : "icon-192.png"),
        touch: url("apple-touch-icon.png"),
        icons: [
            ...(svg ? [{ src: url("icon.svg"), sizes: "any", type: "image/svg+xml" }] : []),
            { src: url("icon-192.png"), sizes: "192x192", type: "image/png" },
            { src: url("icon-512.png"), sizes: "512x512", type: "image/png" },
            {
                // The version makes a browser fetch it again: the art filled the whole square from version 2.
                src: `${url("icon-maskable-512.png")}?v=2`,
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
            },
        ],
    };
}

/** Whether `value` could name a design, without reading a folder: what the API takes from a browser. */
export const isIconDesignId = (value: unknown): value is string =>
    typeof value === "string" && ID.test(value);
