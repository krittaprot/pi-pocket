// The icon surfaces over HTTP: the designs the API lists, the owner's choice, and the page, manifest, and home-screen
// icon that follow it (`src/server/http/icon-route.ts`).
import { type App, cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { refreshIconDesigns } from "../src/server/icon-designs.ts";
import { storedIcon } from "../src/server/icon-store.ts";
import { WEB } from "../src/server/http/assets.ts";
import { createHandler } from "../src/server/http.ts";

const COLORS = "070707.000.b0b0b0.b6b6b6.b9b9b9";
let app: App;
let server: Server;
let base: string;

const api = (path: string, init: RequestInit = {}) =>
    fetch(new URL(`/api/${path}`, base), {
        ...init,
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
            ...init.headers,
        },
    });

const put = (body: unknown) => api("app-icon", { method: "PUT", body: JSON.stringify(body) });

const page = (cookie?: string) =>
    fetch(new URL("/", base), { headers: cookie === undefined ? {} : { cookie } });

before(async () => {
    app = await openApp(scriptedModel(), join(root, "icon-routes"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("GET /api/icon-designs needs a sign-in and lists the folders", async () => {
    assert.equal((await fetch(new URL("/api/icon-designs", base))).status, 401);

    const response = await api("icon-designs");
    const list = (await response.json()) as { id: string; thumb: string }[];

    assert.equal(response.status, 200);
    assert.deepEqual(
        list.map((design) => design.id),
        ["icon-dark", "icon-light", "light", "pocket-dark", "pocket-light"],
    );
    assert.match(list[0]!.thumb, /^\/icons\/icon-dark\/[^/]+\/thumb\.png$/);
});

test("PUT keeps the design it is not given, refuses one that does not exist, and clears on original", async () => {
    assert.equal((await put({ colors: COLORS, design: "icon-dark" })).status, 200);
    assert.equal(storedIcon(app.dataDir).design, "icon-dark");

    // The page reports the colors alone when only they changed: the design stays.
    assert.equal((await put({ colors: COLORS })).status, 200);
    assert.equal(
        storedIcon(app.dataDir).design,
        "icon-dark",
        "an omitted design keeps the stored one",
    );

    const unknown = await put({ colors: COLORS, design: "not-a-design" });

    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: string }).error, /No such icon design/);
    assert.equal(storedIcon(app.dataDir).design, "icon-dark", "a refused design changes nothing");

    assert.equal((await put({ colors: COLORS, design: "original" })).status, 200);
    assert.equal(storedIcon(app.dataDir).design, null, "original clears it");
});

test("a design's files are served at its version, with the plain address for the app's own", async () => {
    const list = (await (await api("icon-designs")).json()) as { id: string; touch: string }[];
    const dark = list.find((design) => design.id === "icon-dark")!;
    const served = await fetch(new URL(dark.touch, base));

    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(
        Buffer.from(await served.arrayBuffer()),
        readFileSync(join(WEB, "icons", "icon-dark", "apple-touch-icon.png")),
        "the folder's own bytes",
    );

    const plain = await fetch(new URL("/icons/light/icon.svg", base));

    assert.equal(plain.status, 200, "the plain address still works for the app's designs");
    assert.equal(plain.headers.get("content-type"), "image/svg+xml");

    for (const path of [
        "/icons/light%2F%2E%2E%2F%2E%2E%2Findex.html",
        "/icons/light/rev/extra/icon.svg",
        "/icons/light/not-a-file.png",
        "/icons/light/design.json",
        "/icons/nope/icon-192.png",
    ]) {
        assert.equal((await fetch(new URL(path, base))).status, 404, path);
    }
});

test("the owner's design in the data folder is served, and the page carries it", async () => {
    const target = join(app.dataDir, "icons", "mine");

    mkdirSync(join(app.dataDir, "icons"), { recursive: true });
    cpSync(join(WEB, "icons", "light"), target, { recursive: true });
    writeFileSync(
        join(target, "design.json"),
        `${JSON.stringify({ name: "Mine", detail: "My tile", background: "#123456" })}\n`,
    );
    refreshIconDesigns(WEB, app.dataDir);

    assert.equal((await put({ colors: COLORS, design: "mine" })).status, 200);

    const listed = (await (await api("icon-designs")).json()) as {
        id: string;
        touch: string;
    }[];
    const mine = listed.find((design) => design.id === "mine")!;

    assert.ok(mine, "the owner's design is listed");
    assert.equal((await fetch(new URL(mine.touch, base))).status, 200);
    assert.equal(
        (await fetch(new URL("/icons/mine/icon-192.png", base))).status,
        404,
        "a data folder's design has only its versioned address",
    );

    const html = await (await page("pocket_icon_design=mine")).text();

    assert.match(html, /<link rel="icon" href="\/icons\/mine\/[^/]+\/icon\.svg"/);
    assert.match(
        html,
        /<link rel="apple-touch-icon" href="\/icons\/mine\/[^/]+\/apple-touch-icon\.png"/,
    );
});

test("the home screen's icon is the design's bytes, and the cookie's original is the colors' own", async () => {
    assert.equal((await put({ colors: COLORS, design: "icon-dark" })).status, 200);

    const design = await fetch(new URL("/apple-touch-icon.png", base));
    const designBytes = readFileSync(join(WEB, "icons", "icon-dark", "apple-touch-icon.png"));

    assert.equal(design.status, 200);
    assert.deepEqual(Buffer.from(await design.arrayBuffer()), designBytes);

    const original = await fetch(new URL("/apple-touch-icon.png", base), {
        headers: { cookie: `pocket_icon_design=original; pocket_icon=${COLORS}` },
    });
    const drawn = Buffer.from(await original.arrayBuffer());

    assert.equal(original.status, 200);
    assert.notDeepEqual(drawn, designBytes, "original does not take the owner's stored design");
    assert.equal(drawn.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(drawn.readUInt32BE(16), 180, "the colors' 180px icon");
});

test("the manifest follows the stored design, and the colors under a cookie's original", async () => {
    assert.equal((await put({ colors: COLORS, design: "icon-dark" })).status, 200);

    const design = JSON.parse(
        await (await fetch(new URL("/manifest.webmanifest", base))).text(),
    ) as {
        background_color: string;
        theme_color: string;
        icons: { src: string; sizes: string; purpose?: string }[];
    };

    assert.equal(design.background_color, "#151719");
    assert.equal(design.theme_color, "#151719");
    assert.deepEqual(
        design.icons.map((icon) => [
            icon.src.replace(/^\/icons\/icon-dark\/[^/]+\//, ""),
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

    const colors = JSON.parse(
        await (
            await fetch(new URL("/manifest.webmanifest", base), {
                headers: {
                    cookie: `pocket_icon_design=original; pocket_icon=${COLORS}`,
                },
            })
        ).text(),
    ) as { background_color: string; icons: { src: string; sizes: string; purpose?: string }[] };

    assert.equal(colors.background_color, "#070707");
    assert.deepEqual(
        colors.icons.map((icon) => [icon.sizes, icon.purpose]),
        [
            ["192x192", undefined],
            ["512x512", undefined],
            ["512x512", "maskable"],
        ],
    );
    assert.match(colors.icons[0]!.src, /^\/app-icon\.png\?/);
});
