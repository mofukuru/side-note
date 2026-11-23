// Text handling for the `[[` note picker in the comment box (#19).
//
// Pure module: no `obsidian` import, tested by tests/linkInsert.test.ts.

/** True when the text right before the caret is a link opener the user just typed. */
export function endsWithLinkTrigger(value: string, caret: number): boolean {
    const before = value.slice(0, caret);
    // "[[[" is not a link opener; it is more likely a literal bracket.
    return before.endsWith("[[") && !before.endsWith("[[[");
}

/**
 * Completes the `[[` before the caret into `[[linkText]]` (or `![[linkText]]` when the user
 * typed `![[`). A `]]` already right after the caret is reused instead of doubled.
 */
export function insertLinkAtTrigger(
    value: string,
    caret: number,
    linkText: string,
): { value: string; caret: number } {
    const before = value.slice(0, caret);
    let after = value.slice(caret);
    if (after.startsWith("]]")) after = after.slice(2);
    const inserted = `${linkText}]]`;
    return { value: before + inserted + after, caret: before.length + inserted.length };
}
