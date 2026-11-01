// Pi Pocket's service worker. It shows push notifications (Pi finished, an approval, a chat message), answers an
// approval from its notification, opens the right session when one is tapped, and hands things shared to Pi Pocket
// from other apps to the page. It caches none of the app: the app is edited live.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Where shared things wait until the page picks them up; see `web/share.js`. */
const SHARE_CACHE = "pocket-share";

/** Where the notification icon last resolved to waits between pushes: a worker stops when idle and keeps no variables. */
const ICON_CACHE = "pocket-notification-icon";
const ICON_ENTRY = "/notification-icon";
/** A PNG every system shows: macOS cannot show an SVG notification icon. */
const FALLBACK_ICON = "/icon-192.png";
/** The monochrome mark systems draw small, in the status bar and beside the app's name. */
const BADGE = "/badge-96.png";
/** A push waits no longer than this for the manifest: a slow server must not hold the notification. */
const ICON_TIMEOUT_MS = 1500;

/** What `work` gives, or undefined after `ms`. */
function within(work, ms = ICON_TIMEOUT_MS) {
    let timer;

    return Promise.race([
        work,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/** The icon URL the last push resolved, if it is still kept. */
async function cachedIcon() {
    try {
        const cache = await caches.open(ICON_CACHE);
        const response = await cache.match(ICON_ENTRY);
        const src = response === undefined ? "" : (await response.text()).trim();

        if (src.startsWith("/")) {
            return src;
        }
    } catch {
        // Ask the manifest below.
    }

    return undefined;
}

/**
 * Ask the manifest for its icon, and keep the answer for the next push. The server's manifest follows the icon cookies
 * (`src/server/http/icon-route.ts`), so it is asked rather than assumed: the person picks the icon in Appearance. The
 * answer is its first PNG icon, which every system shows.
 */
async function rememberIcon() {
    let src;

    try {
        const response = await within(
            fetch("/manifest.webmanifest", { credentials: "same-origin" }),
        );

        src = (await response.json()).icons?.find(
            (icon) => icon.type === "image/png" && icon.purpose !== "maskable",
        )?.src;
    } catch {
        return undefined;
    }

    if (typeof src !== "string" || !src.startsWith("/")) {
        return undefined;
    }

    try {
        const cache = await caches.open(ICON_CACHE);

        await cache.put(
            ICON_ENTRY,
            new Response(src, { headers: { "content-type": "text/plain" } }),
        );
    } catch {
        // Not kept: the next push asks again.
    }

    return src;
}

/**
 * The notification's icon, and the work that keeps it current. The last one resolved shows at once, while the manifest
 * is asked again in the background; with none, it is asked now, for at most `ICON_TIMEOUT_MS`, then the PNG fallback.
 */
async function notificationIcon() {
    const cached = await cachedIcon();

    if (cached !== undefined) {
        return { icon: cached, refresh: rememberIcon() };
    }

    const refresh = rememberIcon();

    return { icon: (await refresh) ?? FALLBACK_ICON, refresh };
}

self.addEventListener("push", (event) => {
    let data = {};

    try {
        data = event.data?.json() ?? {};
    } catch {
        data = { title: "Pi Pocket", body: event.data?.text() ?? "" };
    }

    const approval = data.approval;
    // Allowing from the notification is offered only when the server says the whole call shows and this person may.
    const actions = approval
        ? [
              ...(approval.allow ? [{ action: "allow", title: "Allow" }] : []),
              { action: "deny", title: "Deny" },
          ]
        : [];

    event.waitUntil(
        Promise.all([
            notificationIcon().then(async ({ icon, refresh }) => {
                await self.registration.showNotification(data.title || "Pi Pocket", {
                    body: data.body || "",
                    tag: data.tag,
                    renotify: Boolean(data.tag),
                    icon,
                    badge: BADGE,
                    actions,
                    data: { url: data.url || "/", approval },
                });
                // Kept for the next push; the notification already shows.
                await refresh;
            }),
            // A dot on the home-screen icon; the app sets the real count once it opens.
            self.navigator.setAppBadge?.().catch(() => {}),
        ]),
    );
});

/** Answer an approval with this device's sign-in. Only a failure shows: the notification going away is the answer. */
async function answerApproval(approval, allow, data) {
    let problem;

    try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ allow }),
        });

        if (!response.ok) {
            problem =
                (await response.json().catch(() => ({}))).error ??
                `The server answered ${response.status}.`;
        }
    } catch {
        problem = "Pi Pocket could not be reached.";
    }

    if (problem === undefined) {
        return;
    }

    const { icon, refresh } = await notificationIcon();

    await self.registration.showNotification(`Could not ${allow ? "allow" : "deny"} the call`, {
        body: problem,
        icon,
        badge: BADGE,
        data: { url: data.url },
    });
    await refresh;
}

/**
 * The window a notification's link goes to: the one already showing that path and query, otherwise any window of the
 * app. Another one still gets there in place (`pocket.navigate`), so what is typed in it is not lost.
 */
function windowFor(windows, url) {
    const target = new URL(url);
    const same = windows.filter((client) => new URL(client.url).origin === target.origin);
    const here = same.find((client) => {
        const at = new URL(client.url);

        return at.pathname === target.pathname && at.search === target.search;
    });

    return here ?? same[0];
}

async function openUrl(url) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windowFor(windows, url);
    const target = new URL(url);

    if (open === undefined) {
        await self.clients.openWindow(url);

        return;
    }

    await open.focus();

    // PiP's notifications open its panel over whatever the window shows, rather than take the window elsewhere.
    if (target.searchParams.has("pip")) {
        open.postMessage({ type: "pocket.pip" });

        return;
    }

    // The app's own router goes there: a full load would lose what the person has typed (`pip.js`).
    open.postMessage({ type: "pocket.navigate", url: target.href });
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data ?? {};

    if ((event.action === "allow" || event.action === "deny") && data.approval) {
        event.waitUntil(answerApproval(data.approval, event.action === "allow", data));

        return;
    }

    event.waitUntil(openUrl(new URL(data.url || "/", self.location.origin).href));
});

/**
 * Something shared to Pi Pocket from another app (the manifest's share target) arrives as a form post. Keep it until
 * the page picks it up, then open the page to choose where it goes. Any website could post a form here too, and
 * nothing tells it apart from a share; it only fills in a message the person still reads and sends themselves.
 */
async function receiveShare(request) {
    let form;

    try {
        form = await request.formData();
    } catch {
        return Response.redirect("/?share=failed", 303);
    }

    const id = crypto.randomUUID();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll("files").filter((file) => file instanceof File && file.size > 0);
    const text = (name) => (typeof form.get(name) === "string" ? form.get(name) : "");
    const meta = {
        title: text("title"),
        text: text("text"),
        url: text("url"),
        files: files.map((file) => ({ name: file.name, type: file.type })),
    };

    await cache.put(
        `/share/${id}/meta`,
        new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }),
    );
    await Promise.all(
        files.map((file, index) =>
            cache.put(
                `/share/${id}/file/${index}`,
                new Response(file, {
                    headers: { "content-type": file.type || "application/octet-stream" },
                }),
            ),
        ),
    );

    return Response.redirect(`/?share=${id}`, 303);
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (
        event.request.method === "POST" &&
        url.origin === self.location.origin &&
        url.pathname === "/share"
    ) {
        event.respondWith(receiveShare(event.request));
    }
});
