/**
 * The app's icon files, made from each design's 1024-pixel master: the sizes a home screen, a Dock, a browser tab and
 * the app's icon sheet ask for, plus the white π on a transparent tile that a notification badge shows. Every file is a
 * full-bleed opaque square, because iOS and macOS round an icon themselves. Run `npm run icons`; the same masters give
 * the same bytes.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { PI_MASK } from "../src/server/icon-mask.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const ICONS = join(WEB, "icons");

/** The files each design folder keeps, and their sides. */
const SIZES: readonly (readonly [string, number])[] = [
    ["icon-512.png", 512],
    ["icon-192.png", 192],
    ["apple-touch-icon.png", 180],
    ["thumb.png", 128],
    ["favicon-32.png", 32],
];

/** The badge's side, and the share of it the π fills. */
const BADGE = 96;
const FILL = 0.8;

const mask = inflateSync(Buffer.from(PI_MASK.deflated, "base64"));

/** Coverage (0 to 1) of the π at a point of its 272 × 270 mask, and 0 outside it. */
function coverage(x: number, y: number): number {
    const at = (cx: number, cy: number) =>
        cx < 0 || cy < 0 || cx >= PI_MASK.width || cy >= PI_MASK.height
            ? 0
            : mask[cy * PI_MASK.width + cx]!;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;

    return (top * (1 - ty) + bottom * ty) / 255;
}

/** The π in white on a transparent 96 × 96 square, for the badge a notification shows. */
async function badge(): Promise<Buffer> {
    const side = BADGE * FILL;
    const scale = side / Math.max(PI_MASK.width, PI_MASK.height);
    const left = (BADGE - PI_MASK.width * scale) / 2;
    const top = (BADGE - PI_MASK.height * scale) / 2;
    const steps = 4;
    const pixels = Buffer.alloc(BADGE * BADGE * 4);

    for (let py = 0; py < BADGE; py++) {
        for (let px = 0; px < BADGE; px++) {
            let sum = 0;

            for (let sy = 0; sy < steps; sy++) {
                for (let sx = 0; sx < steps; sx++) {
                    const x = (px + (sx + 0.5) / steps - left) / scale;
                    const y = (py + (sy + 0.5) / steps - top) / scale;

                    sum += coverage(x - 0.5, y - 0.5);
                }
            }

            const at = (py * BADGE + px) * 4;

            pixels[at] = 255;
            pixels[at + 1] = 255;
            pixels[at + 2] = 255;
            pixels[at + 3] = Math.round((sum / (steps * steps)) * 255);
        }
    }

    return sharp(pixels, { raw: { width: BADGE, height: BADGE, channels: 4 } })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
}

/** Writes one file and says what it is. */
function save(path: string, png: Buffer, size: number): void {
    writeFileSync(path, png);
    console.log(
        `${relative(ROOT, path).replaceAll("\\", "/")}: ${size}x${size}, ${png.length} bytes`,
    );
}

const folders = readdirSync(ICONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => existsSync(join(ICONS, name, "icon-1024.png")));

for (const folder of folders) {
    const master = join(ICONS, folder, "icon-1024.png");

    for (const [name, size] of SIZES) {
        const png = await sharp(master)
            .resize(size, size, { kernel: "lanczos3" })
            .flatten({ background: "#000000" })
            .removeAlpha()
            .png({ compressionLevel: 9, adaptiveFiltering: true })
            .toBuffer();

        save(join(ICONS, folder, name), png, size);
    }
}

save(join(WEB, "badge-96.png"), await badge(), BADGE);
