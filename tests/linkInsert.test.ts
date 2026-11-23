import { test } from "node:test";
import { strict as assert } from "node:assert";
import { endsWithLinkTrigger, insertLinkAtTrigger } from "../src/core/linkInsert";

test("[[ right before the caret is a trigger", () => {
    assert.equal(endsWithLinkTrigger("see [[", 6), true);
    assert.equal(endsWithLinkTrigger("![[", 3), true);
});

test("a single [, [[[ or [[ elsewhere is not a trigger", () => {
    assert.equal(endsWithLinkTrigger("see [", 5), false);
    assert.equal(endsWithLinkTrigger("[[[", 3), false);
    assert.equal(endsWithLinkTrigger("[[ abc", 6), false);
});

test("the chosen note completes the link and the caret goes after it", () => {
    const result = insertLinkAtTrigger("see [[ for details", 6, "Chapter 2");
    assert.equal(result.value, "see [[Chapter 2]] for details");
    assert.equal(result.caret, "see [[Chapter 2]]".length);
});

test("an embed opener stays an embed", () => {
    assert.equal(insertLinkAtTrigger("![[", 3, "shot.png").value, "![[shot.png]]");
});

test("an existing ]] after the caret is not doubled", () => {
    const result = insertLinkAtTrigger("[[]]", 2, "Note");
    assert.equal(result.value, "[[Note]]");
    assert.equal(result.caret, "[[Note]]".length);
});
