// Pi Pocket's service worker (`web/sw.js`) in a stand-in scope: which window a notification opens and how it gets
// there without a reload, and the icon and badge a notification shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../web/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://pocket.test";

type Shown = { title: string; options: Record<string, any> };
type FakeWindow = {
    url: string;
    focused: number;
    messages: any[];
    navigation: string[];
    focus(): Promise<void>;
    postMessage(message: any): void;
    navigate(url: string): Promise<void>;
};

type Worker = {
    context: any;
    listeners: Map<string, (event: any) => void>;
    shown: Shown[];
    opened: string[];
    fetched: string[];
    kept: Map<string, string>;
};

type WorkerOptions = {
    windows?: FakeWindow[];
    kept?: Map<string, string>;
    fetch?: (input: string) => Promise<Response>;
    setTimeout?: (handler: () => void, ms?: number) => unknown;
    clearTimeout?: (timer: unknown) => void;
};

/** A window of the app, as `clients.matchAll` gives one. */
function windowAt(url: string): FakeWindow {
    const window: FakeWindow = {
        url,
        focused: 0,
        messages: [],
        navigation: [],
        focus: async () => {
            window.focused++;
        },
        postMessage: (message) => {
            window.messages.push(message);
        },
        navigate: async (url) => {
            window.navigation.push(url);
        },
    };

    return window;
}

/** The worker's own source, run with the scope it expects: listeners it adds, a cache, and a network. */
function loadWorker(options: WorkerOptions = {}): Worker {
    const listeners = new Map<string, (event: any) => void>();
    const shown: Shown[] = [];
    const opened: string[] = [];
    const fetched: string[] = [];
    const kept = options.kept ?? new Map<string, string>();
    const windows = options.windows ?? [];
    const network =
        options.fetch ??
        (async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const context: any = {
        URL,
        Response,
        crypto,
        fetch: async (input: string) => {
            fetched.push(input);

            return network(input);
        },
        caches: {
            open: async () => ({
                match: async (key: string) =>
                    kept.has(key) ? new Response(kept.get(key)) : undefined,
                put: async (key: string, response: Response) => {
                    kept.set(key, await response.text());
                },
            }),
        },
        setTimeout: options.setTimeout ?? setTimeout,
        clearTimeout: options.clearTimeout ?? clearTimeout,
        self: {
            addEventListener: (type: string, listener: (event: any) => void) => {
                listeners.set(type, listener);
            },
            skipWaiting: () => undefined,
            location: { origin: ORIGIN },
            clients: {
                matchAll: async () => windows,
                claim: () => undefined,
                openWindow: async (url: string) => {
                    opened.push(url);
                },
            },
            registration: {
                showNotification: async (title: string, options: Record<string, any>) => {
                    shown.push({ title, options });
                },
            },
            navigator: { setAppBadge: async () => undefined },
        },
    };

    vm.runInContext(SOURCE, vm.createContext(context));

    return { context, listeners, shown, opened, fetched, kept };
}

/** Tap a notification: what `notificationclick` does, waited for. */
function tap(worker: Worker, data: Record<string, any>, action?: string) {
    const waits: Promise<unknown>[] = [];

    worker.listeners.get("notificationclick")?.({
        notification: { data, close: () => undefined },
        action,
        waitUntil: (promise: Promise<unknown>) => {
            waits.push(promise);
        },
    });

    return Promise.all(waits);
}

/** A push arrives: what `push` does, waited for. */
function push(worker: Worker, data: Record<string, any>) {
    const waits: Promise<unknown>[] = [];

    worker.listeners.get("push")?.({
        data: { json: () => data },
        waitUntil: (promise: Promise<unknown>) => {
            waits.push(promise);
        },
    });

    return Promise.all(waits);
}

test("the window already at the link's path and query is the one that gets it", () => {
    const worker = loadWorker();
    const first = windowAt(`${ORIGIN}/s/1`);
    const second = windowAt(`${ORIGIN}/s/2?chat=1`);
    const elsewhere = windowAt("https://elsewhere.test/s/2?chat=1");

    assert.equal(worker.context.windowFor([first, second], `${ORIGIN}/s/2?chat=1`), second);
    // Any window of the app, rather than a new one, when none shows the target.
    assert.equal(worker.context.windowFor([elsewhere, first, second], `${ORIGIN}/s/9`), first);
    // Another site's window is not the app's.
    assert.equal(worker.context.windowFor([elsewhere], `${ORIGIN}/s/1`), undefined);
});

test("a tapped notification sends the app's router to the session without a reload", async () => {
    const here = windowAt(`${ORIGIN}/`);
    const target = windowAt(`${ORIGIN}/s/2?chat=1`);
    const worker = loadWorker({ windows: [here, target] });

    await tap(worker, { url: "/s/2?chat=1" });

    assert.equal(target.focused, 1);
    assert.equal(target.messages.length, 1);
    assert.equal(target.messages[0].type, "pocket.navigate");
    assert.equal(target.messages[0].url, `${ORIGIN}/s/2?chat=1`);
    assert.deepEqual(target.navigation, [], "a navigation would lose the draft");
    assert.deepEqual(here.messages, []);
});

test("a PiP notification still opens the panel over the open window", async () => {
    const here = windowAt(`${ORIGIN}/s/3`);
    const worker = loadWorker({ windows: [here] });

    await tap(worker, { url: "/?pip=1" });

    assert.equal(here.messages.length, 1);
    assert.equal(here.messages[0].type, "pocket.pip");
    assert.deepEqual(here.navigation, []);
});

test("with no window open, the link opens one", async () => {
    const worker = loadWorker({ windows: [] });

    await tap(worker, { url: "/s/3" });

    assert.deepEqual(worker.opened, [`${ORIGIN}/s/3`]);
});

test("a push shows the icon resolved last, at once, and refreshes it in the background", async () => {
    const kept = new Map([["/notification-icon", "/icon-dark-192.png"]]);
    const worker = loadWorker({
        kept,
        fetch: async () =>
            Response.json({ icons: [{ type: "image/png", src: "/icon-dark-512.png" }] }),
    });

    await push(worker, { title: "Pi finished", body: "Done", url: "/s/4", tag: "done-4" });

    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0]?.options.icon, "/icon-dark-192.png");
    assert.equal(worker.shown[0]?.options.badge, "/badge-96.png");
    // The manifest was asked while the notification already showed, and its answer is kept for the next push.
    assert.equal(worker.fetched.length, 1);
    assert.equal(kept.get("/notification-icon"), "/icon-dark-512.png");
});

