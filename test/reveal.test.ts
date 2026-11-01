// Showing a path in the server machine's file manager (Ctrl+click on a path): the commands for each system, and that
// only the owner may, for a path that is there. No window opens: the commands are only recorded.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Command, hasDesktop, reveal, revealCommands } from "../src/server/reveal.ts";

test("each system's file manager shows a file selected, and a folder itself", () => {
    assert.deepEqual(revealCommands("/a/b.txt", false, "darwin"), [["open", ["-R", "/a/b.txt"]]]);
    assert.deepEqual(revealCommands("/a", true, "darwin"), [["open", ["/a"]]]);
    assert.deepEqual(revealCommands("C:\\a\\b.txt", false, "win32"), [
        ["explorer.exe", ["/select,C:\\a\\b.txt"]],
    ]);

    const linux = revealCommands("/home/me/it's here.txt", false, "linux");

    assert.equal(linux[0]![0], "gdbus");
    assert.ok(linux[0]![1].includes("org.freedesktop.FileManager1.ShowItems"));
    assert.ok(
        linux[0]![1].includes("['file:///home/me/it%27s%20here.txt']"),
        "a quote cannot end the list",
    );
    assert.deepEqual(linux[1], ["xdg-open", ["/home/me"]], "else the folder opens");
    assert.ok(
        revealCommands("/home/me", true, "linux")[0]![1].includes(
            "org.freedesktop.FileManager1.ShowFolders",
        ),
    );
});

test("Linux needs a display; other systems have a desktop", () => {
    assert.equal(hasDesktop({}, "linux"), false);
    assert.equal(hasDesktop({ WAYLAND_DISPLAY: "wayland-1" }, "linux"), true);
    assert.equal(hasDesktop({ DISPLAY: ":0" }, "linux"), true);
    assert.equal(hasDesktop({}, "darwin"), true);
});

// Linux has two ways to show a file: the file manager interface, then the folder. The other systems have one.
const twoCommands = revealCommands("/a/b.txt", false, process.platform).length > 1;

test(
    "the first command that works wins",
    { skip: twoCommands ? false : "one file manager command on this platform" },
    async () => {
        const folder = mkdtempSync(join(tmpdir(), "reveal-"));
        const file = join(folder, "notes.txt");

        writeFileSync(file, "x");

        const ran: Command[] = [];

        await reveal(file, async (command) => {
            ran.push(command);

            return ran.length > 1;
        });

        assert.equal(ran.length, 2);
    },
);

test("a path that is not there is a 404, and a file manager that fails is a 409", async () => {
    const folder = mkdtempSync(join(tmpdir(), "reveal-"));
    const file = join(folder, "notes.txt");

    writeFileSync(file, "x");

    if (hasDesktop()) {
        await assert.rejects(
            reveal(file, async () => false),
            { status: 409 },
        );
    }

    await assert.rejects(
        reveal(join(folder, "missing.txt"), async () => false),
        { status: 404 },
    );
});
