import { App, Notice } from "obsidian";
import { imageExtension, insertEmbeds, pastedImageName, toEmbed } from "./core/imageInsert";

/** The image files in a paste or drop; other kinds of content are left to the browser. */
function imageFiles(list: FileList | null | undefined): File[] {
    return Array.from(list ?? []).filter(file => imageExtension(file.type) !== null);
}

/**
 * Saves each image as an attachment of `sourcePath` (respecting the user's attachment folder
 * setting) and returns the embeds, in the user's preferred link format.
 */
async function saveImages(app: App, files: File[], sourcePath: string, fromClipboard: boolean): Promise<string[]> {
    const embeds: string[] = [];
    for (const file of files) {
        const extension = imageExtension(file.type) ?? "png";
        // A clipboard image is always called "image.png"; give it Obsidian's usual name instead.
        const name = fromClipboard || !file.name
            ? pastedImageName(new Date(), extension)
            : file.name;
        const path = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
        const saved = await app.vault.createBinary(path, await file.arrayBuffer());
        embeds.push(toEmbed(app.fileManager.generateMarkdownLink(saved, sourcePath)));
    }
    return embeds;
}

/**
 * Lets the user paste or drop images into the textarea, as in the note editor. `onChange`
 * receives the new value so the caller can keep its draft in sync.
 */
export function attachImagePaste(
    app: App,
    textarea: HTMLTextAreaElement,
    sourcePath: string,
    onChange: (value: string) => void,
): void {
    const handle = async (files: File[], fromClipboard: boolean) => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        try {
            const embeds = await saveImages(app, files, sourcePath, fromClipboard);
            if (!embeds.length) return;
            const next = insertEmbeds(textarea.value, start, end, embeds);
            textarea.value = next.value;
            textarea.focus();
            textarea.setSelectionRange(next.caret, next.caret);
            onChange(next.value);
        } catch (error) {
            console.error("SideNote: could not save the image", error);
            new Notice("SideNote: could not save the image. Check the console.");
        }
    };

    textarea.addEventListener("paste", (event: ClipboardEvent) => {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length) return;
        event.preventDefault();
        void handle(files, true);
    });

    textarea.addEventListener("dragover", (event: DragEvent) => {
        if (Array.from(event.dataTransfer?.items ?? []).some(item => item.kind === "file")) {
            event.preventDefault();
        }
    });

    textarea.addEventListener("drop", (event: DragEvent) => {
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void handle(files, false);
    });
}
