import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
    basename,
    dirname,
    planAutomaticRepairs,
    resolveCommentLinks,
} from "../src/core/noteLinkResolver";import type { CommentLinkInput, ResolverDeps } from "../src/core/noteLinkResolver";

// The resolver has no `obsidian` import, so these tests need no stub: they run against a
// plain in-memory vault. See docs/design-comment-link-recovery.md for the evidence tiers.

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function vault(files: Record<string, string>): ResolverDeps {
    return {
        listNotes: () => Object.keys(files),
        readNote: async (path) => (path in files ? files[path] : null),
        hashText: async (text) => sha(text),
        sizeOf: (path) => (path in files ? Buffer.byteLength(files[path]) : null),
        exists: async (path) => path in files,
    };
}

function note(id: string, filePath: string, extra: Partial<CommentLinkInput> = {}): CommentLinkInput {
    return { id, filePath, ...extra };
}

function selection(id: string, filePath: string, selectedText: string): CommentLinkInput {
    return note(id, filePath, { selectedText, isNoteComment: false });
}

test("an existing path is linked and needs no repair", async () => {
    const report = await resolveCommentLinks(
        [note("c1", "notes/a.md", { isNoteComment: true })],
        vault({ "notes/a.md": "hello" }),
    );

    assert.equal(report.linked.length, 1);
    assert.equal(report.missing.length, 0);
    assert.equal(report.linked[0].evidence, "S1");
    assert.deepEqual(planAutomaticRepairs(report), []);
});

test("same basename plus the quoted text resolves automatically (S3)", async () => {
    const report = await resolveCommentLinks(
        [selection("c1", "old/a.md", "quoted sentence")],
        vault({ "new/a.md": "prefix the quoted sentence here" }),
    );

    assert.equal(report.missing.length, 1);
    const result = report.missing[0];
    assert.equal(result.evidence, "S3");
    assert.equal(result.autoRepairPath, "new/a.md");
    assert.equal(result.needsConfirmation, false);
    assert.deepEqual(result.candidates[0].reasons, ["same basename", "quoted text"]);
    assert.deepEqual(planAutomaticRepairs(report), [
        { commentIds: ["c1"], from: "old/a.md", to: "new/a.md", evidence: "S3" },
    ]);
});

test("a note-level comment with a single candidate still asks the user (S5)", async () => {
    // The vault keeps a single candidate, but a note-level comment has no quoted text and
    // no content hash: filename equality alone is not evidence enough to move the comment.
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", { isNoteComment: true })],
        vault({ "new/a.md": "unrelated body" }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S5");
    assert.equal(result.autoRepairPath, null);
    assert.equal(result.needsConfirmation, true);
    assert.deepEqual(planAutomaticRepairs(report), []);
});

test("a recorded content hash disambiguates two same-named notes (S2)", async () => {
    const files = { "x/a.md": "body X", "y/a.md": "body Y" };
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", { isNoteComment: true, fileHashAtAttach: sha("body Y") })],
        vault(files),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S2");
    assert.equal(result.autoRepairPath, "y/a.md");
    assert.equal(result.needsConfirmation, false);
});

test("two candidates with no matching quote stay ambiguous (T09)", async () => {
    const report = await resolveCommentLinks(
        [selection("c1", "old/a.md", "text that is nowhere")],
        vault({ "x/a.md": "aaa", "y/a.md": "bbb" }),
    );

    const result = report.missing[0];
    assert.equal(result.candidates.length, 2);
    assert.equal(result.autoRepairPath, null);
    assert.equal(result.needsConfirmation, true);
    assert.deepEqual(planAutomaticRepairs(report), []);
});

test("nothing found is marked, never guessed (S7 / T10)", async () => {
    const report = await resolveCommentLinks(
        [note("c1", "gone/a.md", { isNoteComment: true })],
        vault({ "other.md": "x" }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S7");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.autoRepairPath, null);
    assert.equal(result.needsConfirmation, false);
    assert.deepEqual(planAutomaticRepairs(report), []);
});

test("a whole folder moved at once becomes a single bulk proposal (S6 / T05)", async () => {
    const files = { "new/a.md": "alpha text", "new/b.md": "beta text" };
    const report = await resolveCommentLinks(
        [selection("c1", "old/a.md", "alpha text"), selection("c2", "old/b.md", "beta text")],
        vault(files),
    );

    assert.equal(report.bulk.length, 1);
    assert.equal(report.bulk[0].oldFolder, "old");
    assert.equal(report.bulk[0].newFolder, "new");
    assert.deepEqual(report.bulk[0].moves, [
        { oldPath: "old/a.md", newPath: "new/a.md" },
        { oldPath: "old/b.md", newPath: "new/b.md" },
    ]);
});

test("several comments on one missing file are reported once", async () => {
    const report = await resolveCommentLinks(
        [
            note("c1", "old/a.md", { isNoteComment: true }),
            selection("c2", "old/a.md", "some quoted text"),
        ],
        vault({ "new/a.md": "some quoted text" }),
    );

    assert.equal(report.missing.length, 1);
    assert.deepEqual(report.missing[0].commentIds, ["c1", "c2"]);
    assert.equal(report.missing[0].autoRepairPath, "new/a.md");
});

test("a selection shorter than three characters is not used as evidence", async () => {
    const report = await resolveCommentLinks(
        [selection("c1", "old/a.md", "ab")],
        vault({ "new/a.md": "ab" }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S4");
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.autoRepairPath, null);
});

test("backslashes in a stored path are normalised", async () => {
    const report = await resolveCommentLinks(
        [note("c1", "notes\\a.md", { isNoteComment: true })],
        vault({ "notes/a.md": "x" }),
    );

    assert.equal(report.missing.length, 0);
    assert.equal(report.linked[0].path, "notes/a.md");
});

test("resolution is deterministic and side-effect free", async () => {
    const deps = vault({ "new/a.md": "quoted sentence", "new/b.md": "beta" });
    const comments = [
        selection("c1", "old/a.md", "quoted sentence"),
        note("c2", "old/b.md", { isNoteComment: true }),
    ];

    const first = await resolveCommentLinks(comments, deps);
    const second = await resolveCommentLinks(comments, deps);
    assert.deepEqual(first, second);
    // The input objects are never mutated.
    assert.deepEqual(comments[0], { id: "c1", filePath: "old/a.md", selectedText: "quoted sentence", isNoteComment: false });
});

test("a renamed note is recognised by content hash, not by file name (S2)", async () => {
    // The user renamed the note, so the basename no longer matches anything. Only the content
    // hash (and its byte length prefilter) can prove where the comment belongs.
    const body = "line one\nline two\nline three";
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", {
            isNoteComment: true,
            fileHashAtAttach: sha(body),
            fileSizeAtAttach: Buffer.byteLength(body),
        })],
        vault({ "notes/(renamed).md": body }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S2");
    assert.equal(result.autoRepairPath, "notes/(renamed).md");
    assert.equal(result.needsConfirmation, false);
    assert.deepEqual(result.candidates[0].reasons, ["content hash"]);
});

test("same size but different content is not treated as a match", async () => {
    const body = "aaaa";
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", {
            isNoteComment: true,
            fileHashAtAttach: sha(body),
            fileSizeAtAttach: Buffer.byteLength(body),
        })],
        vault({ "notes/other.md": "bbbb" }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S7");
    assert.equal(result.autoRepairPath, null);
    assert.equal(result.needsConfirmation, true);
    assert.deepEqual(result.candidates[0].reasons, ["same size"]);
});

