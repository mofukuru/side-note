import { App, Modal } from "obsidian";

export class ConfirmDeleteModal extends Modal {
    private readonly onConfirm: () => void;
    private readonly title: string;
    private readonly message: string;

    constructor(
        app: App,
        onConfirm: () => void,
        options: { title?: string; message?: string } = {},
    ) {
        super(app);
        this.onConfirm = onConfirm;
        this.title = options.title ?? "Delete comment";
        this.message = options.message ?? "Are you sure you want to delete this comment? This action cannot be undone.";
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass("sidenote-confirm-modal");

        contentEl.createEl("h2", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        const footer = contentEl.createDiv("sidenote-modal-footer");

        const cancelButton = footer.createEl("button", {
            text: "Cancel",
            cls: "sidenote-modal-cancel-btn"
        });
        cancelButton.onclick = () => this.close();

        const deleteButton = footer.createEl("button", {
            text: "Delete",
            cls: "mod-warning sidenote-modal-submit-btn"
        });
        deleteButton.onclick = () => {
            this.onConfirm();
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}
