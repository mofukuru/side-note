import { test } from "node:test";
import { strict as assert } from "node:assert";
import { obsidian } from "./helpers/obsidianStub";
import type { Comment } from "../src/commentManager";
import type SideNoteType from "../src/main";

// Regression test for #45: with a rendered table cell open, enabling SideNote
// refreshed highlights inside loadPluginData() before commentManager existed and
// crashed with "Cannot read properties of undefined (reading getCommentsForFile)".

// onload() goes on to register many Obsidian hooks; stop at the first one, since
// everything this test cares about happens before it.
const checkpoint = new Error("initialization checkpoint reached");
let savedComments: Comment[] = [];

obsidian.Plugin = class {
    async loadData() { return { comments: savedComments }; }
    registerEditorExtension() { throw checkpoint; }
};

// applyHighlightColor() and the rendered-cell highlighter touch the DOM.
Object.assign(globalThis, {
    document: {
        documentElement: { style: { setProperty() {} }, setAttribute() {} },
        createTreeWalker: () => ({ nextNode: () => false }),
    },
    NodeFilter: { SHOW_TEXT: 4 },
});

// Required (not imported) so the Plugin stub above is in place first.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { default: SideNote } = require("../src/main") as { default: typeof SideNoteType };
const MarkdownView = obsidian.MarkdownView as new () => object;

const savedComment: Comment = {
    id: "saved-comment", filePath: "table.md", selectedText: "Cell", selectedTextHash: "saved-hash",
    comment: "Keep this comment", startLine: 0, startChar: 0, endLine: 0, endChar: 4,
    timestamp: 1, isOrphaned: false, isNoteComment: false, resolved: true,
};

for (const comments of [[], [savedComment]]) {
    test(`startup with a rendered table cell and ${comments.length} saved comment(s)`, async () => {
        savedComments = comments;
        const plugin = new SideNote({} as never, {} as never);

        // A Live Preview leaf showing a table widget with one rendered cell.
        const cell = { querySelector: () => null, querySelectorAll: () => [] };
        const view = Object.assign(new MarkdownView(), {
            editor: { cm: { dispatch() {} } },
            file: { path: "table.md" },
            contentEl: { querySelectorAll: () => [cell] },
        });
        let refreshes = 0;
        plugin.app = {
            workspace: {
                iterateAllLeaves(callback: (leaf: unknown) => void) {
                    refreshes++;
                    assert.ok(plugin.commentManager, "highlight refresh must wait for the comment manager");
                    callback({ view });
                },
            },
        } as never;

        await assert.rejects(plugin.onload(), error => error === checkpoint);
        assert.ok(refreshes > 0, "startup must still apply highlights");
        assert.equal(plugin.commentManager.getCommentsForFile("table.md").length, comments.length);
        assert.deepEqual(plugin.comments, comments);
    });
}
