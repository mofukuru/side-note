// Comment → note link resolution for notes that were moved outside Obsidian.
//
// Background: `Comment.filePath` is only updated by the vault `rename` event, which
// Obsidian does not emit when a file is moved by another program. The comment then keeps
// a path that no longer exists: it is still listed in All Notes, but clicking it fails
// and nothing is reported. See docs/design-comment-link-recovery.md.
//
// This module is deliberately free of any `obsidian` import: it takes a read-only view of
// the vault (list / read / hash) and returns a decision. That keeps it unit-testable with
// tests/helpers/obsidianStub.ts and lets the storage format change later (ROADMAP Phase 1)
// without touching the resolution rules.
//
// Evidence tiers (strongest first):
//   S2  content hash recorded when the comment was attached  → may repair automatically
//   S3  same basename *and* the quoted text found            → may repair automatically
//   S4  same basename only, unique in the vault              → propose, never automatic
//   S5  note-level comment (no quoted text) + basename       → always ask the user
//   S6  many files moved together to one new folder          → one batch proposal
//   S7  nothing found                                        → mark, never guess

export type LinkEvidence = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

export const MIN_QUOTE_LENGTH = 3;

export interface CommentLinkInput {
    id: string;
    filePath: string;
    selectedText?: string;
    isNoteComment?: boolean;
    /** SHA-256 of the note content at attach time; absent for comments older than this feature. */
    fileHashAtAttach?: string;
    /** Byte length at attach time; a cheap prefilter for content matching after a rename. */
    fileSizeAtAttach?: number;
}

export interface ResolverDeps {
    /** Every Markdown path in the vault, vault-relative and "/" separated. */
    listNotes(): string[];
    /** Note content, or null when it cannot be read. */
    readNote(path: string): Promise<string | null>;
    hashText(text: string): Promise<string>;
    /** Byte length of a note, or null when unknown. Used to narrow content matching. */
    sizeOf?(path: string): number | null;
    /**
     * Authoritative existence check against the file system. `listNotes()` comes from
     * Obsidian's in-memory index, which can lag behind the disk when its watcher misses a
     * change; without this the scan can report "all good" for a note that is already gone.
     */
    exists?(path: string): Promise<boolean>;
}

export interface LinkCandidate {
    path: string;
    reasons: string[];
}

export interface FileLinkResult {
    /** The path stored in the comments. */
    path: string;
    commentIds: string[];
    exists: boolean;
    evidence: LinkEvidence;
    candidates: LinkCandidate[];
    /** Set only when the repair is safe without asking (S2 / S3 with a unique match). */
    autoRepairPath: string | null;
    needsConfirmation: boolean;
}

export interface BulkProposal {
    oldFolder: string;
    newFolder: string;
    moves: Array<{ oldPath: string; newPath: string }>;
}

export interface LinkReport {
    totalComments: number;
    totalFiles: number;
    linked: FileLinkResult[];
    missing: FileLinkResult[];
    bulk: BulkProposal[];
    /**
     * Comments whose path still exists but whose note seems to have been replaced: the quoted
     * text is gone and the content no longer matches the fingerprint taken when the comment
     * was created. Reported for confirmation instead of counting as "linked".
     */
    suspects: FileLinkResult[];
}

export interface ResolveOptions {
    /**
     * Read every linked note to detect a path that was reused by a different note. Off for the
     * periodic scan (it would hash the whole vault every three minutes), on for the review
     * command, which is user-initiated.
     */
    checkReplacedPaths?: boolean;
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function basename(path: string): string {
    const p = normalizePath(path);
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
}

export function dirname(path: string): string {
    const p = normalizePath(path);
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
}

function groupComments(comments: CommentLinkInput[]): Map<string, CommentLinkInput[]> {
    const groups = new Map<string, CommentLinkInput[]>();
    for (const comment of comments) {
        const path = normalizePath(comment.filePath);
        const bucket = groups.get(path);
        if (bucket) bucket.push(comment);
        else groups.set(path, [comment]);
    }
    return groups;
}

function indexByBasename(notes: string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const note of notes) {
        // Case-insensitive: the vault may live on a case-insensitive filesystem, and the
        // stored path may differ from the on-disk spelling after external tools touch it.
        const key = basename(note).toLowerCase();
        const bucket = index.get(key);
        if (bucket) bucket.push(note);
        else index.set(key, [note]);
    }
    return index;
}

