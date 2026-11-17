# Design: detect and repair comment links that point to moved notes

Status: **implemented (P0)** · last updated 2026-11-17

Relates to the ROADMAP entry *"Detect and relink comments that point to a note that no longer exists"*. This document describes what was built, why, and where its limits are.

---

## 1. Problem

A comment is bound to a note by a plain string: `Comment.filePath`. It is only updated by the vault `rename` event:

```ts
// src/main.ts
this.app.vault.on('rename', (file, oldPath) => {
    if (file instanceof TFile) {
        this.commentManager.renameFile(oldPath, file.path);
        void this.saveData();
    }
});
```

Every lookup filters on the same exact string (`getCommentsForFile`), so once `filePath` is stale:

- the comment is still listed in **All Notes**, looking perfectly normal,
- clicking it fails with `Failed to jump to Markdown view.`,
- `isOrphaned` is never set — that flag means "the quoted text is gone", not "the note is gone",
- nothing is logged, nothing is shown.

`isOrphaned` and "lost note" are two different failures and need two different states.

## 2. Measured behaviour (test vault, Obsidian 1.14.4, 2026-11-17)

| Experiment | Result |
|---|---|
| Rename a commented note from PowerShell while Obsidian runs | **no `rename` event**; `data.json` unchanged for 8 s |
| Append a line to the same note from PowerShell | `modify` **is** delivered (the handler writes unconditionally) |
| Inspect `.obsidian/workspace.json` after the external rename | updated with the new name — the workspace layer did notice |
| Rename a note with a recorded content fingerprint | repaired automatically in **2–5 s** (an event did fire: the plugin's debounced rescan ran) |
| Move a note while Obsidian is **closed** | repaired **11 s** after the next start, by the startup scan, with no events at all |

Conclusion: correctness must not depend on events; the scan is the foundation and the events are only an accelerator.

## 3. Goals

- A comment whose note moved ends up attached to it, **or** is visibly reported. Never silently lost.
- Repair changes `filePath` (and the derived `commentPath`) only. Ids, bodies, anchors are untouched.
- Ambiguous cases ask a human. Filename equality alone is never enough.
- Every write is preceded by a backup, verified by re-reading `data.json`, and recorded in an audit log.
- Re-running a scan with no changes writes nothing.

## 4. Non-goals

- Recovering comments whose note was deleted on purpose (the user decides: re-link, delete, or ignore).
- Anchor recovery after the quoted text was rewritten (P1).
- Moving storage to Markdown sidecars (ROADMAP Phase 1); the resolver deliberately does not depend on storage.
- Watching the filesystem ourselves (see §9).

## 5. Design as built

### 5.1 Detection

| Trigger | Cost | Role |
|---|---|---|
| Startup, 10 s after `onLayoutReady` | O(comments) map lookups | primary |
| Interval, every 3 min | same | safety net |
| `rename` / `delete` / `create` events → 1.5 s debounce | — | accelerator only |

`getAbstractFileByPath()` is an in-memory map lookup, so scanning is cheap. Content is only read for candidates that could match (§5.2).

Existence, however, is checked with `vault.adapter.exists()` when available: the in-memory index can lag behind the disk if Obsidian's watcher misses a change, and a stale index would make the scan report "everything is fine" for a note that is already gone.

### 5.2 Identity resolution — `src/core/noteLinkResolver.ts`

A pure module: it receives the comments plus a read-only view of the vault (`listNotes`, `readNote`, `hashText`, `sizeOf`) and returns a decision. It has no `obsidian` import, so it runs under `node:test`.

| Tier | Evidence | Available for | Decision |
|---|---|---|---|
| S1 | path exists | everything | nothing to do |
| S1✱ | path exists, but the quoted text is gone **and** the content no longer matches the recorded hash | selection comments, review command only | reported as a suspect: the path may have been reused by another note |
| S2 | content hash recorded at attach time | comments created since this feature | **automatic** when unique |
| S3 | same basename **and** the quoted text is in the file | selection comments | **automatic** when unique |
| S4 | same basename only, unique | selection comments | ask |
| S5 | note-level comment (no quote) + same basename | note comments | **always ask** |
| S6 | several stale paths share one old folder and one new folder | bulk moves | offer as one batch |
| S7 | nothing found | — | mark, never guess |

Content matching is the only clue that survives a **rename**, where the basename changes and no same-name candidate exists. Two details make it work and were both found by testing:

- `fileSizeAtAttach` is a **byte** length (UTF-8), matching `TFile.stat.size`. Character counts diverge for non-ASCII text and silently break the prefilter.
- All distinct `(hash, size)` pairs recorded for a note are tried, not just the first one: a note edited after a comment was created leaves that comment with a stale hash.

An empty-note hash is ignored: every empty file shares the same SHA-256, so it is not identity.

### 5.3 Decision and write path

| Tier | Trigger | Effect |
|---|---|---|
| automatic | S2/S3, unique | rewrites the link, no prompt (setting `autoRelink`, default on) |
| confirmation | S4/S5/S6 | modal lists candidates with the evidence; one click applies |
| marking | S7 | `Note not found` badge + counter; user picks a note or deletes the comments |

Order of a write: **backup → rewrite `filePath` → refresh fingerprints → save → read `data.json` back and verify → append audit**. The read-back compares **per comment id**, not per path: a path-level check would pass when the file exists but the comment that was supposed to move there did not. If the backup cannot be written, nothing is changed; if the read-back does not match, the repair reports a failure instead of claiming success — that exact false-success was observed once during development and is now guarded against.

Backups are pruned to the five most recent `data.v1-backup-<stamp>.json` files, at load and after each write. Only files matching that exact pattern are deleted; `data.json` and a hand-made `data.v1-backup.json` are never touched.

Two settings control automatic repair:

| Setting | Default | Meaning |
|---|---|---|
| `autoRelink` | on | master switch for automatic repair (S2/S3 with a unique match) |
| `autoRelinkRenames` | on | also repair when the file *name* changed. Turn off to confirm renames by hand, e.g. when several devices share the vault |

### 5.4 Data model

Two optional fields on `Comment`, both absent for older data:

| Field | Type | Meaning |
|---|---|---|
| `fileHashAtAttach` | `string?` | SHA-256 of the note content when the comment was created or last re-linked |
| `fileSizeAtAttach` | `number?` | byte length at that moment; cheap prefilter for content matching |

Plus one setting: `autoRelink: boolean` (default `true`).

## 6. UI surface

- Settings: `Unattached comments: N`, last scan time, `Rescan`, `Review and repair…`.
- Sidebar: unattached comments get a red left border and a `Note not found` badge.
- Commands: `Scan for unattached comments`, `Scan and repair comment links`.
- Repair modal: one click on a candidate re-links immediately; `Choose note…` for a full-vault picker (needed for S7, e.g. after a rename); `Ignore`; `Delete comments` behind a confirmation.

## 7. Measured results

| Metric | Value |
|---|---|
| Repair latency, event present | 2–5 s |
| Repair latency, Obsidian was closed | 11 s (startup scan) |
| Repair latency, no event at all | ≤ 3 min (interval scan) |
| Automatic share of repaired comments | 18 of 20 (90%) |
| False links produced | 0 (identical-looking `PATH` / `PATH测试` notes were not confused) |
| Unit tests | 46 (45 pass, 1 skipped — upstream's dev-vault probe) |

## 8. Limits

- **Comments without a fingerprint cannot be matched by content**: they carry no `fileHashAtAttach`, so a rename cannot be recovered automatically. They can still be recovered by S3 (same file name, quoted text still present), which never needed a fingerprint; anything else is a human decision. A note-level comment has no quote at all, so it always ends up in the review list.
- A deleted note has no candidate at all; only a human can say where those comments belong.
- A note whose content changed after its comments were created has a stale hash, so S2 falls back to S5/S7.
- Anchor drift after edits is out of scope (P1).

## 9. Alternatives considered

| Alternative | Why rejected |
|---|---|
| Watch the filesystem ourselves | duplicates Obsidian's watcher, adds a dependency, and still cannot see moves made while Obsidian is closed |
| Patch the string comparison in `renameFile` | the callback never runs for external moves |
| Treat "same filename" as identity | forbidden by the upstream README; would mis-link similar notes |
| Rely on **External Rename Handler** (`mnaoumov`, inode-based) | genuinely attractive: it turns external moves into real `rename` events, which this plugin already handles. Rejected *for now* only because it requires Obsidian 1.15.0+ while the target vault runs 1.14.4. If adopted later, the automatic tiers become a fallback for the cases inodes cannot cover (cross-volume moves, sync clients that rewrite files). |
| Build this together with the Phase 1 sidecar rewrite | doubles the test matrix; sidecar filenames derive from note paths too, so the same failure would reappear |

## 10. Open questions

1. Should `autoRelink` default to off once an inode-based plugin supplies exact `rename` events?
2. Should resolved comments be excluded from automatic repair (they are visible but dimmed)?
3. For a bulk folder move, is one confirmation for the whole batch right, or per note?

## 11. Relationship to Phase 1 (Markdown sidecars)

Phase 1 changes **where** comments are stored; this design changes **how a comment is bound to a note**. Sidecar filenames are derived from the note path (`getSideNoteFilePath`), so an external move breaks them the same way. The resolver takes a file-inventory interface rather than reading `data.json`, so Phase 1 can reuse it unchanged.
