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
