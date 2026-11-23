import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ChangeSet, Text } from "@codemirror/state";
import { mapRangeThroughInnerEdit } from "../src/core/innerEdit";

// "The quick brown fox jumps." with "quick brown" highlighted.
const before = "The quick brown fox jumps.";
const from = before.indexOf("quick");
const to = from + "quick brown".length;

function apply(spec: { from: number; to?: number; insert?: string } | Array<{ from: number; to?: number; insert?: string }>) {
    const changes = ChangeSet.of(spec, before.length);
    const doc = changes.apply(Text.of([before])).toString();
    const range = mapRangeThroughInnerEdit(changes, from, to);
    return { doc, range, text: range ? doc.slice(range.from, range.to) : null };
}

test("a word corrected inside the highlight is followed", () => {
    // "quick" → "quiet"
    const result = apply({ from: from + 3, to: from + 5, insert: "et" });
    assert.equal(result.text, "quiet brown");
});

test("text inserted in the middle of the highlight is included", () => {
    const result = apply({ from: from + "quick".length, insert: " and" });
    assert.equal(result.text, "quick and brown");
});

test("deleting the first characters of the highlight shrinks it", () => {
    const result = apply({ from, to: from + 2 });
    assert.equal(result.text, "ick brown");
});

test("deleting the last characters of the highlight shrinks it", () => {
    const result = apply({ from: to - 2, to });
    assert.equal(result.text, "quick bro");
});

test("text typed right before or after the highlight is not absorbed", () => {
    // Nothing changed inside, so this is not an inner edit: the caller's exact match handles it.
    assert.equal(apply({ from, insert: "very " }).range, null);
    assert.equal(apply({ from: to, insert: "ish" }).range, null);
});

test("an edit outside the highlight is not an inner edit", () => {
    assert.equal(apply({ from: 0, to: 3, insert: "A" }).range, null);
});

test("an edit crossing a boundary is left to the caller (orphaned)", () => {
    // Deletes "The qu".
    assert.equal(apply({ from: 0, to: from + 2 }).range, null);
    // Deletes "own fox".
    assert.equal(apply({ from: to - 3, to: to + 4 }).range, null);
});

test("deleting the whole highlighted text collapses it", () => {
    assert.equal(apply({ from, to }).range, null);
});

test("an inner edit together with an edit elsewhere is still followed", () => {
    const result = apply([
        { from: 0, to: 3, insert: "A" },
        { from: from + 3, to: from + 5, insert: "et" },
    ]);
    assert.equal(result.text, "quiet brown");
    assert.equal(result.doc, "A quiet brown fox jumps.");
});
