// Following a highlight through edits made inside it.
//
// The editor tracks each highlight with ChangeSet.mapPos(). As long as the highlighted text is
// unchanged, that is all it needs. When the user corrects a word inside the highlight, the text
// no longer matches the stored selection, and the comment used to be orphaned (#19).
//
// The rule here: if every change that touches the highlight lies inside it, the edit belongs to
// the highlight, and the comment should follow it. An edit that crosses a boundary, or one that
// removes the whole highlighted text, is not decided here: the caller keeps orphaning it.
//
// Pure module: no `obsidian` import, tested by tests/innerEdit.test.ts.

import type { ChangeSet } from "@codemirror/state";

/**
 * Maps [from, to] through `changes` when the changes are edits inside that range.
 * Returns null when nothing changed inside, when a change crosses a boundary, or when the
 * range collapses (all of its text was deleted or replaced).
 */
export function mapRangeThroughInnerEdit(
    changes: ChangeSet,
    from: number,
    to: number,
): { from: number; to: number } | null {
    let touched = false;
    let crossesBoundary = false;

    changes.iterChangedRanges((fromA, toA) => {
        // Entirely outside the highlight.
        if (toA < from || fromA > to) return;
        // A pure insertion right at a boundary stays outside (see the mapPos assoc below).
        if (fromA === toA && (fromA === from || fromA === to)) return;
        if (fromA >= from && toA <= to) {
            touched = true;
            return;
        }
        crossesBoundary = true;
    });

    if (!touched || crossesBoundary) return null;

    // Same assoc as the highlight tracker: text typed at a boundary is not absorbed.
    const newFrom = changes.mapPos(from, 1);
    const newTo = changes.mapPos(to, -1);
    return newFrom < newTo ? { from: newFrom, to: newTo } : null;
}
