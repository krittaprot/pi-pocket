// The picture iOS shows while the app starts (`web/startup-image.js`): drawn once per look, in device pixels.
import assert from "node:assert/strict";
import { test } from "node:test";

type Size = { width: number; height: number };
type Startup = {
    startupSize(): Size;
    applyStartupImage(color: string): string | null;
};

type FakeCanvas = {
    width: number;
    height: number;
    fills: string[];
    fillStyle: string;
    getContext(kind: string): { fillStyle: string; fillRect: () => void } | null;
    toDataURL(type: string): string;
};

type FakeLink = {
    rel: string;
    href: string;
    media?: string;
    removeAttribute(name: string): void;
};

type FakePage = {
    canvases: FakeCanvas[];
    links: FakeLink[];
    document: {
        head: { append(link: FakeLink): void };
        createElement(tag: string): FakeCanvas | FakeLink;
        querySelector(selector: string): FakeLink | null;
    };
};

const STARTUP: string = "../web/startup-image.js";
const startup = (await import(STARTUP)) as Startup;
const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, PropertyDescriptor | undefined>();

/** A page with a canvas factory and a head: enough of one for the module, and no browser. */
function fakePage(): FakePage {
    const page: FakePage = {
        canvases: [],
        links: [],
        document: {
            head: {
                append: (link) => {
                    page.links.push(link);
                },
            },
            createElement: (tag) => {
                if (tag === "canvas") {
                    const canvas: FakeCanvas = {
                        width: 0,
                        height: 0,
                        fills: [],
                        fillStyle: "",
                        getContext: () => ({
                            get fillStyle() {
                                return canvas.fillStyle;
                            },
                            set fillStyle(color: string) {
                                canvas.fillStyle = color;
                            },
                            fillRect: () => canvas.fills.push(canvas.fillStyle),
                        }),
                        toDataURL: () =>
                            `data:image/png;base64,${page.canvases.indexOf(canvas) + 1}`,
                    };

                    page.canvases.push(canvas);

                    return canvas;
                }

                const link: FakeLink = {
                    rel: "",
                    href: "",
                    removeAttribute: (name) => {
                        if (name === "media") {
                            delete link.media;
                        }
                    },
                };

                return link;
            },
            querySelector: (selector) =>
                selector === 'link[rel="apple-touch-startup-image"]'
                    ? (page.links[0] ?? null)
                    : null,
        },
    };

    return page;
}

function setGlobal(name: string, value: unknown) {
    if (!saved.has(name)) {
        saved.set(name, Object.getOwnPropertyDescriptor(globals, name));
    }

    Object.defineProperty(globals, name, { value, configurable: true, writable: true });
}

function restoreGlobals() {
    for (const [name, descriptor] of saved) {
        if (descriptor === undefined) {
            delete globals[name];
        } else {
            Object.defineProperty(globals, name, descriptor);
        }
    }

    saved.clear();
}

/** The module as iOS gives the page its screen and navigator. */
function onIOS(page: FakePage, screen: Size, ratio: number) {
    setGlobal("navigator", { standalone: false });
    setGlobal("screen", screen);
    setGlobal("devicePixelRatio", ratio);
    setGlobal("document", page.document);
}

test("other devices get no picture", () => {
    try {
        setGlobal("navigator", {});
        assert.equal(startup.applyStartupImage("#13141c"), null);
    } finally {
        restoreGlobals();
    }
});

test("the picture is the screen in portrait, in device pixels, filled with the color", () => {
    try {
        const page = fakePage();

        onIOS(page, { width: 390, height: 844 }, 3);
        const href = startup.applyStartupImage("#13141c");

        assert.equal(page.canvases.length, 1);
        assert.deepEqual(
            { width: page.canvases[0]!.width, height: page.canvases[0]!.height },
            { width: 1170, height: 2532 },
            "390 by 844 points at 3x, kept portrait",
        );
        assert.deepEqual(page.canvases[0]!.fills, ["#13141c"]);
        assert.match(href ?? "", /^data:image\/png/);
        assert.equal(page.links.length, 1);
        assert.equal(page.links[0]!.rel, "apple-touch-startup-image");
        assert.equal(page.links[0]!.href, href);
        assert.equal(page.links[0]!.media, undefined, "one picture for this screen needs no media");
    } finally {
        restoreGlobals();
    }
});

test("a screen reported landscape becomes the portrait picture", () => {
    try {
        const page = fakePage();

        onIOS(page, { width: 844, height: 390 }, 2);
        startup.applyStartupImage("#000000");

        assert.deepEqual(
            { width: page.canvases[0]!.width, height: page.canvases[0]!.height },
            { width: 780, height: 1688 },
        );
    } finally {
        restoreGlobals();
    }
});

test("the same look and screen are drawn once", () => {
    try {
        const page = fakePage();

        onIOS(page, { width: 390, height: 844 }, 3);
        const first = startup.applyStartupImage("#334455");
        const again = startup.applyStartupImage("#334455");

        assert.equal(again, first);
        assert.equal(page.canvases.length, 1);
        assert.equal(page.links.length, 1);
    } finally {
        restoreGlobals();
    }
});

test("another color replaces the one link rather than adding one", () => {
    try {
        const page = fakePage();

        onIOS(page, { width: 390, height: 844 }, 3);
        const dark = startup.applyStartupImage("#556677");
        const light = startup.applyStartupImage("#778899");

        assert.notEqual(light, dark);
        assert.equal(page.canvases.length, 2);
        assert.equal(page.links.length, 1);
        assert.equal(page.links[0]!.href, light);
    } finally {
        restoreGlobals();
    }
});
