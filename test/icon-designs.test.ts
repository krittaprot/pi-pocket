/**
 * Appearance's App icon: the design folders in `web/icons/<id>/` and in the data folder's `icons/<id>/`, which the
 * page, the manifest, and a phone that adds a home-screen icon all read (`src/server/icon-designs.ts`).
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
    iconDesignById,
    iconDesignFile,
    iconDesignList,
    refreshIconDesigns,
} from "../src/server/icon-designs.ts";
import { WEB } from "../src/server/http/assets.ts";
import { iconAddress, iconChoice, manifestFor } from "../src/server/http/icon-route.ts";
import { storeIcon } from "../src/server/icon-store.ts";

const COLORS = "070707.000.b0b0b0.b6b6b6.b9b9b9";
const request = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as never;

/** A data folder of this test's own, and its `icons/` folder. */
function dataFolder(): string {
    const dataDir = mkdtempSync(join(tmpdir(), "pocket-icon-designs-"));

    refreshIconDesigns(WEB, dataDir);

    return dataDir;
}

/** A copy of the built-in design `from` as the owner's design `to` in `dataDir`. */
function copyDesign(dataDir: string, from: string, to: string): string {
    const target = join(dataDir, "icons", to);

    cpSync(join(WEB, "icons", from), target, { recursive: true });

    return target;
}

