# SideNote Roadmap

English | [日本語](ROADMAP-ja.md)

Last updated: 2026-10-13 (as of v1.3.0)

## Status

- Latest release: **v1.3.0** (multiple highlight colors, #40)
- Awaiting review: **PR #43** fix for editor highlights disappearing in notes with CRLF line endings
- Open issues:
  - #19 Wish list — mostly done. The remaining item, two-way Markdown backup, is covered by Phase 1
  - #9 Exporting comments to Docx — covered by Phase 3

## Phase 1: Storage format v2 (Markdown sidecars as the source of truth)

### Goal

All comments are currently stored in a single file, `.obsidian/plugins/side-note/data.json`. This causes several problems:

- Depending on sync settings, comments may not sync at all. When two devices edit at the same time, the whole file is overwritten by whichever saves last
- It lives in a hidden folder, so neither humans nor AI can read or write it
- The Markdown backup is a one-time export via the "Create Backup" button, so it goes stale quickly (#19)

Like the Kanban plugin, we will switch to a model where a Markdown file per note is the source of truth, and the plugin reads it to display comments.

### Format (draft)

```markdown
---
sidenote-format: 2
source: "memo/notes.md"
---

# Side Notes for memo/notes.md

## the quoted text
<!-- sidenote {"id":"a1","color":"red","author":"mofukuru","prefix":"before ","suffix":" after"} -->
Comment body (Markdown) that can be edited freely

---
```

- `## heading`: the text the comment is attached to. For display only, regenerated on every save
- `<!-- sidenote {...} -->`: data used by the program, as one line of JSON. Hidden in Reading view
- Positions are identified by the quote plus the surrounding text (`prefix` / `suffix`) rather than by offsets. This is the same idea as the W3C Web Annotation TextQuoteSelector: it survives edits to the file and is easy for AI to find by searching. Offsets are treated as a cache

### Lenient parser

Prototype: `src/core/sidecarFormat.ts`, tests: `tests/sidecarFormat.test.ts` (all 11 pass). Not yet wired into the plugin.

The principle is **"never discard what we cannot interpret; keep it as body text or preamble"**.

| Situation | Behavior |
|---|---|
| A person edits the body (including CRLF line endings) | Update only the body, keep the metadata |
| The body contains `## heading` or `---` | Treat it as part of the body |
| A `## quote` + body is appended without a marker | Treat it as a new comment; assign an ID later |
| The JSON is broken | Recover the ID, keep the body, show a warning |
| The marker line was deleted | Treat it as a new comment without losing any text |
| Duplicate IDs (copy and paste) | Treat the second one as a new comment |
| Unknown fields (data from a newer version) | Write them back unchanged |
| Old-style marker `<!-- side-note:ID -->` | Read it as the ID |

### Backward compatibility

1. **Version the format**: write `sidenote-format` in sidecars and `storageVersion` in `data.json`. When an unknown newer format is found, open it read-only and never overwrite it
2. **Migrate safely**: back up `data.json` to `data.v1-backup.json` before migrating. Never delete old data. Make migration idempotent. Show a notice once when it finishes. During migration, prefer `data.json` over existing Markdown backups, which may be stale
3. **Write both during v2.x**: also write comments to `data.json` as a cache, so nothing is lost when downgrading to v1.2. Announce in advance before dropping this
4. **Test with real old data**: put samples of v1 data in `tests/fixtures/` and run the migration tests in CI on every change
5. **No beta releases** (decided). Safety comes from 3 and 4

### Tasks

- [ ] Turn the prototype parser into the real implementation (assign IDs to `id: null` blocks, generate `prefix` / `suffix`)
- [ ] v1 → v2 migration, with migration tests using `tests/fixtures/`
- [ ] Load sidecars, detect changes (vault `modify` event), and keep an in-memory index
- [ ] Avoid reload loops triggered by our own writes (reuse the current `isSavingData` mechanism)
- [ ] Replace the save path (write to both sidecars and `data.json`)
- [ ] Keep sidecars in sync when notes are renamed or deleted
- [ ] Run `npm test` in CI (add it to `ci.yml`)
- [ ] Document the new format in the README (English and Japanese), including how AI or people can write it by hand

### Unverified risks

- How to handle the same sidecar being changed from several devices at once, e.g. via Obsidian Sync
- Load time for notes with a very large number of comments

## Phase 2: Authors and replies

Built on top of the v2 format.

- **Author**: add a "display name" setting and save it as `author`. When AI writes, it identifies itself (e.g. `claude`) so it can be told apart from people
- **Replies**: `replies: [{ id, author, body, timestamp }]`. In sidecars, listed under the comment body with subheadings
- Add a threaded view and a reply box to the sidebar

## Phase 3: Integrations

- **#9 Docx export**: Pandoc converts `[quote]{.comment-start id="0" author="..." date="..."}…[]{.comment-end id="0"}` into Word comments. With sidecars and authors in place, this is mostly a conversion step
- **AI integration**: document the sidecar format in the README so AI can read notes and add or reply to comments

## Small improvements / to check

- [ ] Resolved comments may still be highlighted in Reading view (the editor excludes them, but `applyRenderedHighlights` does not)
- [ ] The `modify` handler in `main.ts` hardcodes the `data.json` path (`.obsidian/plugins/side-note/data.json`). Events never fire under `.obsidian`, so in practice the 2-second polling does the work. Clean up in v2
- [ ] `replaceMarkdownCommentBlock` / `removeMarkdownCommentBlock` in `markdownCommentBlocks.ts` are unused. Delete them once v2 replaces them
- [ ] The "Show highlights in editor" description says a restart is required; check whether it really is
- [ ] 4 lint warnings (non-null assertion)
- [ ] Rest of #19: make the difference between "resolve" and "delete" clearer in the UI, and show orphaned comments
- [ ] Detect and relink comments that point to a note that no longer exists. When a note is moved outside Obsidian (`mv`, git, or while Obsidian is closed), no `rename` event fires and `filePath` keeps the old path. `isOrphaned` is not set either, so the comment is shown nowhere and no warning appears
  - Check that each `filePath` exists on startup and on the `delete` event, and show the count in the settings
  - If a note with the same file name contains the `selectedText`, offer to relink it (otherwise let the user pick)
