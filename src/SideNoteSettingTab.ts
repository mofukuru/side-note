import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SideNote from "./main";
import { SideNoteView } from "./SideNoteView";

export class SideNoteSettingTab extends PluginSettingTab {
    plugin: SideNote;

    constructor(app: App, plugin: SideNote) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Comment sort order")
            .setDesc("Choose how comments are sorted in the custom view.")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("timestamp", "By timestamp")
                    .addOption("position", "By position in file")
                    .setValue(this.plugin.settings.commentSortOrder)
                    .onChange(async (value: "timestamp" | "position") => {
                        this.plugin.settings.commentSortOrder = value;
                        await this.plugin.saveData();
                        this.rerenderViews();
                    })
            );

        new Setting(containerEl)
            .setName("Reverse sort order")
            .setDesc("Show comments in descending order (newest first / bottom of file first).")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.commentSortDescending)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.commentSortDescending = value;
                        await this.plugin.saveData();
                        this.rerenderViews();
                    })
            );

        new Setting(containerEl)
            .setName("Show highlights in editor")
            .setDesc("Display highlights for commented text in the editor. After changing this setting, please restart Obsidian to see the effect.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showHighlights)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.showHighlights = value;
                        await this.plugin.saveData();
                        this.plugin.refreshEditorDecorations();
                    })
            );

        new Setting(containerEl)
            .setName("Show resolved comments")
            .setDesc("Display resolved comments in the sidebar (shown dimmed). Uncheck to hide resolved comments entirely.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showResolvedComments)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.showResolvedComments = value;
                        await this.plugin.saveData();
                        this.rerenderViews();
                    })
            );

        new Setting(containerEl)
            .setName("Allow empty comments")
            .setDesc("Allow saving a comment on selected text without any comment text, so it acts as a plain highlight. The \"Highlight selection\" command always creates one instantly.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.allowEmptyComments)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.allowEmptyComments = value;
                        await this.plugin.saveData();
                    })
            );

        new Setting(containerEl)
            .setName("Re-link comments automatically")
            .setDesc("When a note is moved and exactly one candidate matches by content hash or by the quoted text, update the comment's link without asking. Ambiguous cases still wait for you.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoRelink)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.autoRelink = value;
                        await this.plugin.saveData();
                    })
            );

        new Setting(containerEl)
            .setName("Re-link after a rename too")
            .setDesc("On by default: when a note is renamed outside Obsidian and its content still matches exactly, the link follows it without asking. Turn this off if you would rather confirm every rename by hand, or if several devices share this vault.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoRelinkRenames)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.autoRelinkRenames = value;
                        await this.plugin.saveData();
                    })
            );

        new Setting(containerEl)
            .setName("Highlight color")
            .setDesc("Choose the color for highlighted comments in the editor")
            .addColorPicker((colorPicker) =>
                colorPicker
                    .setValue(this.plugin.settings.highlightColor || "#FFC800")
                    .onChange(async (value: string) => {
                        this.plugin.settings.highlightColor = value;
                        await this.plugin.saveData();
                        this.plugin.applyHighlightColor();
                    })
            );

        new Setting(containerEl)
            .setName("Highlight opacity")
            .setDesc("Set the transparency of the highlight (0 = transparent, 1 = opaque)")
            .addSlider((slider) =>
                slider
                    .setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.highlightOpacity || 0.2)
                    .onChange(async (value: number) => {
                        this.plugin.settings.highlightOpacity = value;
                        await this.plugin.saveData();
                        this.plugin.applyHighlightColor();
                    })
            );

        new Setting(containerEl)
            .setName("Highlight style")
            .setDesc("Choose how commented text is marked in the editor")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("both", "Underline + Background")
                    .addOption("background", "Background only")
                    .addOption("underline", "Underline only")
                    .addOption("dashed", "Dashed underline only")
                    .addOption("wavy", "Wavy underline only")
                    .setValue(this.plugin.settings.highlightStyle || "both")
                    .onChange(async (value: string) => {
                        this.plugin.settings.highlightStyle = value as typeof this.plugin.settings.highlightStyle;
                        await this.plugin.saveData();
                        this.plugin.applyHighlightColor();
                    })
            );

        new Setting(containerEl)
            .setName("Markdown comments folder")
            .setDesc("Folder (relative to vault) where sidenote markdown backup files are stored")
            .addText((text) =>
                text
                    .setPlaceholder("side-note-comments")
                    .setValue(this.plugin.settings.markdownFolder || "")
                    .onChange(async (value) => {
                        this.plugin.settings.markdownFolder = value.trim() || "side-note-comments";
                        await this.plugin.saveData();
                    })
            );

        new Setting(containerEl)
            .setName("Create Markdown Backup")
            .setDesc("Export all comments to markdown files in the configured folder")
            .addButton((button) =>
                button
                    .setButtonText("Create Backup")
                    .onClick(async () => {
                        await this.plugin.migrateInlineCommentsToMarkdown();
                        new Notice("Markdown backup created successfully!");
                    })
            );

        const orphanedCount = this.plugin.commentManager.getOrphanedCommentCount();

        new Setting(containerEl)
            .setName("Orphaned comments")
            .setDesc(`There are ${orphanedCount} orphaned comment(s). These are comments whose original text was deleted.`);

        new Setting(containerEl)
            .addButton((button) =>
                button
                    .setButtonText(`Delete ${orphanedCount} orphaned comment(s)`)
                    .setWarning()
                    .onClick(async () => {
                        const deleted = this.plugin.commentManager.deleteOrphanedComments();
                        await this.plugin.saveData();
                        this.rerenderViews();
                        new Notice(`Deleted ${deleted} orphaned comment(s)!`);
                        this.display();
                    })
                    .setDisabled(orphanedCount === 0)
            );

        // A different failure from "orphaned": the note itself is gone, so there is no text
        // to search for. Reported only; repairing links comes in a later step.
        const missingLinkCount = this.plugin.getMissingLinkCount();
        const lastScanAt = this.plugin.getLastLinkScanAt();
        const lastScanText = lastScanAt
            ? ` Last scan: ${new Date(lastScanAt).toLocaleTimeString()}.`
            : " Not scanned yet.";

        new Setting(containerEl)
            .setName("Unattached comments")
            .setDesc(missingLinkCount === 0
                ? `No comment points at a missing note.${lastScanText}`
                : `${missingLinkCount} comment(s) point at a note that no longer exists. ` +
                  `This happens when a note is moved or deleted outside Obsidian. ` +
                  `Repairing them is not implemented yet — this is a read-only report.${lastScanText}`)
            .addButton((button) =>
                button
                    .setButtonText("Rescan")
                    .onClick(async () => {
                        await this.plugin.scanCommentLinks(true, { autoApply: false });
                        this.display();
                    })
            )
            .addButton((button) =>
                button
                    .setButtonText("Review and repair…")
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.openCommentLinkRepairModal();
                        this.display();
                    })
            );
    }

    private rerenderViews() {
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) {
                leaf.view.renderComments();
            }
        });
    }
}
