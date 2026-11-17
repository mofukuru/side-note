import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { CommentManager, Comment } from "../src/commentManager";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function makeComment(fields: Partial<Comment> & Pick<Comment, "selectedText" | "startLine" | "startChar">): Comment {
    return {
        id: "c1",
        filePath: "note.md",
        endLine: fields.startLine,
        endChar: fields.startChar + fields.selectedText.length,
        selectedTextHash: sha256(fields.selectedText),
        comment: "",
        timestamp: 0,
        isOrphaned: false,
        isNoteComment: false,
        ...fields,
    };
}

// The editor (CodeMirror) always sees "\n" line breaks, so offsets must be counted
// in that space even when the file on disk uses "\r\n".
const lf = "# Title\nfirst line\nsecond target line\n";
const crlf = lf.replace(/\n/g, "\r\n");
const lfOffset = lf.indexOf("target");

test("CRLF file: offsets are computed in LF space", () => {
    const comment = makeComment({ selectedText: "target", startLine: 2, startChar: 7 });
    new CommentManager([comment]).updateCommentCoordinatesForFile(crlf, "note.md");
    assert.equal(comment.startOffset, lfOffset);
    assert.equal(comment.endOffset, lfOffset + "target".length);
    assert.equal(comment.isOrphaned, false);
});

test("CRLF file: offsets already shifted by \\r are repaired", () => {
    // What v1.3.0 stored for a CRLF file: one extra character per preceding line.
    const shifted = lfOffset + 2;
    const comment = makeComment({
        selectedText: "target", startLine: 2, startChar: 7,
        startOffset: shifted, endOffset: shifted + "target".length,
    });
    const changed = new CommentManager([comment]).updateCommentCoordinatesForFile(crlf, "note.md");
    assert.equal(changed, true);
    assert.equal(comment.startOffset, lfOffset);
    assert.equal(comment.startLine, 2);
    assert.equal(comment.startChar, 7);
});

test("LF file: correct offsets are left unchanged", () => {
    const comment = makeComment({
        selectedText: "target", startLine: 2, startChar: 7,
        startOffset: lfOffset, endOffset: lfOffset + "target".length,
    });
    const changed = new CommentManager([comment]).updateCommentCoordinatesForFile(lf, "note.md");
    assert.equal(changed, false);
    assert.equal(comment.startOffset, lfOffset);
});

// P1: a comment carrying context survives an edit that moves or reshapes its quote. The old
// ±10-line hash search could not: one changed space was enough to lose it.
const longNote = (): string => {
    const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i}`).join("\n");
    return `${filler}\nbasket the apple here\n${filler}`;
};

test("a quote moved far from its stored position is recovered through context", () => {
    const content = longNote();
    const start = content.indexOf("basket the apple");
    const comment = makeComment({
        selectedText: "basket the apple",
        startLine: 1, startChar: 0,
        prefix: content.slice(start - 32, start),
        suffix: content.slice(start + "basket the apple".length, start + "basket the apple".length + 32),
    });

    const changed = new CommentManager([comment]).updateCommentCoordinatesForFile(content, "note.md");

    assert.equal(changed, true);
    assert.equal(comment.isOrphaned, false);
    assert.equal(comment.startOffset, start);
    assert.equal(comment.anchorNeedsReview, false, "an exact unique match needs no review");
});

test("whitespace inside the note does not lose the quote", () => {
    const content = "before\nthe   quick\nbrown    fox\n\nafter";
    const comment = makeComment({
        selectedText: "the quick brown fox",
        startLine: 1, startChar: 0,
        prefix: "before\n",
        suffix: "\n\nafter",
    });

    new CommentManager([comment]).updateCommentCoordinatesForFile(content, "note.md");

    assert.equal(comment.isOrphaned, false);
    assert.equal(comment.anchorNeedsReview, true, "a loose match is reported for review");
});

test("a comment without context still uses the legacy exact search", () => {
    const content = "alpha\nbeta target gamma\n";
    const comment = makeComment({ selectedText: "beta target", startLine: 0, startChar: 0 });

    new CommentManager([comment]).updateCommentCoordinatesForFile(content, "note.md");

    assert.equal(comment.isOrphaned, false);
    assert.equal(comment.startOffset, content.indexOf("beta target"));
});

test("a quote that no longer exists stays orphaned", () => {
    const comment = makeComment({
        selectedText: "vanished sentence",
        startLine: 1, startChar: 0,
        prefix: "before\n",
        suffix: "\nafter",
    });

    new CommentManager([comment]).updateCommentCoordinatesForFile("before\nsomething else\nafter", "note.md");

    assert.equal(comment.isOrphaned, true);
});