/** A design's address without its version: what it serves, by name. */
const plain = (src: string) => src.replace(/^\/icons\/[^/]+\/[^/]+\//, "");

test("the designs that come with the app are the folders in web/icons, in folder-name order", () => {
    const dataDir = dataFolder();
    const list = iconDesignList(WEB, dataDir);

    assert.deepEqual(
        list.map((design) => design.id),
        ["icon-dark", "icon-light", "light", "pocket-dark", "pocket-light"],
    );

    const light = iconDesignById(WEB, dataDir, "light");

    assert.ok(light);
    assert.equal(light.name, "Light");
    assert.equal(light.detail, "A white tile with the π in ink");
    assert.equal(light.background, "#f8f8fa");
    assert.equal(light.builtIn, true);
    assert.match(light.rev, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(plain(light.tab), "icon.svg", "the SVG draws the tab's icon");
    assert.equal(plain(light.touch), "apple-touch-icon.png");
    assert.equal(plain(light.thumb), "thumb.png");
    assert.deepEqual(
        light.icons.map((icon) => [plain(icon.src), icon.sizes, icon.purpose]),
        [
            ["icon-192.png", "192x192", undefined],
            ["icon-512.png", "512x512", undefined],
            ["icon-maskable-512.png", "512x512", "maskable"],
            ["icon.svg", "any", undefined],
        ],
        "the 192px PNG comes first, for the service worker's notifications",
    );
});

test("a design without an SVG puts its 32px favicon in the tab, then its 192px PNG", () => {
    const dataDir = dataFolder();
    const pocket = iconDesignById(WEB, dataDir, "pocket-dark");

    assert.ok(pocket);
    assert.equal(plain(pocket.tab), "favicon-32.png");

    // The owner's own folder can drop both: the tab takes the 192px PNG then.
    const folder = copyDesign(dataDir, "pocket-dark", "no-tab");

    rmSync(join(folder, "favicon-32.png"));
    refreshIconDesigns(WEB, dataDir);

    assert.equal(plain(iconDesignById(WEB, dataDir, "no-tab")!.tab), "icon-192.png");
});

test("the cards the API lists come from the folders: the owner's after the app's, each with its art", () => {
    const dataDir = dataFolder();

    copyDesign(dataDir, "light", "mine");
    writeFileSync(
        join(dataDir, "icons", "mine", "design.json"),
        `${JSON.stringify({ name: "Mine", detail: "My own tile", background: "#123456" })}\n`,
    );
    refreshIconDesigns(WEB, dataDir);

    const list = iconDesignList(WEB, dataDir);

    assert.deepEqual(
        list.map((design) => design.id),
        ["icon-dark", "icon-light", "light", "pocket-dark", "pocket-light", "mine"],
        "the owner's come after the app's",
    );

    const mine = list.at(-1)!;

    assert.deepEqual(
        {
            id: mine.id,
            name: mine.name,
            detail: mine.detail,
            background: mine.background,
        },
        { id: "mine", name: "Mine", detail: "My own tile", background: "#123456" },
    );
    assert.match(mine.thumb, /^\/icons\/mine\/[^/]+\/thumb\.png$/);
});

test("a folder whose id the app has is skipped, and warned about", () => {
    const dataDir = dataFolder();

    copyDesign(dataDir, "pocket-light", "light");
    refreshIconDesigns(WEB, dataDir);

    const warnings: unknown[][] = [];
    const original = console.warn;

    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
        const list = iconDesignList(WEB, dataDir);
        const light = iconDesignById(WEB, dataDir, "light");

        assert.equal(light?.builtIn, true, "the app's own Light still wins");
        assert.equal(light?.name, "Light");
        assert.equal(
            list.filter((design) => design.id === "light").length,
            1,
            "the clashing folder is not listed twice",
        );
        assert.ok(
            warnings.some((args) => String(args[0]).includes("comes with Pi Pocket")),
            "the owner is told why it was skipped",
        );
    } finally {
        console.warn = original;
    }
});

test("a folder missing a file every design has, or with a bad design.json, is not offered", () => {
    const dataDir = dataFolder();

    rmSync(join(copyDesign(dataDir, "light", "no-apple"), "apple-touch-icon.png"));
    writeFileSync(
        join(copyDesign(dataDir, "light", "no-colour"), "design.json"),
        `${JSON.stringify({ name: "Flat", detail: "No background" })}\n`,
    );
    writeFileSync(join(copyDesign(dataDir, "light", "bad-json"), "design.json"), "{");
    refreshIconDesigns(WEB, dataDir);

    const ids = iconDesignList(WEB, dataDir).map((design) => design.id);

    for (const id of ["no-apple", "no-colour", "bad-json"]) {
        assert.ok(!ids.includes(id), `${id} is not offered`);
        assert.equal(iconDesignById(WEB, dataDir, id), null, `${id} has no design`);
    }
});

test("a design's files are served at its version, and only the art files are", () => {
    const dataDir = dataFolder();
    const light = iconDesignById(WEB, dataDir, "light");

    assert.ok(light);

    const served = iconDesignFile(WEB, dataDir, "light", light.rev, "icon-192.png");

    assert.ok(served);
    assert.equal(served.current, true, "the address is the version the files are now");
    assert.equal(served.type, "image/png");
    assert.equal(basename(served.stat.file), "icon-192.png");
    assert.equal(
        iconDesignFile(WEB, dataDir, "light", "not-this-rev", "icon-192.png")?.current,
        false,
        "an older address serves the files as they are now",
    );
    assert.equal(
        iconDesignFile(WEB, dataDir, "light", light.rev, "icon.svg")?.type,
        "image/svg+xml",
    );

    for (const name of [
        "../icon.svg",
        "design.json",
        "not-a-file.png",
        "icon-192.png/../../index.html",
        "",
    ]) {
        assert.equal(
            iconDesignFile(WEB, dataDir, "light", light.rev, name),
            undefined,
            `${name} is not a file of a design to serve`,
        );
    }

    for (const id of ["../web", "light/../light", "", "nope"]) {
        assert.equal(
            iconDesignFile(WEB, dataDir, id, light.rev, "icon-192.png"),
            undefined,
            `${id} is not a design`,
        );
    }
});

test("a changed file changes the version in every address", () => {
    const dataDir = dataFolder();
    const folder = copyDesign(dataDir, "light", "mine");
    const before = iconDesignById(WEB, dataDir, "mine");

    writeFileSync(
        join(folder, "design.json"),
        `${JSON.stringify({ name: "Mine", detail: "Changed", background: "#f8f8fa" })}\n`,
    );
    refreshIconDesigns(WEB, dataDir);

    const after = iconDesignById(WEB, dataDir, "mine");

    assert.ok(before && after);
    assert.notEqual(after.rev, before.rev);
    assert.match(after.touch, new RegExp(`^/icons/mine/${after.rev}/`));
    assert.equal(
        iconDesignFile(WEB, dataDir, "mine", before.rev, "icon-192.png")?.current,
        false,
        "the old address is not called immutable",
    );
});

test("a design whose folder is gone falls back to the colors", () => {
    const dataDir = dataFolder();
    const file = readFileSync(join(WEB, "manifest.webmanifest"), "utf8");

    const gone = JSON.parse(
        manifestFor(
            file,
            iconChoice(request("pocket_icon_design=gone; pocket_icon=" + COLORS), dataDir),
        )!,
    );

    assert.match(gone.icons[0].src, /^\/app-icon\.png\?/, "the colors' icons");
});

test("the cookie's original is a choice of its own: the owner's stored design does not win", () => {
    const dataDir = dataFolder();

    copyDesign(dataDir, "light", "mine");
    refreshIconDesigns(WEB, dataDir);
    storeIcon(dataDir, COLORS, "mine");

    assert.equal(
        plain(iconChoice(request(), dataDir).design!.touch),
        "apple-touch-icon.png",
        "no cookie: the owner's design",
    );
    assert.equal(
        plain(iconChoice(request("pocket_icon_design=mine"), dataDir).design!.touch),
        "apple-touch-icon.png",
        "a cookie naming a design wins",
    );

    const original = iconChoice(request("pocket_icon_design=original"), dataDir);

    assert.equal(original.design, null, "original does not fall back to the stored design");
    assert.equal(
        iconAddress(original),
        "/app-icon.png?frame=070707&card=000&ring1=b0b0b0&ring2=b6b6b6&pi=b9b9b9&size=180",
        "the colors' own icon, as before",
    );
    assert.equal(
        iconChoice(request("pocket_icon_design=original; pocket_icon=" + COLORS), dataDir).design,
        null,
        "the colors still apply",
    );
});

test("the manifest lists the design's files in order, on the design's background", () => {
    const dataDir = dataFolder();
    const design = iconDesignById(WEB, dataDir, "icon-dark")!;
    const made = JSON.parse(
        manifestFor(
            readFileSync(join(WEB, "manifest.webmanifest"), "utf8"),
            iconChoice(request(`pocket_icon_design=icon-dark; pocket_icon=${COLORS}`), dataDir),
        )!,
    );

    assert.equal(made.name, "Pi Pocket", "the rest of the manifest stays");
    assert.equal(made.background_color, design.background);
    assert.equal(made.theme_color, design.background);
    assert.deepEqual(
        made.icons.map((icon: { src: string; sizes: string; purpose?: string }) => [
            plain(icon.src),
            icon.sizes,
            icon.purpose,
        ]),
        [
            ["icon-192.png", "192x192", undefined],
            ["icon-512.png", "512x512", undefined],
            ["icon-maskable-512.png", "512x512", "maskable"],
            ["icon.svg", "any", undefined],
        ],
    );
});

test("the colors' manifest lists 192, 512, and a 512 maskable icon", () => {
    const dataDir = dataFolder();
    const made = JSON.parse(
        manifestFor(
            readFileSync(join(WEB, "manifest.webmanifest"), "utf8"),
            iconChoice(request(`pocket_icon=${COLORS}`), dataDir),
        )!,
    );

    assert.deepEqual(
        made.icons.map((icon: { sizes: string; purpose?: string }) => [icon.sizes, icon.purpose]),
        [
            ["192x192", undefined],
            ["512x512", undefined],
            ["512x512", "maskable"],
        ],
    );
    assert.equal(made.background_color, "#070707");
    assert.equal(made.theme_color, "#070707");
});

test("the page's icon links are rewritten by rel, and a $ in an address is literal", async () => {
    const { serveApp } = await import("../src/server/http/assets.ts");
    let body = "";
    const response = {
        req: { headers: {} },
        writeHead() {},
        end: (text: string) => {
            body = text;
        },
    };

    serveApp(response as never, "/icons/a/$&/apple-touch-icon.png", "/icons/a/$&/icon.svg");

    assert.match(
        body,
        /<link rel="apple-touch-icon" href="\/icons\/a\/\$&\/apple-touch-icon\.png" \/>/,
        "the replacer function writes the address as it is",
    );
    assert.match(
        body,
        /<link rel="icon" href="\/icons\/a\/\$&\/icon\.svg" type="image\/svg\+xml" \/>/,
    );
    assert.doesNotMatch(body, /href="\/apple-touch-icon\.png"/, "the default link is gone");
    assert.doesNotMatch(
        body,
        /href="\/icon\.svg" type="image\/svg\+xml"/,
        "the default tab link is gone",
    );
});

test("what is not a design id is not a design", () => {
    const dataDir = dataFolder();

    for (const id of [
        "original",
        "../web",
        "nope",
        "Light",
        "",
        "icon/../light",
        "icon-dark/",
        null,
        42,
    ]) {
        assert.equal(iconDesignById(WEB, dataDir, id), null, `${String(id)} is not a design`);
    }
});
