import { test } from "node:test";
import { strict as assert } from "node:assert";
import { captureContext, findAnchor, MAX_CONTEXT } from "../src/core/anchorResolver";

// Anchor recovery is the P1 half of the story: the note still exists, but the paragraph moved
// or was edited. These tests pin the conservative rules: an exact hit wins, context breaks
// ties, and a guess is never returned as a confident match.

const content = "first line\nsecond line with a quote\nthird line";

test("an exact, unique quote is found regardless of the old offset", () => {
    const match = findAnchor(content, { text: "second line", hintOffset: 0 });

    assert.ok(match);
    assert.equal(match.kind, "exact");
    assert.equal(match.score, 1);
    assert.equal(content.slice(match.start, match.end), "second line");
});

test("a quote moved far from its recorded position is still found", () => {
    // The old implementation only searched ±10 lines around the hint.
    const longNote = `${"padding\n".repeat(200)}target sentence\n${"padding\n".repeat(200)}`;
    const match = findAnchor(longNote, { text: "target sentence", hintOffset: 0 });

    assert.ok(match);
    assert.equal(longNote.slice(match.start, match.end), "target sentence");
});

test("context picks the intended one of two identical quotes", () => {
    const note = "alpha unique A\nquote here\nomega\n\nalpha unique B\nquote here\nomega";
    const secondStart = note.lastIndexOf("quote here");
    const query = {
        text: "quote here",
        prefix: "alpha unique B\n",
        suffix: "\nomega",
        hintOffset: secondStart,
    };

    const match = findAnchor(note, query);
    assert.ok(match);
    assert.equal(note.slice(match.start, match.end), "quote here");
    assert.ok(match.score > 0.9, `expected a confident match, got ${match?.score}`);
});

test("context beats proximity when the nearer duplicate is the wrong one", () => {
    const note = "quoted\nnear filler\nquoted\nfar marker";
    // Hint points at the first occurrence, but the recorded context belongs to the second.
    const match = findAnchor(note, {
        text: "quoted",
        suffix: "\nfar marker",
        hintOffset: 0,
    });

    assert.ok(match);
    assert.equal(match.start, note.lastIndexOf("quoted"));
});

test("identical quotes with no distinguishing context stay low confidence", () => {
    const note = "dup\ndup";
    const match = findAnchor(note, { text: "dup" });

    assert.ok(match);
    assert.ok(match.score <= 0.6, `expected a low-confidence hit, got ${match?.score}`);
});

test("whitespace changes do not lose the quote", () => {
    const note = "before\nthe   quick\nbrown    fox\n\nafter";
    const match = findAnchor(note, { text: "the quick brown fox", prefix: "before\n", suffix: "\n\nafter" });

    assert.ok(match);
    assert.equal(match.kind, "loose");
    assert.match(note.slice(match.start, match.end), /^the\s+quick\s+brown\s+fox$/);
});

test("a loose match with no surrounding agreement is not confident", () => {
    const note = "completely\nthe   quick brown\nunrelated";
    const match = findAnchor(note, { text: "the quick brown" });

    assert.ok(match);
    assert.ok(match.score <= 0.6, `expected a weak match, got ${match?.score}`);
});

test("a deleted quote returns null instead of guessing", () => {
    assert.equal(findAnchor("nothing related here", { text: "the quick brown fox" }), null);
});

test("an empty or whitespace-only quote returns null", () => {
    assert.equal(findAnchor(content, { text: "" }), null);
    assert.equal(findAnchor(content, { text: "   " }), null);
});

test("CRLF content is handled once the caller normalises it", () => {
    const crlf = "one\r\ntwo three\r\nfour".replace(/\r\n/g, "\n");
    const match = findAnchor(crlf, { text: "two three" });

    assert.ok(match);
    assert.equal(crlf.slice(match.start, match.end), "two three");
});

test("captureContext stores up to 32 characters on each side", () => {
    const long = "a".repeat(50) + "quote" + "b".repeat(50);
    const { prefix, suffix } = captureContext(long, 50, 55);

    assert.equal(prefix.length, MAX_CONTEXT);
    assert.equal(suffix.length, MAX_CONTEXT);
    assert.equal(prefix, "a".repeat(32));
    assert.equal(suffix, "b".repeat(32));
});

test("captureContext at the edges of the note does not overflow", () => {
    const text = "short";
    const { prefix, suffix } = captureContext(text, 0, text.length);

    assert.equal(prefix, "");
    assert.equal(suffix, "");
});
