# Design: anchor recovery for comments whose text moved or changed

Status: **implemented (P1 core)** — resolver wired into `CommentManager`, acceptance run 2026-11-17
Last updated 2026-11-17

## 7. Acceptance (2026-11-17)

A comment carrying context was placed on a sentence of a real note, then the note was edited externally:

| Step | Edit | Result |
|---|---|---|
| A | 60 lines inserted above the quote (far beyond the old ±10-line window) | re-anchored, line 10 → 70, `isOrphaned=false`, no review flag |
| B | one extra space inside the quote | re-anchored as a loose match, `anchorNeedsReview=true` |
| C | the quote deleted | `isOrphaned=true`, no guess |
| D | original text restored | re-anchored again, `isOrphaned=false` |

A loose (whitespace-tolerant) match is always flagged for review, even when its score is high: it is never byte-identical, so the highlight may be slightly off.

The same flow was then repeated with a comment created through the UI on a real note: `prefix` and `suffix` were stored (32 characters each), and after inserting 60 lines the stored line moved 10 → 70 with the offset landing exactly on the quote.


Companion to [design-comment-link-recovery.md](./design-comment-link-recovery.md). That document is about a comment losing its *note*; this one is about a comment losing its *paragraph*.

---

## 1. Problem

A comment stores where it starts and ends (`startLine`/`startChar`/`endLine`/`endChar`), an absolute `startOffset`/`endOffset`, the selected text and its SHA-256. When the note is edited, all of the coordinates can be wrong while the note is still the right note:

| Situation | Today |
|---|---|
| the paragraph moved | found by the CM6 offset tracker while the editor is open, by an exact text search otherwise |
| the text was lightly edited (`the  quick` → `the quick`) | **not found** — the hash no longer matches |
| the text was rewritten | not found → `isOrphaned` |
| the text was deleted | not found → `isOrphaned` |
| the same text appears twice | the nearest occurrence wins, even if it is the wrong one |

The last two rows are the dangerous ones: "not found" is honest, but "found the wrong occurrence" is a silent mis-attribution, which the project rules forbid.

## 2. Current behaviour (upstream)

`CommentManager.updateCommentCoordinatesForFile()` tries, in order:

1. the absolute offsets (kept in sync by the editor's `ChangeSet.mapPos()`),
2. the stored line/char coordinates,
3. an exact search for the selected text anywhere in the file,
4. a hash-verified search within ±10 lines of the hint.

Step 4 deliberately refuses a whole-document hash scan, because it would happily match an identical sentence in an unrelated section. That is the right instinct and the wrong end state: a legitimate move beyond 10 lines is never recovered.

## 3. Design

### 3.1 Record context, not just text

New comments also store up to 32 characters of the text before and after the selection (`prefix` / `suffix`). This is the same idea as the W3C Web Annotation `TextQuoteSelector`: the quote identifies the text, the context identifies *which* quote.

Both fields are optional; comments created before this change still work, they just have less to go on.

### 3.2 Resolve in three passes — `src/core/anchorResolver.ts`

| Pass | Rule | Accepted when |
|---|---|---|
| exact | the selected text occurs verbatim | unique, or context tells the candidates apart |
| loose | whitespace collapsed (`the   quick` ≈ `the quick`) | unique **and** the surrounding context still agrees |
| none | — | returns `null`, caller marks the comment |

Ranking is by context agreement first, then distance to the last known offset. That ordering matters: a correct paragraph that moved 500 lines away must beat an identical phrase that happens to sit where the comment used to be.

Every match carries a score:

- `1.0` — exact and unique,
- `0.9+` — exact, several candidates, context decides,
- `~0.55` — exact but indistinguishable duplicates,
- `~0.5–0.95` — whitespace-tolerant, context agrees,
- below `0.5` — not returned at all.

### 3.3 What the caller does with the score

| Score | Meaning | Action (to be wired) |
|---|---|---|
| ≥ 0.9 | confident | move the comment silently |
| 0.5–0.9 | plausible | move it **and** flag it for review |
| `null` | nothing convincing | `isOrphaned = true`, as today |

The middle band is the point of this design: today it is all-or-nothing.

## 4. Integration points (next step, not done)

| Where | Change |
|---|---|
| `main.ts` `getSelectionTarget()` | capture `prefix`/`suffix` via `captureContext()` |
| `commentManager.updateCommentCoordinatesForFile()` | replace the ±10-line hash search with `findAnchor()`; keep the offset and exact-coordinate fast paths |
| `commentManager.resolveCommentPosition()` | delete once the new path is proven, or keep as the legacy fallback for comments without context |
| `SideNoteView` | show a "moved — check the highlight" hint for the middle band |

## 5. Why this cannot be fully automatic

If a paragraph is rewritten to the point where neither the text nor the context survives, there is no information left to match on. Guessing there would be worse than admitting it. The design rule stays: **recover what is provable, mark what is not, never guess silently.**

## 6. Open questions

1. Should the middle band be flagged in the comment record (a new optional field) or only in the UI?
2. Should context be refreshed after a successful re-anchor, so a drifting paragraph keeps being findable?
3. How much context is worth storing? 32 characters each side costs ~64 bytes per comment; a larger window helps repeated paragraphs but grows `data.json`.
4. Do we need a full-document hash scan for notes small enough to make it cheap (say < 50 KB)?
