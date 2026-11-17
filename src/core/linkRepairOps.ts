// Pure helpers for repairing a comment's note link (P0-2).
//
// The repair itself is deliberately narrow: only `filePath` (and the derived `commentPath`)
// may change. Comment ids, quoted text, anchors and bodies are never touched, so a repaired
// comment keeps its identity and its history. See docs/design-comment-link-recovery.md §5.4.

export interface RelinkableComment {
    id: string;
    filePath: string;
    commentPath?: string;
}

export interface RelinkRepair {
    from: string;
    to: string;
    /** Which evidence tier justified this repair ("S2", "S3", "S5", ...). */
    evidence: string;
}

export interface RelinkResult {
    changed: number;
    affectedIds: string[];
}

/**
 * Re-points every comment stored under `from` at `to`.
 *
 * `mapCommentPath` re-derives the Markdown mirror path when a comment already has one;
 * returning null drops the stale mirror pointer instead of keeping one that cannot resolve.
 */
export function applyRelink<T extends RelinkableComment>(
    comments: T[],
    from: string,
    to: string,
    mapCommentPath?: (notePath: string) => string | null,
): RelinkResult {
    const affectedIds: string[] = [];

    for (const comment of comments) {
        if (comment.filePath !== from) continue;
        comment.filePath = to;
        if (comment.commentPath) {
            const next = mapCommentPath ? mapCommentPath(to) : null;
            if (next) comment.commentPath = next;
            else delete comment.commentPath;
        }
        affectedIds.push(comment.id);
    }

    return { changed: affectedIds.length, affectedIds };
}

export interface AuditRecord {
    at: string;
    from: string;
    to: string;
    evidence: string;
    commentIds: string[];
    backup: string | null;
}

/** One JSON object per line, so the log stays append-only and greppable. */
export function formatAuditRecord(record: AuditRecord): string {
    return JSON.stringify(record);
}

export function parseAuditRecord(line: string): AuditRecord | null {
    try {
        const parsed = JSON.parse(line) as Partial<AuditRecord>;
        if (typeof parsed.from !== "string" || typeof parsed.to !== "string") return null;
        return {
            at: typeof parsed.at === "string" ? parsed.at : "",
            from: parsed.from,
            to: parsed.to,
            evidence: typeof parsed.evidence === "string" ? parsed.evidence : "",
            commentIds: Array.isArray(parsed.commentIds) ? parsed.commentIds.map(String) : [],
            backup: typeof parsed.backup === "string" ? parsed.backup : null,
        };
    } catch {
        return null;
    }
}

/** `data.v1-backup-20261117-153045.json` — sortable, no characters a filesystem dislikes. */
export function backupFileName(now: Date): string {
    const pad = (value: number) => value.toString().padStart(2, "0");
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        "-",
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join("");
    return `data.v1-backup-${stamp}.json`;
}

/** Expands a bulk folder proposal into per-note repairs for the shared apply path. */
export function repairsFromBulk(
    moves: Array<{ oldPath: string; newPath: string }>,
    evidence = "S6",
): RelinkRepair[] {
    return moves.map(move => ({ from: move.oldPath, to: move.newPath, evidence }));
}

export interface HashCarrier {
    id: string;
    filePath: string;
    fileHashAtAttach?: string;
    fileSizeAtAttach?: number;
}

/**
 * Records the content hash (and byte length) of the note a comment now points at, so a future
 * rename can be recognised by content instead of by file name (evidence tier S2).
 */
export function setAttachHash<T extends HashCarrier>(
    comments: T[],
    filePath: string,
    hash: string,
    size?: number,
): number {
    let updated = 0;
    for (const comment of comments) {
        if (comment.filePath !== filePath) continue;
        comment.fileHashAtAttach = hash;
        if (size !== undefined) comment.fileSizeAtAttach = size;
        updated++;
    }
    return updated;
}
