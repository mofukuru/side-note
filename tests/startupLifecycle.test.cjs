const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function transpile(path) {
    return ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
}

function loadModule(path, dependencies) {
    const exports = {};
    vm.runInNewContext(transpile(path), {
        exports,
        require: name => {
            if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
            return dependencies[name];
        },
        document: {
            documentElement: { style: { setProperty() {} }, setAttribute() {} },
            createTreeWalker: () => ({ nextNode: () => false }),
        },
        NodeFilter: { SHOW_TEXT: 4 },
    }, { filename: path });
    return exports;
}

for (const savedComments of [[], [{
    id: "saved-comment", filePath: "table.md", selectedText: "Cell", selectedTextHash: "saved-hash",
    comment: "Keep this comment", startLine: 0, startChar: 0, endLine: 0, endChar: 4,
    timestamp: 1, isOrphaned: false, isNoteComment: false, resolved: true,
}]]) {
    test(`startup with a rendered table and ${savedComments.length} saved comments`, async () => {
        const stop = new Error("Initialization checkpoint reached");
        let plugin;
        let refreshes = 0;
        class Plugin {
            async loadData() { return { comments: savedComments }; }
            registerEditorExtension() { throw stop; }
        }
        class MarkdownView {}
        const cell = { querySelector: () => null, querySelectorAll: () => [] };
        const view = Object.assign(new MarkdownView(), {
            editor: { cm: { dispatch() {} } },
            file: { path: "table.md" },
            contentEl: { querySelectorAll: () => [cell] },
        });
        const { CommentManager } = loadModule("src/commentManager.ts", {});
        const types = loadModule("src/types.ts", {});
        const { default: SideNote } = loadModule("src/main.ts", {
            obsidian: { Plugin, MarkdownView },
            "./commentManager": { CommentManager },
            "./core/markdownCommentBlocks": {},
            "./SideNoteView": {},
            "./SideNoteSettingTab": {},
            "./highlightPlugin": { createHighlightPlugin: () => [], forceUpdateEffect: { of: () => ({}) } },
            "./utils": {},
            "./types": types,
        });
        plugin = new SideNote();
        plugin.app = { workspace: { iterateAllLeaves(callback) {
            refreshes++;
            assert.ok(plugin.commentManager, "table refresh must wait for the comment manager");
            callback({ view });
        } } };

        await assert.rejects(plugin.onload(), error => error === stop);
        assert.ok(refreshes > 0, "startup must still apply highlights");
        assert.equal(plugin.commentManager.getCommentsForFile("table.md").length, savedComments.length);
        assert.equal(JSON.stringify(plugin.comments), JSON.stringify(savedComments));
    });
}
