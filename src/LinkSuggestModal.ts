import { App, FuzzySuggestModal, TFile } from "obsidian";
import { endsWithLinkTrigger, insertLinkAtTrigger } from "./core/linkInsert";

/** Lists every file in the vault, the same set Obsidian's own `[[` suggestion offers. */
class LinkSuggestModal extends FuzzySuggestModal<TFile> {
    private chosen = false;

    constructor(
        app: App,
        private readonly onChoose: (file: TFile) => void,
        private readonly onDismiss: () => void,
    ) {
        super(app);
        this.setPlaceholder("Type to search for a note to link");
    }

    getItems(): TFile[] {
        return this.app.vault.getFiles();
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChooseItem(file: TFile): void {
        this.chosen = true;
        this.onChoose(file);
    }

    onClose(): void {
        super.onClose();
        // onClose runs before onChooseItem, so wait a tick to know whether a file was picked.
        window.setTimeout(() => {
            if (!this.chosen) this.onDismiss();
        }, 0);
    }
}

/**
 * Opens a note picker when `[[` is typed into the textarea, and completes the link with the
 * chosen file. `onChange` receives the new value so the caller can keep its draft in sync.
 */
export function attachLinkSuggest(
    app: App,
    textarea: HTMLTextAreaElement,
    sourcePath: string,
    onChange: (value: string) => void,
): void {
    textarea.addEventListener("input", (event) => {
        // Only react to typing, not to deleting back to an existing "[[".
        const inputType = (event as InputEvent).inputType ?? "";
        if (!inputType.startsWith("insert")) return;

        const caret = textarea.selectionStart;
        if (caret !== textarea.selectionEnd || !endsWithLinkTrigger(textarea.value, caret)) return;

        new LinkSuggestModal(
            app,
            (file) => {
                const linkText = app.metadataCache.fileToLinktext(file, sourcePath, true);
                const next = insertLinkAtTrigger(textarea.value, caret, linkText);
                textarea.value = next.value;
                textarea.focus();
                textarea.setSelectionRange(next.caret, next.caret);
                onChange(next.value);
            },
            () => {
                textarea.focus();
                textarea.setSelectionRange(caret, caret);
            },
        ).open();
    });
}
