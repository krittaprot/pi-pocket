/**
 * Appearance's App icon: the designs in `web/icons/<id>/`, which the page, the manifest, and a phone that adds a
 * home-screen icon all read (`src/server/icon-designs.ts`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { iconDesign } from "../src/server/icon-designs.ts";
import { WEB } from "../src/server/http/assets.ts";
import { manifestFor } from "../src/server/http/icon-route.ts";

const dataDir = mkdtempSync(join(tmpdir(), "pocket-icon-designs-"));
const request = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as never;

/** The designs `web/app-icon.js` offers, as its cards list them. */
function offered(): string[] {
    const source = readFileSync(join(WEB, "app-icon.js"), "utf8");
    const list = /export const DESIGNS = \[([\s\S]*?)\n\];/.exec(source)?.[1] ?? "";

    return [...list.matchAll(/id: "([a-z][a-z0-9-]*)"/g)].map((each) => each[1]!);
}

/** A PNG's size, read from its header (IHDR). */
function size(file: string): string {
    const bytes = readFileSync(file);

    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${file} is a PNG`);

    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test("every design Appearance offers has a folder the server reads", () => {
    const designs = offered();

    assert.ok(designs.includes("original"), "the app's own icon comes first");
    assert.ok(designs.length > 1, "and at least one design of its own");

    for (const id of designs.filter((each) => each !== "original")) {
        assert.ok(iconDesign(WEB, id), `${id} has its files in web/icons/${id}/`);
    }
});

test("a design has the tab's icon, the home screen's, and the sizes iOS and Android want", () => {
    const light = iconDesign(WEB, "light");

    assert.ok(light);
    assert.equal(light.tab, "/icons/light/icon.svg", "the SVG draws the tab's icon");
    assert.equal(light.touch, "/icons/light/apple-touch-icon.png");
    assert.deepEqual(
        light.icons.map((icon) => [icon.src, icon.sizes, icon.purpose]),
        [
            ["/icons/light/icon.svg", "any", undefined],
            ["/icons/light/icon-192.png", "192x192", undefined],
            ["/icons/light/icon-512.png", "512x512", undefined],
            ["/icons/light/icon-maskable-512.png?v=2", "512x512", "maskable"],
        ],
    );
});

test("a design without an SVG puts its 192px PNG in the tab", () => {
    assert.equal(iconDesign(WEB, "pocket-dark")?.tab, "/icons/pocket-dark/icon-192.png");
});

test("every design's files are the size they say", () => {
    for (const id of offered().filter((each) => each !== "original")) {
        const folder = join(WEB, "icons", id);

        assert.equal(size(join(folder, "icon-192.png")), "192x192", id);
        assert.equal(size(join(folder, "icon-512.png")), "512x512", id);
        assert.equal(size(join(folder, "icon-maskable-512.png")), "512x512", id);
        assert.equal(size(join(folder, "apple-touch-icon.png")), "180x180", id);
        assert.equal(size(join(folder, "thumb.png")), "128x128", id);
    }
});

test("what is not a design is the app's own icon", () => {
    for (const id of ["original", "../web", "nope", "Light", "", "icon/../light", null, 42]) {
        assert.equal(iconDesign(WEB, id), null, `${String(id)} is not a design`);
    }
});

test("the manifest lists the design's files when the cookie names one", () => {
    const file = readFileSync(join(WEB, "manifest.webmanifest"), "utf8");
    const made = JSON.parse(
        manifestFor(
            request("pocket_icon_design=icon-dark; pocket_icon=111.222.333.444.555"),
            file,
            dataDir,
        )!,
    );

    assert.deepEqual(
        made.icons.map((icon: { src: string }) => icon.src),
        [
            "/icons/icon-dark/icon.svg",
            "/icons/icon-dark/icon-192.png",
            "/icons/icon-dark/icon-512.png",
            "/icons/icon-dark/icon-maskable-512.png?v=2",
        ],
        "the design wins over the colors",
    );
    assert.equal(made.theme_color, "#13141c", "the rest of the manifest stays");
});

test("a design whose folder is gone falls back to the colors", () => {
    const file = readFileSync(join(WEB, "manifest.webmanifest"), "utf8");
    const made = JSON.parse(
        manifestFor(
            request("pocket_icon_design=gone; pocket_icon=111.222.333.444.555"),
            file,
            dataDir,
        )!,
    );

    assert.match(made.icons[0].src, /^\/app-icon\.png\?/, "the colors' icons");
});

test("the owner's design serves a request with no cookie, and the cookie still wins", async () => {
    const { storeIcon, storedIcon } = await import("../src/server/icon-store.ts");
    const { iconAddress, tabAddress } = await import("../src/server/http/icon-route.ts");

    storeIcon(dataDir, "070707.000.b0b0b0.b6b6b6.b9b9b9", "light");

    assert.equal(storedIcon(dataDir).design, "light");
    assert.equal(iconAddress(request(), dataDir), "/icons/light/apple-touch-icon.png");
    assert.equal(tabAddress(request(), dataDir), "/icons/light/icon.svg");
    assert.equal(
        iconAddress(request("pocket_icon_design=pocket-light"), dataDir),
        "/icons/pocket-light/apple-touch-icon.png",
        "a cookie wins",
    );
    assert.equal(
        tabAddress(request("pocket_icon_design=original"), dataDir),
        null,
        "the app's own icon is the page's own",
    );
});
