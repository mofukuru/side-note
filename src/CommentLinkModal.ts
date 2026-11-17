import { App, Modal, Notice, SuggestModal, TFile } from "obsidian";
import type { BulkProposal, FileLinkResult, LinkReport } from "./core/noteLinkResolver";
import type { RelinkRepair } from "./core/linkRepairOps";
import { repairsFromBulk } from "./core/linkRepairOps";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";

// Review UI for P0-2. One click on a candidate re-links the comments right away: the click is
// the confirmation, so there is no separate "select then scroll down and apply" step. Every
// write is still preceded by a backup (see main.ts) and recorded in link-repair.log.

export interface CommentLinkHandlers {
    /** Applies the repairs and returns how many comments were re-linked. */
    onApply(repairs: RelinkRepair[]): Promise<number>;
    /** Deletes comments whose note is gone; returns how many were removed. */
    onDeleteComments?(commentIds: string[]): Promise<number>;
}

function evidenceLabel(evidence: string): string {
    switch (evidence) {
        case "S2": return "content hash matches";
        case "S3": return "quoted text found";
        case "S4": return "same file name only";
        case "S5": return "note comment, same file name";
        case "S6": return "folder moved";
        case "S7": return "note deleted or renamed outside Obsidian";
        default: return evidence;
    }
}

/** Full-text note picker, used when the scan found no candidate (e.g. an external rename). */
class NoteSuggestModal extends SuggestModal<TFile> {
    private readonly onPick: (file: TFile) => void;

    constructor(app: App, onPick: (file: TFile) => void) {
        super(app);
        this.onPick = onPick;
        this.setPlaceholder("Pick the note this comment belongs to…");
    }

    getSuggestions(query: string): TFile[] {
        const needle = query.toLowerCase();
        const files = this.app.vault.getMarkdownFiles();
        if (!needle) return files.slice(0, 50);
        return files.filter(file => file.path.toLowerCase().includes(needle)).slice(0, 50);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.createDiv({ text: file.basename });
        el.createEl("small", { text: file.path, cls: "sidenote-link-suggestion-path" });
    }

    onChooseSuggestion(file: TFile): void {
        this.onPick(file);
    }
}

export class CommentLinkModal extends Modal {
    private readonly report: LinkReport;
    private readonly handlers: CommentLinkHandlers;
    /** Paths handled in this session; their rows disappear once applied. */
    private readonly done = new Map<string, string>();
    private busy = false;

    constructor(app: App, report: LinkReport, handlers: CommentLinkHandlers) {
        super(app);
        this.report = report;
        this.handlers = handlers;
    }