test("an empty note's hash is not used as identity", async () => {
    // Every empty file has the same SHA-256, so matching on it would attach comments to any
    // blank note. The size prefilter must refuse it.
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", {
            isNoteComment: true,
            fileHashAtAttach: sha(""),
            fileSizeAtAttach: 0,
        })],
        vault({ "notes/blank.md": "" }),
    );

    const result = report.missing[0];
    assert.notEqual(result.evidence, "S2");
    assert.equal(result.autoRepairPath, null);
});

test("the size prefilter comes from the comment that carries the hash", async () => {
    // A group can mix old comments (no hash) with a new one. Taking the size from the wrong
    // comment would search the wrong pool and miss the match entirely.
    const body = "有些内容 not ascii";
    const report = await resolveCommentLinks(
        [
            note("old", "old/a.md", { isNoteComment: true, fileSizeAtAttach: 0 }),
            note("new", "old/a.md", {
                isNoteComment: true,
                fileHashAtAttach: sha(body),
                fileSizeAtAttach: Buffer.byteLength(body),
            }),
        ],
        vault({ "notes/renamed.md": body }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S2");
    assert.equal(result.autoRepairPath, "notes/renamed.md");
    assert.deepEqual(result.commentIds, ["old", "new"]);
});

test("a stale hash on the same note does not block the fresh one (S2)", async () => {
    // The note was edited after the first comment was created, so its hash is stale. The newer
    // comment's hash is the one that matches, and the resolver must consider both.
    const oldBody = "old content";
    const newBody = "new content here";
    const report = await resolveCommentLinks(
        [
            note("c1", "old/a.md", {
                isNoteComment: true,
                fileHashAtAttach: sha(oldBody),
                fileSizeAtAttach: Buffer.byteLength(oldBody),
            }),
            note("c2", "old/a.md", {
                isNoteComment: true,
                fileHashAtAttach: sha(newBody),
                fileSizeAtAttach: Buffer.byteLength(newBody),
            }),
        ],
        vault({ "notes/renamed.md": newBody }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S2");
    assert.equal(result.autoRepairPath, "notes/renamed.md");
    assert.equal(result.needsConfirmation, false);
});

test("evidence pointing at two different files stays ambiguous (T09)", async () => {
    const first = "first body";
    const second = "a second body";
    const report = await resolveCommentLinks(
        [
            note("c1", "old/a.md", {
                isNoteComment: true,
                fileHashAtAttach: sha(first),
                fileSizeAtAttach: Buffer.byteLength(first),
            }),
            note("c2", "old/a.md", {
                isNoteComment: true,
                fileHashAtAttach: sha(second),
                fileSizeAtAttach: Buffer.byteLength(second),
            }),
        ],
        vault({ "notes/one.md": first, "notes/two.md": second }),
    );

    const result = report.missing[0];
    assert.equal(result.evidence, "S2");
    assert.equal(result.candidates.length, 2);
    assert.equal(result.autoRepairPath, null);
    assert.equal(result.needsConfirmation, true);
});

test("a stale index does not hide a note that is gone from disk", async () => {
    // Obsidian's in-memory index can lag behind the file system. When a caller can ask the
    // disk, that answer wins; otherwise the scan would report "everything is fine".
    const body = "content";
    const deps: ResolverDeps = {
        listNotes: () => ["old/a.md", "new/a.md"],
        readNote: async (path) => (path === "new/a.md" ? body : null),
        hashText: async (text) => sha(text),
        exists: async (path) => path !== "old/a.md",
    };

    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", {
            isNoteComment: true,
            fileHashAtAttach: sha(body),
            fileSizeAtAttach: Buffer.byteLength(body),
        })],
        deps,
    );

    assert.equal(report.linked.length, 0);
    assert.equal(report.missing.length, 1);
    assert.equal(report.missing[0].autoRepairPath, "new/a.md");
});

