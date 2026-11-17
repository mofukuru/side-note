import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
    applyRelink,
    backupFileName,
    formatAuditRecord,
    parseAuditRecord,
    repairsFromBulk,
    setAttachHash,
} from "../src/core/linkRepairOps";
import type { RelinkableComment } from "../src/core/linkRepairOps";

// The repair must change the link and nothing else: ids, quotes and anchors are what make a
// comment a comment. See docs/design-comment-link-recovery.md §5.4.

function comment(overrides: Partial<RelinkableComment> = {}): RelinkableComment & Record<string, unknown> {
    return {
        id: "c1",
        filePath: "old/a.md",
        comment: "body",
        selectedText: "quote",
        startLine: 3,
        startChar: 5,
        endLine: 3,
        endChar: 10,
        ...overrides,
    } as RelinkableComment & Record<string, unknown>;
}

test("relink rewrites filePath and reports the affected comments", () => {
    const comments = [comment({ id: "c1" }), comment({ id: "c2" })];

    const result = applyRelink(comments, "old/a.md", "new/a.md");

    assert.equal(result.changed, 2);
    assert.deepEqual(result.affectedIds, ["c1", "c2"]);
    assert.deepEqual(comments.map(c => c.filePath), ["new/a.md", "new/a.md"]);
});

test("relink leaves id, body, quote and anchors untouched", () => {
    const comments = [comment()];

    applyRelink(comments, "old/a.md", "new/a.md");

    assert.deepEqual(comments[0], {
        id: "c1",
        filePath: "new/a.md",
        comment: "body",
        selectedText: "quote",
        startLine: 3,
        startChar: 5,
        endLine: 3,
        endChar: 10,
    });
});

test("relink ignores comments stored under a different path", () => {
    const comments = [comment({ id: "c1", filePath: "other.md" }), comment({ id: "c2" })];

    const result = applyRelink(comments, "old/a.md", "new/a.md");

    assert.equal(result.changed, 1);
    assert.deepEqual(result.affectedIds, ["c2"]);
    assert.equal(comments[0].filePath, "other.md");
});

test("relink re-derives an existing commentPath", () => {
    const comments = [comment({ commentPath: "side-note-comments/old__a-sidenote.md" })];

    applyRelink(comments, "old/a.md", "new/a.md", note => `side-note-comments/${note.replace(/[\\/]/g, "__")}`);

    assert.equal(comments[0].commentPath, "side-note-comments/new__a.md");
});

test("relink drops a commentPath when no replacement can be derived", () => {
    const comments = [comment({ commentPath: "side-note-comments/old__a-sidenote.md" })];

    applyRelink(comments, "old/a.md", "new/a.md", () => null);

    assert.equal("commentPath" in comments[0], false);
});

test("relink with no matching comment reports zero changes", () => {
    const result = applyRelink([comment({ filePath: "elsewhere.md" })], "old/a.md", "new/a.md");
    assert.equal(result.changed, 0);
    assert.deepEqual(result.affectedIds, []);
});

test("backup names are sortable and filesystem safe", () => {
    const name = backupFileName(new Date(2026, 10, 17, 15, 30, 45));
    assert.equal(name, "data.v1-backup-20261117-153045.json");
    assert.match(name, /^data\.v1-backup-\d{8}-\d{6}\.json$/);
    // Two different seconds must not collide.
    assert.notEqual(name, backupFileName(new Date(2026, 10, 17, 15, 30, 46)));
});

test("an audit record survives a format → parse round trip", () => {
    const record = {
        at: "2026-11-17T15:30:45.000Z",
        from: "old/a.md",
        to: "new/a.md",
        evidence: "S5",
        commentIds: ["c1", "c2"],
        backup: "data.v1-backup-20261117-153045.json",
    };

    const line = formatAuditRecord(record);
    assert.equal(line.includes("\n"), false, "one record per line keeps the log appendable");
    assert.deepEqual(parseAuditRecord(line), record);
});

test("a corrupted audit line is skipped instead of throwing", () => {
    assert.equal(parseAuditRecord("not json"), null);
    assert.equal(parseAuditRecord('{"from":"a.md"}'), null);
});

test("bulk proposals expand into per-note repairs", () => {
    const repairs = repairsFromBulk([
        { oldPath: "old/a.md", newPath: "new/a.md" },
        { oldPath: "old/b.md", newPath: "new/b.md" },
    ]);

    assert.deepEqual(repairs, [
        { from: "old/a.md", to: "new/a.md", evidence: "S6" },
        { from: "old/b.md", to: "new/b.md", evidence: "S6" },
    ]);
});

test("setAttachHash stamps only the comments pointing at that note", () => {
    const comments: Array<{ id: string; filePath: string; fileHashAtAttach?: string }> = [
        { id: "c1", filePath: "notes/a.md" },
        { id: "c2", filePath: "notes/a.md", fileHashAtAttach: "stale" },
        { id: "c3", filePath: "notes/b.md" },
    ];

    const updated = setAttachHash(comments, "notes/a.md", "fresh");

    assert.equal(updated, 2);
    assert.equal(comments[0].fileHashAtAttach, "fresh");
    assert.equal(comments[1].fileHashAtAttach, "fresh");
    assert.equal(comments[2].fileHashAtAttach, undefined);
});

test("setAttachHash on an unrelated path changes nothing", () => {
    const comments: Array<{ id: string; filePath: string; fileHashAtAttach?: string }> = [
        { id: "c1", filePath: "notes/a.md" },
    ];
    assert.equal(setAttachHash(comments, "notes/other.md", "x"), 0);
    assert.equal(comments[0].fileHashAtAttach, undefined);
});
