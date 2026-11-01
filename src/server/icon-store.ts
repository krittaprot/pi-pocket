/**
 * The owner's app icon: the colors it is drawn in (`frame.card.ring1.ring2.pi`, hex) and the design they picked
 * (`icon-designs.ts`), kept in the data folder. A phone fetches the page and the icon from a session of its own that has
 * no cookies, so the cookie of the browser (`http/icon-route.ts`) is not enough there: this is what such a request gets.
 * It is one choice for the whole server: the last device of the owner that changes the icon sets it, and a browser with
 * no cookie (a guest's too) gets it. A browser with a cookie gets its own.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIconDesignId } from "./icon-designs.ts";

const HEX = "(?:[0-9a-f]{3}|[0-9a-f]{6})";

/** `frame.card.ring1.ring2.pi`, five hex colors, else false. */
export const isIconColors = (value: unknown): value is string =>
    typeof value === "string" && new RegExp(`^${HEX}(?:\\.${HEX}){4}$`, "i").test(value);

export type StoredIcon = {
    /** The colors `icon-render.ts` draws the app's own icon in, or null for the app's own. */
    colors: string[] | null;
    /** The design's id (`web/icons/<id>/`), or null for the app's own icon. */
    design: string | null;
};

const NONE: StoredIcon = { colors: null, design: null };

const file = (dataDir: string) => join(dataDir, "app-icon.json");

/** The icon as read from `file()` once; the page, the manifest, and the icon ask for it on every request. */
let kept: { path: string; icon: StoredIcon } | undefined;

export function storedIcon(dataDir: string): StoredIcon {
    const path = file(dataDir);

    if (kept?.path === path) {
        return kept.icon;
    }

    let icon = NONE;

    if (existsSync(path)) {
        try {
            const stored = JSON.parse(readFileSync(path, "utf8")) as {
                colors?: unknown;
                design?: unknown;
            };

            icon = {
                colors: isIconColors(stored.colors) ? stored.colors.split(".") : null,
                design: isIconDesignId(stored.design) ? stored.design : null,
            };
        } catch (error) {
            console.warn(
                "Pi Pocket: app-icon.json could not be read; the app's own icon is used.",
                error,
            );
        }
    }

    kept = { path, icon };

    return icon;
}

/** Keep the owner's icon: the colors it is drawn in, and the design, or null for the app's own icon. */
export function storeIcon(dataDir: string, colors: unknown, design: unknown): void {
    if (!isIconColors(colors)) {
        throw new TypeError("Colors are five hex colors joined by dots");
    }

    if (design !== null && !isIconDesignId(design)) {
        throw new TypeError("A design is a folder name, or null for the app's own icon");
    }

    const icon: StoredIcon = { colors: colors.split("."), design: design as string | null };
    const kept_ = storedIcon(dataDir);

    if (kept_.colors?.join(".") !== colors || kept_.design !== icon.design) {
        writeFileSync(file(dataDir), `${JSON.stringify({ colors, design: icon.design })}\n`);
        kept = { path: file(dataDir), icon };
    }
}