test("automatic repair skips renames unless the user opted in", async () => {
    const body = "renamed body";
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", {
            isNoteComment: true,
            fileHashAtAttach: sha(body),
            fileSizeAtAttach: Buffer.byteLength(body),
        })],
        vault({ "notes/a-renamed.md": body }),
    );

    assert.equal(report.missing[0].autoRepairPath, "notes/a-renamed.md");

    // Default: the file name changed, so this stays a human decision.
    assert.deepEqual(planAutomaticRepairs(report), []);
    // Opt-in: apply it automatically.
    assert.deepEqual(planAutomaticRepairs(report, { includeRenames: true }), [
        { commentIds: ["c1"], from: "old/a.md", to: "notes/a-renamed.md", evidence: "S2" },
    ]);
});

test("automatic repair of a pure move is allowed by default", async () => {
    const body = "moved body";
    const report = await resolveCommentLinks(
        [note("c1", "old/a.md", {
            isNoteComment: true,
            fileHashAtAttach: sha(body),
            fileSizeAtAttach: Buffer.byteLength(body),
        })],
        vault({ "new/a.md": body }),
    );

    assert.deepEqual(planAutomaticRepairs(report), [
        { commentIds: ["c1"], from: "old/a.md", to: "new/a.md", evidence: "S2" },
    ]);
});

test("a path reused by another note is reported instead of considered linked", async () => {
    // The note moved to b.md and something else took its old path. Without the extra check the
    // comment looks perfectly linked while its paragraph belongs to a stranger.
    const original = "the quoted paragraph\nand one more line";
    const replacement = "a completely different note";
    const deps = vault({ "a.md": replacement, "notes/b.md": original });
    const comments = [selection("c1", "a.md", "the quoted paragraph")];
    comments[0].fileHashAtAttach = sha(original);
    comments[0].fileSizeAtAttach = Buffer.byteLength(original);

    const quiet = await resolveCommentLinks(comments, deps);
    assert.equal(quiet.linked.length, 1);
    assert.deepEqual(quiet.suspects, []);

    const checked = await resolveCommentLinks(comments, deps, { checkReplacedPaths: true });
    assert.equal(checked.linked.length, 0);
    assert.equal(checked.suspects.length, 1);
    assert.equal(checked.suspects[0].needsConfirmation, true);
    assert.deepEqual(checked.suspects[0].candidates.map(c => c.path), ["notes/b.md"]);
});

test("an edited note that still contains the quote is not a suspect", async () => {
    const original = "keep this quote please";
    const edited = "an introduction line\nkeep this quote please\nand an appendix";
    const deps = vault({ "a.md": edited });
    const comments = [selection("c1", "a.md", "keep this quote")];
    comments[0].fileHashAtAttach = sha(original);
    comments[0].fileSizeAtAttach = Buffer.byteLength(original);

    const report = await resolveCommentLinks(comments, deps, { checkReplacedPaths: true });

    assert.equal(report.linked.length, 1);
    assert.deepEqual(report.suspects, []);
});

test("note comments are never treated as replaced", async () => {
    // A note comment has no quote to compare, so there is nothing to prove and nothing to flag.
    const deps = vault({ "a.md": "whatever content" });
    const comments = [note("c1", "a.md", {
        isNoteComment: true,
        fileHashAtAttach: sha("something else entirely"),
        fileSizeAtAttach: 22,
    })];

    const report = await resolveCommentLinks(comments, deps, { checkReplacedPaths: true });

    assert.equal(report.linked.length, 1);
    assert.deepEqual(report.suspects, []);
});

test("basename and dirname handle flat and nested paths", () => {
    assert.equal(basename("a.md"), "a.md");
    assert.equal(basename("x/y/a.md"), "a.md");
    assert.equal(dirname("a.md"), "");
    assert.equal(dirname("x/y/a.md"), "x/y");
});
