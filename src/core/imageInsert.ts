// Text handling for images pasted or dropped into the comment box (#48).
//
// Pure module: no `obsidian` import, tested by tests/imageInsert.test.ts.

const EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
};

/** File extension for an image MIME type, or null when Obsidian cannot display it. */
export function imageExtension(mimeType: string): string | null {
    return EXTENSIONS[mimeType.toLowerCase()] ?? null;
}

/**
 * Name for an image that came from the clipboard, following Obsidian's own
 * "Pasted image 20261124153045.png" (local time).
 */
export function pastedImageName(now: Date, extension: string): string {
    const pad = (value: number) => value.toString().padStart(2, "0");
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join("");
    return `Pasted image ${stamp}.${extension}`;
}

/** Makes a generated link an embed, whichever link format the user prefers. */
export function toEmbed(link: string): string {
    return link.startsWith("!") ? link : `!${link}`;
}

/**
 * Replaces the selection [start, end) with the embeds, one per line, and returns the new value
 * and caret. Line breaks are added only where the embed would otherwise touch other text.
 */
export function insertEmbeds(
    value: string,
    start: number,
    end: number,
    embeds: string[],
): { value: string; caret: number } {
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const trail = after && !after.startsWith("\n") ? "\n" : "";
    const inserted = `${lead}${embeds.join("\n")}${trail}`;
    return { value: before + inserted + after, caret: before.length + inserted.length };
}
