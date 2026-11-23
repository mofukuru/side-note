import { test } from "node:test";
import { strict as assert } from "node:assert";
import { imageExtension, insertEmbeds, pastedImageName, toEmbed } from "../src/core/imageInsert";

test("image types map to extensions, other types are not images", () => {
    assert.equal(imageExtension("image/png"), "png");
    assert.equal(imageExtension("image/JPEG"), "jpg");
    assert.equal(imageExtension("image/svg+xml"), "svg");
    assert.equal(imageExtension("application/pdf"), null);
    assert.equal(imageExtension(""), null);
});

test("a clipboard image gets Obsidian's usual name", () => {
    assert.equal(pastedImageName(new Date(2026, 10, 24, 15, 30, 45), "png"), "Pasted image 20261124153045.png");
    assert.equal(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), "jpg"), "Pasted image 20260102030405.jpg");
});

test("both wikilinks and Markdown links become embeds", () => {
    assert.equal(toEmbed("[[shot.png]]"), "![[shot.png]]");
    assert.equal(toEmbed("![](shot.png)"), "![](shot.png)");
    assert.equal(toEmbed("[](shot.png)"), "![](shot.png)");
});

test("an embed into an empty box needs no line breaks", () => {
    const result = insertEmbeds("", 0, 0, ["![[a.png]]"]);
    assert.equal(result.value, "![[a.png]]");
    assert.equal(result.caret, result.value.length);
});

test("an embed in the middle of text goes on its own line", () => {
    const result = insertEmbeds("see this here", 8, 8, ["![[a.png]]"]);
    assert.equal(result.value, "see this\n![[a.png]]\n here");
    assert.equal(result.caret, "see this\n![[a.png]]\n".length);
});

test("several images are inserted one per line and replace the selection", () => {
    const result = insertEmbeds("x\nSELECTED\ny", 2, 10, ["![[a.png]]", "![[b.png]]"]);
    assert.equal(result.value, "x\n![[a.png]]\n![[b.png]]\ny");
});