    onOpen(): void {
        this.modalEl.addClass("sidenote-link-modal");
        this.render();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async applyTo(result: FileLinkResult, to: string): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            const applied = await this.handlers.onApply([{
                from: result.path,
                to,
                evidence: result.evidence,
            }]);
            if (applied > 0) {
                this.done.set(result.path, to);
                new Notice(`SideNote: re-linked ${applied} comment(s).`);
            }
        } catch (error) {
            console.error("SideNote: link repair failed", error);
            new Notice("SideNote: could not repair the links. See the console for details.");
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async applyBulk(proposal: BulkProposal): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            const repairs = repairsFromBulk(proposal.moves);
            const applied = await this.handlers.onApply(repairs);
            if (applied > 0) {
                proposal.moves.forEach(move => this.done.set(move.oldPath, move.newPath));
                new Notice(`SideNote: re-linked ${applied} comment(s).`);
            }
        } catch (error) {
            console.error("SideNote: bulk repair failed", error);
            new Notice("SideNote: could not repair the links. See the console for details.");
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "Unattached comments" });

        const pending = this.report.missing.filter(result => !this.done.has(result.path));

        if (!pending.length && !this.done.size) {
            contentEl.createEl("p", { text: "Nothing to review: every comment is linked to an existing note." });
            this.renderFooter();
            return;
        }

        if (this.done.size) {
            const doneBox = contentEl.createDiv("sidenote-link-done");
            doneBox.createEl("h3", { text: "Handled in this session" });
            this.done.forEach((to, from) => {
                doneBox.createEl("small", { text: `${from} → ${to}`, cls: "sidenote-link-target" });
            });
        }

        if (pending.length) {
            const commentCount = pending.reduce((sum, result) => sum + result.commentIds.length, 0);
            contentEl.createEl("p", {
                text: `${commentCount} comment(s) point at ${pending.length} note(s) that no longer exist. ` +
                    "Clicking a note applies the change immediately; a backup of data.json is written first.",
                cls: "sidenote-link-summary",
            });

            const visible = new Set(pending.map(result => result.path));
            if (this.report.bulk.length) this.renderBulk(visible);
            pending.forEach(result => this.renderRow(result));
        }

        this.renderFooter();
    }

    private renderBulk(visible: Set<string>): void {
        const shown = this.report.bulk.filter(proposal =>
            proposal.moves.some(move => visible.has(move.oldPath)));
        if (!shown.length) return;

        const section = this.contentEl.createDiv("sidenote-link-bulk");
        section.createEl("h3", { text: "Folders moved as a whole" });
        shown.forEach(proposal => {
            const row = section.createDiv("sidenote-link-bulk-row");
            row.createDiv({
                text: `${proposal.moves.length} note(s): ${proposal.oldFolder || "(vault root)"} → ${proposal.newFolder}`,
                cls: "sidenote-link-bulk-text",
            });
            const button = row.createEl("button", {
                text: `Re-link all ${proposal.moves.length}`,
                cls: "mod-cta",
            });
            button.disabled = this.busy;
            button.addEventListener("click", () => { void this.applyBulk(proposal); });
        });
    }

    private renderRow(result: FileLinkResult): void {
        const row = this.contentEl.createDiv("sidenote-link-row");

        const head = row.createDiv("sidenote-link-head");
        head.createDiv({ text: result.path, cls: "sidenote-link-path" });
        head.createEl("small", {
            text: `${result.commentIds.length} comment(s) · ${evidenceLabel(result.evidence)}`,
            cls: "sidenote-link-meta",
        });
        if (result.evidence === "S7") {
            head.createEl("small", {
                text: "This note no longer exists, so there is nothing to match against. " +
                    "Pick the note by hand, or delete the comments if they are no longer meaningful.",
                cls: "sidenote-link-hint",
            });
        }

        const actions = row.createDiv("sidenote-link-actions");

        result.candidates.forEach(candidate => {
            const button = actions.createEl("button", {
                text: candidate.path.split("/").pop() ?? candidate.path,
                cls: "mod-cta",
            });
            button.setAttribute("title", `Re-link ${result.commentIds.length} comment(s) to ${candidate.path}`);
            button.disabled = this.busy;
            button.addEventListener("click", () => { void this.applyTo(result, candidate.path); });
        });

        const picker = actions.createEl("button", { text: "Choose note…" });
        picker.disabled = this.busy;
        picker.addEventListener("click", () => {
            new NoteSuggestModal(this.app, file => { void this.applyTo(result, file.path); }).open();
        });

        const ignore = actions.createEl("button", { text: "Ignore" });
        ignore.addEventListener("click", () => {
            this.done.set(result.path, "(ignored)");
            this.render();
        });

        if (this.handlers.onDeleteComments) {
            const remove = actions.createEl("button", { text: "Delete comments", cls: "mod-warning" });
            remove.addEventListener("click", () => {
                new ConfirmDeleteModal(this.app, async () => {
                    const removed = await this.handlers.onDeleteComments?.(result.commentIds) ?? 0;
                    new Notice(`SideNote: deleted ${removed} comment(s).`);
                    this.done.set(result.path, "(deleted)");
                    this.render();
                }, {
                    title: "Delete unattached comments",
                    message: `Delete ${result.commentIds.length} comment(s) that point at a note which no longer exists? ` +
                        "The comment text is lost; a backup of data.json is written first.",
                }).open();
            });
        }
    }

    private renderFooter(): void {
        const footer = this.contentEl.createDiv("sidenote-modal-footer");
        const close = footer.createEl("button", { text: "Close", cls: "sidenote-modal-cancel-btn" });
        close.addEventListener("click", () => this.close());
    }
}