test("a cached push does not wait for a manifest that hangs", async () => {
    const kept = new Map([["/notification-icon", "/icon-light-192.png"]]);
    const worker = loadWorker({
        kept,
        fetch: () => new Promise<Response>(() => undefined),
        setTimeout: (handler) => {
            handler();

            return 1;
        },
    });

    await push(worker, { title: "Pi finished", url: "/s/4" });

    assert.equal(worker.shown[0]?.options.icon, "/icon-light-192.png");
});

test("a push without a kept icon falls back to the PNG, never an SVG", async () => {
    const worker = loadWorker({
        fetch: async () => Response.json({ icons: [{ type: "image/svg+xml", src: "/icon.svg" }] }),
    });

    await push(worker, { title: "Pi finished", url: "/s/4" });

    assert.equal(worker.shown[0]?.options.icon, "/icon-192.png");
    assert.equal(worker.shown[0]?.options.badge, "/badge-96.png");
});

test("a manifest that does not answer in time leaves the PNG fallback", async () => {
    const worker = loadWorker({
        fetch: () => new Promise<Response>(() => undefined),
        setTimeout: (handler) => {
            handler();

            return 1;
        },
    });

    await push(worker, { title: "Pi finished", url: "/s/4" });

    assert.equal(worker.shown[0]?.options.icon, "/icon-192.png");
});

test("answering a call from its notification uses no load and no extra icon fetch", async () => {
    const worker = loadWorker({ fetch: async () => new Response("{}", { status: 200 }) });

    await tap(worker, { url: "/s/1", approval: { id: "a1", allow: true } }, "allow");

    assert.equal(worker.shown.length, 0, "the notification going away is the answer");
    assert.deepEqual(worker.opened, []);
});

test("a failed answer shows a notification with the badge too", async () => {
    const worker = loadWorker({
        fetch: async () => {
            throw new Error("offline");
        },
    });

    await tap(worker, { url: "/s/1", approval: { id: "a1", allow: true } }, "deny");

    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0]?.title, "Could not deny the call");
    assert.equal(worker.shown[0]?.options.icon, "/icon-192.png");
    assert.equal(worker.shown[0]?.options.badge, "/badge-96.png");
});
