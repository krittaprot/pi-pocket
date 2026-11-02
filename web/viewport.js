// On an iPhone home screen, iOS 26 can measure the app's viewport short of the screen by about a status bar
// (WebKit bug 316008), and the desk shows below the app as a band. When the app fills the screen's width but
// 100dvh comes up that little bit short, the app takes the screen's height instead (--app-height).

const MOST_MISSING = 100; // a status bar, at most; a keyboard takes more, and then 100dvh is left alone

export function startViewportFix() {
    if (navigator.standalone !== true) {
        return;
    }

    const root = document.documentElement;
    const probe = document.createElement("div");

    probe.style.cssText =
        "position:fixed;top:0;left:0;width:0;height:100dvh;visibility:hidden;pointer-events:none";
    document.body.append(probe);

    const fit = () => {
        const portrait = matchMedia("(orientation: portrait)").matches;
        const short = Math.min(screen.width, screen.height);
        const long = Math.max(screen.width, screen.height);
        const width = portrait ? short : long;
        const height = portrait ? long : short;
        const missing = height - probe.getBoundingClientRect().height;

        // A window narrower than the screen (an iPad beside another app) is not full screen: leave it be.
        if (Math.abs(innerWidth - width) <= 1 && missing > 1 && missing <= MOST_MISSING) {
            root.style.setProperty("--app-height", `${height}px`);
            root.style.overflow = "hidden";
        } else {
            root.style.removeProperty("--app-height");
            root.style.removeProperty("overflow");
        }
    };

    fit();
    addEventListener("resize", fit);
    addEventListener("orientationchange", () => setTimeout(fit, 300));
}
