import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

type Image = { width: number; height: number; colour: number; channels: number; pixels: Buffer };

const WEB = join(import.meta.dirname, "..", "web");
const ICONS = join(WEB, "icons");

/** The files each design folder keeps, and their sides. */
const SIZES: readonly (readonly [string, number])[] = [
    ["icon-1024.png", 1024],
    ["icon-512.png", 512],
    ["icon-192.png", 192],
    ["apple-touch-icon.png", 180],
    ["thumb.png", 128],
    ["favicon-32.png", 32],
];

const FOLDERS = readdirSync(ICONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/** An 8-bit RGB or RGBA, non-interlaced PNG, unfiltered into its pixels. */
function decode(png: Buffer): Image {
    assert.deepEqual(
        [...png.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "a PNG",
    );

    let at = 8;
    let width = 0;
    let height = 0;
    let colour = 0;
    const data: Buffer[] = [];

    while (at < png.length) {
        const length = png.readUInt32BE(at);
        const type = png.toString("latin1", at + 4, at + 8);

        if (type === "IHDR") {
            width = png.readUInt32BE(at + 8);
            height = png.readUInt32BE(at + 12);
            assert.equal(png[at + 16], 8, "8 bits");
            colour = png[at + 17]!;
            assert.ok(colour === 2 || colour === 6, `colour type 2 or 6, not ${colour}`);
            assert.equal(png[at + 20], 0, "not interlaced");
        }

        if (type === "IDAT") {
            data.push(png.subarray(at + 8, at + 8 + length));
        }

        at += 12 + length;
    }

    const channels = colour === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(data));
    const stride = width * channels;
    const pixels = Buffer.alloc(height * stride);

    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;

        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x]!;
            const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
            const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
            const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
            let add = 0;

            if (filter === 1) {
                add = left;
            } else if (filter === 2) {
                add = up;
            } else if (filter === 3) {
                add = (left + up) >> 1;
            } else if (filter === 4) {
                const p = left + up - upLeft;
                const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];

                add = a <= b && a <= c ? left : b <= c ? up : upLeft;
            }

            pixels[y * stride + x] = (value + add) & 255;
        }
    }

    return { width, height, colour, channels, pixels };
}

function read(path: string): Image {
    return decode(readFileSync(path));
}

/** The pixel at (x, y), as [r, g, b, a?]. */
function pixel(image: Image, x: number, y: number): number[] {
    const start = (y * image.width + x) * image.channels;

    return [...image.pixels.subarray(start, start + image.channels)];
}

/** Asserts that a PNG with an alpha channel is still see-through nowhere; one without alpha cannot be. */
function assertOpaque(image: Image, where: string): void {
    if (image.colour === 6) {
        for (let i = 3; i < image.pixels.length; i += 4) {
            assert.equal(image.pixels[i], 255, `${where} is opaque at pixel ${(i - 3) / 4}`);
        }
    }
}

test("every design keeps an opaque square at each size, with its corners intact", () => {
    for (const folder of FOLDERS) {
        for (const [name, size] of SIZES) {
            const where = `${folder}/${name}`;
            const image = read(join(ICONS, folder, name));

            assert.equal(image.width, size, `${where} is ${size} pixels wide`);
            assert.equal(image.height, size, `${where} is ${size} pixels tall`);
            assert.equal(image.colour, 2, `${where} is RGB, with no alpha channel`);

            const inset = Math.max(1, Math.round(size * 0.04));
            const corners: readonly (readonly [number, number])[] = [
                [0, 0],
                [size - 1, 0],
                [0, size - 1],
                [size - 1, size - 1],
            ];

            for (const [x, y] of corners) {
                const corner = pixel(image, x, y);
                const inside = pixel(
                    image,
                    x === 0 ? inset : size - 1 - inset,
                    y === 0 ? inset : size - 1 - inset,
                );

                for (let i = 0; i < 3; i++) {
                    assert.ok(
                        Math.abs(corner[i]! - inside[i]!) <= 24,
                        `${where} has no rounded corner at (${x}, ${y})`,
                    );
                }
            }
        }
    }
});

test("every design's maskable icon is 512 pixels and fully opaque", () => {
    for (const folder of FOLDERS) {
        const where = `${folder}/icon-maskable-512.png`;
        const image = read(join(ICONS, folder, "icon-maskable-512.png"));

        assert.equal(image.width, 512, `${where} is 512 pixels wide`);
        assert.equal(image.height, 512, `${where} is 512 pixels tall`);

        if (image.colour === 6) {
            for (let i = 3; i < image.pixels.length; i += 4) {
                assert.equal(image.pixels[i], 255, `${where} is opaque at pixel ${(i - 3) / 4}`);
            }
        }
    }
});

test("the notification badge is a white π on a transparent tile", () => {
    const image = read(join(WEB, "badge-96.png"));

    assert.equal(image.width, 96, "96 pixels wide");
    assert.equal(image.height, 96, "96 pixels tall");
    assert.equal(image.colour, 6, "RGBA");

    for (const [x, y] of [
        [0, 0],
        [95, 0],
        [0, 95],
        [95, 95],
    ] as const) {
        assert.equal(pixel(image, x, y)[3], 0, `the corner at (${x}, ${y}) is transparent`);
    }

    let opaque = 0;

    for (let i = 0; i < image.pixels.length; i += 4) {
        const alpha = image.pixels[i + 3]!;

        if (alpha > 0) {
            opaque++;
            assert.deepEqual(
                [...image.pixels.subarray(i, i + 3)],
                [255, 255, 255],
                `pixel ${i / 4} of the π is white`,
            );
        }
    }

    assert.ok(opaque > 0, "the π is drawn");
});

test("the icons a phone and a browser fetch from web/ are opaque", () => {
    for (const name of ["apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
        assertOpaque(read(join(WEB, name)), name);
    }
});