/**
 * Every distinct (hash, byte length) pair recorded for these comments. A note edited after a
 * comment was created leaves that comment with a stale hash, so trying all recorded pairs beats
 * trusting the first one. A size of 0 means "the note was empty": every blank file shares that
 * hash, so it is not identity (F16). A hash without a size is still usable among same-name
 * candidates, just without the cheap prefilter.
 */
function collectContentEvidence(comments: CommentLinkInput[]): Array<{ hash: string; size?: number }> {
    const seen = new Set<string>();
    const evidence: Array<{ hash: string; size?: number }> = [];
    for (const comment of comments) {
        if (!comment.fileHashAtAttach) continue;
        if (comment.fileSizeAtAttach === 0) continue;
        const key = `${comment.fileHashAtAttach}:${comment.fileSizeAtAttach ?? "?"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({ hash: comment.fileHashAtAttach, size: comment.fileSizeAtAttach });
    }
    return evidence;
}

function quotesToMatch(comments: CommentLinkInput[]): string[] {
    const quotes = new Set<string>();
    for (const comment of comments) {
        const text = comment.selectedText ?? "";
        // A note-level comment has no quote; a very short selection is too weak to prove
        // anything (the same word appears in many notes).
        if (!comment.isNoteComment && text.length >= MIN_QUOTE_LENGTH) quotes.add(text);
    }
    return Array.from(quotes);
}

async function readAndMatch(
    candidates: string[],
    deps: ResolverDeps,
    quotes: string[],
): Promise<string[]> {
    if (!quotes.length) return [];
    const matched: string[] = [];
    for (const candidate of candidates) {
        const content = await deps.readNote(candidate);
        if (content === null) continue;
        if (quotes.every(quote => content.includes(quote))) matched.push(candidate);
    }
    return matched;
}

async function matchByHash(
    candidates: string[],
    deps: ResolverDeps,
    hash: string,
): Promise<string[]> {
    const matched: string[] = [];
    for (const candidate of candidates) {
        const content = await deps.readNote(candidate);
        if (content === null) continue;
        if (await deps.hashText(content) === hash) matched.push(candidate);
    }
    return matched;
}

async function resolveMissingFile(
    path: string,
    comments: CommentLinkInput[],
    basenameCandidates: string[],
    sameSizeCandidates: (size?: number) => string[],
    deps: ResolverDeps,
): Promise<FileLinkResult> {
    const commentIds = comments.map(c => c.id);

    if (!basenameCandidates.length && !sameSizeCandidates(undefined).length && !collectContentEvidence(comments).length) {
        return {
            path, commentIds, exists: false, evidence: "S7",
            candidates: [], autoRepairPath: null, needsConfirmation: false,
        };
    }

    // An empty note has no identity: every empty file shares the same hash, so using it would
    // link a comment to an unrelated blank note. collectContentEvidence() drops those.
    const evidences = collectContentEvidence(comments);
    if (evidences.length) {
        // Content matching is the only clue that survives a rename, where the file name has
        // changed and no basename candidate exists. The size prefilter keeps this cheap.
        const hits = new Map<string, string[]>();
        for (const evidence of evidences) {
            const pool = Array.from(new Set([...basenameCandidates, ...sameSizeCandidates(evidence.size)]));
            for (const hit of await matchByHash(pool, deps, evidence.hash)) {
                const reasons = hits.get(hit) ?? [];
                if (basenameCandidates.includes(hit) && !reasons.includes("same basename")) reasons.unshift("same basename");
                if (!reasons.includes("content hash")) reasons.push("content hash");
                hits.set(hit, reasons);
            }
        }
        if (hits.size === 1) {
            const [match] = Array.from(hits.keys());
            return {
                path, commentIds, exists: false, evidence: "S2",
                candidates: [{ path: match, reasons: hits.get(match) ?? ["content hash"] }],
                autoRepairPath: match, needsConfirmation: false,
            };
        }
        if (hits.size > 1) {
            return {
                path, commentIds, exists: false, evidence: "S2",
                candidates: Array.from(hits.entries()).map(([candidate, reasons]) => ({ path: candidate, reasons })),
                autoRepairPath: null, needsConfirmation: true,
            };
        }
    }

    // Quote matching only makes sense among notes that also share the file name; scanning the
    // whole vault for a sentence would match unrelated notes.
    const quotes = quotesToMatch(comments);
    if (quotes.length && basenameCandidates.length) {
        const matches = await readAndMatch(basenameCandidates, deps, quotes);
        if (matches.length === 1) {
            return {
                path, commentIds, exists: false, evidence: "S3",
                candidates: [{ path: matches[0], reasons: ["same basename", "quoted text"] }],
                autoRepairPath: matches[0], needsConfirmation: false,
            };
        }
        if (matches.length > 1) {
            return {
                path, commentIds, exists: false, evidence: "S3",
                candidates: matches.map(candidate => ({ path: candidate, reasons: ["same basename", "quoted text"] })),
                autoRepairPath: null, needsConfirmation: true,
            };
        }
    }

    if (basenameCandidates.length === 1) {
        // A single candidate is still only a filename coincidence: note-level comments
        // have no quote to verify, and a selection comment whose text is absent may have
        // been pasted into a different note. Both must be confirmed by a human.
        const everyCommentIsNoteLevel = comments.every(c => c.isNoteComment);
        return {
            path, commentIds, exists: false, evidence: everyCommentIsNoteLevel ? "S5" : "S4",
            candidates: [{ path: basenameCandidates[0], reasons: ["same basename"] }],
            autoRepairPath: null, needsConfirmation: true,
        };
    }

    if (basenameCandidates.length > 1) {
        return {
            path, commentIds, exists: false, evidence: "S4",
            candidates: basenameCandidates.map(candidate => ({ path: candidate, reasons: ["same basename"] })),
            autoRepairPath: null, needsConfirmation: true,
        };
    }

    // Same size but different content, or an unreadable candidate: nothing conclusive, so the
    // size matches are offered as weak candidates for a human to judge.
    const sizeOnly = Array.from(new Set(
        collectContentEvidence(comments).flatMap(evidence => sameSizeCandidates(evidence.size)),
    ));
    return {
        path, commentIds, exists: false, evidence: "S7",
        candidates: sizeOnly.map(candidate => ({ path: candidate, reasons: ["same size"] })),
        autoRepairPath: null, needsConfirmation: sizeOnly.length > 0,
    };
}

/**
 * Groups the missing files that moved together: two or more stale paths that used to live
 * in the same folder, each with a confident single candidate inside one common new folder.
 * Bulk moves are the common case for agent-driven reorganisations, and asking once beats
 * asking once per note.
 */
function collectBulkProposals(missing: FileLinkResult[]): BulkProposal[] {
    const byOldFolder = new Map<string, FileLinkResult[]>();
    for (const result of missing) {
        const decisive = result.autoRepairPath ?? (result.candidates.length === 1 ? result.candidates[0].path : null);
        if (!decisive) continue;
        const oldFolder = dirname(result.path);
        const bucket = byOldFolder.get(oldFolder);
        if (bucket) bucket.push(result);
        else byOldFolder.set(oldFolder, [result]);
    }

    const proposals: BulkProposal[] = [];
    byOldFolder.forEach((results, oldFolder) => {
        if (results.length < 2) return;
        const newFolders = new Set(results.map(r => dirname(r.autoRepairPath ?? r.candidates[0].path)));
        if (newFolders.size !== 1) return;
        const newFolder = Array.from(newFolders)[0];
        if (newFolder === oldFolder) return;
        proposals.push({
            oldFolder,
            newFolder,
            moves: results.map(r => ({
                oldPath: r.path,
                newPath: r.autoRepairPath ?? r.candidates[0].path,
            })),
        });
    });
    return proposals;
}

/**
 * Resolves every comment's target note. Read-only: the caller decides what to write.
 */
export async function resolveCommentLinks(
    comments: CommentLinkInput[],
    deps: ResolverDeps,
    options: ResolveOptions = {},
): Promise<LinkReport> {
    const notes = deps.listNotes().map(normalizePath);
    const noteSet = new Set(notes);
    const byBasename = indexByBasename(notes);
    const groups = groupComments(comments);

    // Content matching needs a cheap prefilter: reading every note would be too slow on a
    // large vault, but comparing the in-memory byte length is free.
    const bySize = new Map<number, string[]>();
    if (deps.sizeOf && comments.some(c => c.fileHashAtAttach && c.fileSizeAtAttach !== undefined)) {
        for (const note of notes) {
            const size = deps.sizeOf(note);
            if (size === null || size === undefined) continue;
            const bucket = bySize.get(size);
            if (bucket) bucket.push(note);
            else bySize.set(size, [note]);
        }
    }

    const linked: FileLinkResult[] = [];
    const missing: FileLinkResult[] = [];
    const suspects: FileLinkResult[] = [];
    const contentCache = new Map<string, string | null>();
    const read = async (path: string): Promise<string | null> => {
        if (!contentCache.has(path)) contentCache.set(path, await deps.readNote(path));
        return contentCache.get(path) ?? null;
    };

    for (const [path, groupComments_] of groups) {
        // Prefer the file system over the index when the caller can ask it.
        const exists = deps.exists ? await deps.exists(path) : noteSet.has(path);
        if (exists) {
            const suspect = options.checkReplacedPaths
                ? await detectReplacedNote(path, groupComments_, deps, read)
                : null;
            if (suspect) {
                suspects.push(suspect);
            } else {
                linked.push({
                    path,
                    commentIds: groupComments_.map(c => c.id),
                    exists: true,
                    evidence: "S1",
                    candidates: [],
                    autoRepairPath: null,
                    needsConfirmation: false,
                });
            }
            continue;
        }

        const candidates = byBasename.get(basename(path).toLowerCase()) ?? [];
        // Never offer the stale path itself as its own candidate.
        const filtered = candidates.filter(c => c !== path);

        const sameSizeCandidates = (size?: number): string[] =>
            size === undefined ? [] : (bySize.get(size) ?? []).filter(c => c !== path);

        missing.push(await resolveMissingFile(path, groupComments_, filtered, sameSizeCandidates, deps));
    }

    return {
        totalComments: comments.length,
        totalFiles: groups.size,
        linked,
        missing,
        bulk: collectBulkProposals(missing),
        suspects,
    };
}

/**
 * A path can outlive its note: an external tool moves A to B and something else creates a new
 * file at A. The comment still "finds" its path, so it would be reported as linked while the
 * quoted text is gone and the content belongs to a stranger.
 *
 * A note comment has nothing to check against, so only comments with a quote and a recorded
 * fingerprint are examined. Editing a note is normal and must not be flagged: the quote has to
 * be missing *and* the content has to differ from the fingerprint.
 */
async function detectReplacedNote(
    path: string,
    comments: CommentLinkInput[],
    deps: ResolverDeps,
    read: (path: string) => Promise<string | null>,
): Promise<FileLinkResult | null> {
    const selection = comments.filter(c => !c.isNoteComment && (c.selectedText ?? "").length >= MIN_QUOTE_LENGTH);
    if (!selection.length) return null;

    const content = await read(path);
    if (content === null) return null;
    if (selection.some(c => content.includes(c.selectedText ?? ""))) return null;

    const fingerprint = comments.find(c => c.fileHashAtAttach && c.fileSizeAtAttach !== 0);
    if (!fingerprint?.fileHashAtAttach) return null;
    if (await deps.hashText(content) === fingerprint.fileHashAtAttach) return null;

    // The note at this path is not the one the comment was written on. Offer the notes whose
    // size matches the recorded one as candidates; none may exist, which is a valid answer.
    const size = fingerprint.fileSizeAtAttach;
    const sameSize = size === undefined
        ? []
        : (deps.listNotes()
            .map(normalizePath)
            .filter(candidate => candidate !== path && deps.sizeOf?.(candidate) === size));
    const matches = await matchByHash(sameSize, deps, fingerprint.fileHashAtAttach);

    return {
        path,
        commentIds: comments.map(c => c.id),
        exists: true,
        evidence: "S1",
        candidates: matches.map(candidate => ({ path: candidate, reasons: ["content hash"] })),
        autoRepairPath: null,
        needsConfirmation: true,
    };
}

export interface RepairPlanItem {
    commentIds: string[];
    from: string;
    to: string;
    evidence: LinkEvidence;
}

export interface AutoRepairOptions {
    /**
     * When false (the default), only repairs whose candidate shares the file name are applied
     * automatically — a move within the vault. A rename is a different claim: the link is
     * rewritten to a note with a different name, so it stays a human decision unless asked for.
     */
    includeRenames?: boolean;
}

/** The repairs that may be applied without asking. Bulk proposals stay out on purpose. */
export function planAutomaticRepairs(report: LinkReport, options: AutoRepairOptions = {}): RepairPlanItem[] {
    return report.missing
        .filter(result => result.autoRepairPath !== null)
        .filter(result => {
            if (options.includeRenames) return true;
            return result.candidates.some(candidate =>
                candidate.path === result.autoRepairPath && candidate.reasons.includes("same basename"));
        })
        .map(result => ({
            commentIds: result.commentIds,
            from: result.path,
            to: result.autoRepairPath as string,
            evidence: result.evidence,
        }));
}
