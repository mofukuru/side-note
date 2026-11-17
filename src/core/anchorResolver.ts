// Anchor resolution: finding where a quoted piece of text lives in a note now.
//
// Comments store the selected text, its hash, and (from this version on) a little context on
// each side. When the note is edited — the paragraph moves, a word is corrected, the spacing
// changes — the stored line/offset is worthless, but the text usually is not.
//
// The rules are deliberately conservative: an exact hit wins, context breaks ties, and a
// whitespace-tolerant match is accepted only once. Anything else returns null so the caller
// can mark the comment as orphaned instead of silently pointing at the wrong paragraph.
//
// Pure module: no `obsidian` import, tested by tests/anchorResolver.test.ts.

export interface AnchorQuery {
    /** The originally selected text. */
    text: string;
    /** Up to 32 characters that preceded the selection. */
    prefix?: string;
    /** Up to 32 characters that followed the selection. */
    suffix?: string;
    /** Last known offset, used only as a tie-breaker. */
    hintOffset?: number;
}

export type AnchorKind = "exact" | "loose";

export interface AnchorMatch {
    /** Start offset in the LF-normalised content the caller passed in. */
    start: number;
    end: number;
    kind: AnchorKind;
    /** 0..1; 1 is an exact, context-confirmed hit. */
    score: number;
}

export const MAX_CONTEXT = 32;

/** Whitespace inside a quote collapses to a single space before comparing loosely. */
function normaliseWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Builds a whitespace-collapsed copy of `content` plus a map from every index of that copy
 * back to the original string, so a match found in the copy can be reported as real offsets.
 */
function collapseWithIndex(content: string): { collapsed: string; map: number[] } {
    const map: number[] = [];
    let collapsed = "";
    let pendingSpace = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (/\s/.test(char)) {
            pendingSpace = collapsed.length > 0;
            continue;
        }
        if (pendingSpace) {
            map.push(i - 1 < 0 ? 0 : i - 1);
            collapsed += " ";
            pendingSpace = false;
        }
        map.push(i);
        collapsed += char;
    }
    map.push(content.length);
    return { collapsed, map };
}

function occurrences(haystack: string, needle: string): number[] {
    const found: number[] = [];
    if (!needle) return found;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        found.push(index);
        index = haystack.indexOf(needle, index + 1);
    }
    return found;
}

/** How many characters of the recorded context still sit next to this candidate. */
function contextScore(content: string, start: number, end: number, query: AnchorQuery): number {
    let before = 0;
    if (query.prefix) {
        const prefix = query.prefix.slice(-MAX_CONTEXT);
        for (let i = 1; i <= prefix.length && start - i >= 0; i++) {
            if (content[start - i] !== prefix[prefix.length - i]) break;
            before++;
        }
    }
    let after = 0;
    if (query.suffix) {
        const suffix = query.suffix.slice(0, MAX_CONTEXT);
        for (let i = 0; i < suffix.length && end + i < content.length; i++) {
            if (content[end + i] !== suffix[i]) break;
            after++;
        }
    }
    return before + after;
}

function rank(
    content: string,
    candidates: Array<{ start: number; end: number; kind: AnchorKind }>,
    query: AnchorQuery,
): AnchorMatch[] {
    const hint = query.hintOffset ?? 0;
    return candidates
        .map(candidate => {
            const context = contextScore(content, candidate.start, candidate.end, query);
            const contextRatio = context / (MAX_CONTEXT * 2);
            const base = candidate.kind === "exact" ? 0.9 : 0.6;
            const proximity = Math.max(0, 1 - Math.abs(candidate.start - hint) / Math.max(1, content.length));
            return {
                ...candidate,
                // Context dominates so a remote-but-correct paragraph beats a nearby duplicate.
                score: Math.min(1, base + contextRatio * 0.3 + proximity * 0.05),
            };
        })
        .sort((a, b) => b.score - a.score || a.start - b.start);
}

/**
 * Finds the best anchor for `query.text` in `content` (LF-normalised by the caller).
 * Returns null when there is nothing convincing: the caller must then mark the comment rather
 * than attach it to an arbitrary paragraph.
 */
export function findAnchor(content: string, query: AnchorQuery): AnchorMatch | null {
    const text = query.text;
    if (!text || text.trim().length === 0) return null;

    // 1. Exact occurrences (the common case, and the only one that needs no tolerance).
    const exact = occurrences(content, text).map(start => ({ start, end: start + text.length, kind: "exact" as AnchorKind }));
    if (exact.length === 1) {
        return { ...exact[0], score: 1 };
    }
    if (exact.length > 1) {
        const scored = rank(content, exact, query);
        const best = scored[0];
        // Identical text in identical surroundings: still usable, but only as a low-confidence
        // hit, because there is no evidence which occurrence the reader meant.
        const context = contextScore(content, best.start, best.end, query);
        return { ...best, score: context > 0 ? best.score : 0.55 };
    }

    // 2. Whitespace-tolerant match: "a  b\nc" still finds "a b c".
    const collapsedText = normaliseWhitespace(text);
    if (collapsedText.length >= 3) {
        const { collapsed, map } = collapseWithIndex(content);
        const loose = occurrences(collapsed, collapsedText).map(start => {
            // `map[i]` is the original index of collapsed character i, so the end offset is one
            // past the original index of the *last* matched character.
            const last = Math.min(start + collapsedText.length - 1, map.length - 1);
            return { start: map[start], end: map[last] + 1, kind: "loose" as AnchorKind };
        });
        if (loose.length) {
            const scored = rank(content, loose, query).filter(candidate => candidate.end > candidate.start);
            if (scored.length) {
                const best = scored[0];
                // Only trust it when the surrounding text agrees; otherwise it is a guess.
                const context = contextScore(content, best.start, best.end, query);
                if (scored.length === 1 && context === 0) return { ...best, score: 0.5 };
                if (context > 0) return { ...best, score: Math.min(0.95, best.score) };
            }
        }
    }

    return null;
}

/** Context to record alongside a new selection, so a later edit can still be resolved. */
export function captureContext(content: string, start: number, end: number): { prefix: string; suffix: string } {
    return {
        prefix: content.slice(Math.max(0, start - MAX_CONTEXT), start),
        suffix: content.slice(end, Math.min(content.length, end + MAX_CONTEXT)),
    };
}
