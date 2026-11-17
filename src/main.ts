import { App, MarkdownView, Notice, Plugin, PluginSettingTab, TFile, Editor } from "obsidian";
import { Comment, CommentManager } from "./commentManager";
import { buildMarkdownBlock as buildCommentMarkdownBlock } from "./core/markdownCommentBlocks";
import { SideNoteView } from "./SideNoteView";
import { SideNoteSettingTab } from "./SideNoteSettingTab";
import { createHighlightPlugin, forceUpdateEffect, EditorWithCM } from "./highlightPlugin";
import { switchToSideNoteView, generateHash, generateCommentId } from "./utils";
import { resolveCommentLinks, planAutomaticRepairs } from "./core/noteLinkResolver";
import type { LinkReport, ResolverDeps } from "./core/noteLinkResolver";
import { applyRelink, backupFileName, formatAuditRecord, setAttachHash } from "./core/linkRepairOps";
import type { AuditRecord, RelinkRepair } from "./core/linkRepairOps";
import { CommentLinkModal } from "./CommentLinkModal";
import { captureContext } from "./core/anchorResolver";
import { DEFAULT_SETTINGS } from "./types";
import type { CommentColor, PluginData, SideNoteSettings } from "./types";

export default class SideNote extends Plugin {
    commentManager: CommentManager;
    settings: SideNoteSettings;
    comments: Comment[] = [];
    private editorUpdateTimers: Record<string, number> = {};
    private readonly duplicateAddWindowMs = 800;
    private lastAddFingerprint: { key: string; at: number } | null = null;
    // Poll because external edits under .obsidian may not reliably emit a vault
    // modify event, even though SideNote still needs to reload data.json.
    private readonly dataReloadIntervalMs = 2000;
    // Remember the last loaded/saved data shape so unchanged polling ticks no-op.
    private lastDataFingerprint: string | null = null;
    // Avoid treating SideNote's own saveData() writes as external changes.
    private isSavingData = false;
    // Avoid overlapping reloads from the timer and vault modify event.
    private isReloadingData = false;

    // --- Comment link reconciliation (read-only stage) ---
    // `Comment.filePath` is only updated by the vault rename event, which Obsidian does not
    // emit when another program moves a note. Such comments stay listed but point at a path
    // that no longer exists. This stage only reports them; it writes nothing.
    // See docs/design-comment-link-recovery.md.
    private linkScanTimer: number | null = null;
    private isScanningLinks = false;
    private isApplyingRepairs = false;
    private missingLinkPaths = new Set<string>();
    private lastLinkScanAt = 0;
    // Give the vault index time to settle after start-up before the first scan.
    private readonly linkScanInitialDelayMs = 10 * 1000;
    private readonly linkScanIntervalMs = 3 * 60 * 1000;
    private readonly linkScanDebounceMs = 1500;

    private registerFreshSettingTab(): void {
        const appWithSettings = this.app as App & {
            setting?: { pluginTabs?: Record<string, PluginSettingTab> };
        };
        const pluginTabs = appWithSettings.setting?.pluginTabs;
        if (pluginTabs && pluginTabs[this.manifest.id]) {
            delete pluginTabs[this.manifest.id];
        }
        this.addSettingTab(new SideNoteSettingTab(this.app, this));
    }

    private normalizeCommentsFolderPath(raw: string): string | null {
        const trimmed = raw.trim() || DEFAULT_SETTINGS.markdownFolder;
        if (trimmed.startsWith('/') || trimmed.split('/').some(seg => seg === '..')) {
            return null;
        }
        return trimmed.replace(/^\/+|\/+$/g, "");
    }

    private async ensureCommentFolder(): Promise<string> {
        const raw = this.settings.markdownFolder;
        const normalized = this.normalizeCommentsFolderPath(raw);
        if (!normalized) {
            new Notice("SideNote: Invalid comments folder path. Using default.");
            return DEFAULT_SETTINGS.markdownFolder;
        }
        const exists = await this.app.vault.adapter.exists(normalized);
        if (!exists) {
            await this.app.vault.createFolder(normalized);
        }
        return normalized;
    }

    private getSideNoteFilePath(notePath: string): string {
        const raw = this.settings.markdownFolder;
        const normalized = this.normalizeCommentsFolderPath(raw) ?? DEFAULT_SETTINGS.markdownFolder;
        const base = notePath.replace(/\.md$/i, "").replace(/\//g, "__");
        return `${normalized}/${base}-sidenote.md`;
    }

    private async writeCommentToMarkdown(notePath: string, excerpt: string, body: string, commentId: string): Promise<string> {
        await this.ensureCommentFolder();
        const filePath = this.getSideNoteFilePath(notePath);
        const block = buildCommentMarkdownBlock(excerpt, body, commentId);

        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
            const content = await this.app.vault.read(existing);
            const updated = content.trim().length === 0 ? block : `${content}\n\n${block}`;
            await this.app.vault.modify(existing, updated);
        } else {
            await this.app.vault.create(filePath, `# Side Notes for ${notePath}\n\n${block}`);
        }

        return filePath;
    }

    async onload() {
        await this.loadPluginData();

        // Diagnostic: record which bundle is actually running. Without this there is no way to
        // tell from the outside whether a reload picked up the freshly built main.js.
        void this.writeBuildMarker();
        // Keep the plugin folder tidy even if no repair happens during this session.
        void this.pruneOldBackups();

        this.commentManager = new CommentManager(this.comments);
        this.applyHighlightColor();
        await this.migrateComments();

        this.registerEditorExtension([createHighlightPlugin(this)]);
        this.registerMarkdownPreviewHighlights();

        this.registerFreshSettingTab();

        this.registerView("sidenote-view", (leaf) => new SideNoteView(leaf, this));

        this.addCommand({
            id: "open-comment-view",
            name: "Open in Split View",
            callback: () => { void switchToSideNoteView(this.app); },
        });

        this.addCommand({
            id: "activate-view",
            name: "Open in Sidebar",
            callback: () => { this.activateView(); },
        });

        this.addCommand({
            id: "view-all-comments",
            name: "View all comments",
            icon: "list",
            callback: async () => {
                await this.activateView();
                this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
                    if (leaf.view instanceof SideNoteView) leaf.view.setShowAllNotes(true);
                });
            },
        });

        this.addCommand({
            id: "add-note-comment",
            name: "Add note comment",
            icon: "sticky-note",
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    new Notice("SideNote: No active file to comment on.");
                    return;
                }
                void this.openInlineNoteComment(file.path);
            },
        });

        this.addCommand({
            id: "add-comment-to-selection",
            name: "Add comment to selection",
            icon: "message-square",
            editorCallback: (editor, view) => {
                void this.openAddCommentModal(editor, view.file?.path, view);
            },
        });

        this.addCommand({
            id: "highlight-selection",
            name: "Highlight selection (without comment)",
            icon: "highlighter",
            editorCallback: (editor, view) => {
                void this.highlightSelection(editor, view.file?.path, view);
            },
        });

        this.addCommand({
            id: "scan-comment-links",
            name: "Scan for unattached comments",
            callback: () => { void this.scanCommentLinks(true); },
        });

        this.addCommand({
            id: "scan-and-repair-comment-links",
            name: "Scan and repair comment links",
            callback: () => { void this.openCommentLinkRepairModal(); },
        });

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                if (editor.somethingSelected()) {
                    menu.addItem((item) => {
                        item.setTitle("Add comment to selection")
                            .setIcon("message-square")
                            .onClick(() => this.openAddCommentModal(editor, view.file?.path, view));
                    });
                    menu.addItem((item) => {
                        item.setTitle("Highlight selection")
                            .setIcon("highlighter")
                            .onClick(() => this.highlightSelection(editor, view.file?.path, view));
                    });
                } else {
                    menu.addItem((item) => {
                        item.setTitle("Add note comment")
                            .setIcon("sticky-note")
                            .onClick(() => {
                                const file = view.file;
                                if (!file) return;
                                void this.openInlineNoteComment(file.path);
                            });
                    });
                }
            })
        );

        this.addRibbonIcon("message-square", "Side Note: Open in Sidebar", () => {
            this.activateView();
        });

        this.registerInterval(
            // External tools can update .obsidian/plugins/side-note/data.json
            // without Obsidian notifying this plugin, so poll as a fallback.
            window.setInterval(() => {
                void this.reloadDataFromDisk();
            }, this.dataReloadIntervalMs)
        );

        // The scan is the safety net, not the events: a note moved while Obsidian was closed
        // can never produce an event, so correctness must not depend on receiving one.
        this.app.workspace.onLayoutReady(() => {
            this.scheduleLinkScan(this.linkScanInitialDelayMs);
        });
        this.registerInterval(
            window.setInterval(() => {
                void this.scanCommentLinks();
            }, this.linkScanIntervalMs)
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async (leaf) => {
                if (leaf && leaf.view instanceof MarkdownView) {
                    const file = leaf.view.file;
                    // Recover comments whose selected text still exists but were left
                    // orphaned/stale in a previous session, so highlights reappear on open
                    // instead of only after the note is edited.
                    if (file instanceof TFile && file.extension === 'md' &&
                        this.commentManager.getCommentsForFile(file.path).length > 0) {
                        try {
                            const content = await this.app.vault.read(file);
                            const changed = this.commentManager.updateCommentCoordinatesForFile(content, file.path);
                            if (changed) await this.saveData();
                        } catch (error) {
                            console.error("Error recovering comment coordinates:", error);
                        }
                    }
                    this.app.workspace.getLeavesOfType("sidenote-view").forEach(sideNoteLeaf => {
                        if (sideNoteLeaf.view instanceof SideNoteView) {
                            sideNoteLeaf.view.updateActiveFile(file);
                        }
                    });
                    this.refreshEditorDecorations();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) {
                    this.commentManager.renameFile(oldPath, file.path);
                    void this.saveData();
                    this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
                        if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
                    });
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (file.path === '.obsidian/plugins/side-note/data.json' ||
                    (file instanceof TFile && file.name === 'data.json' && file.parent?.name === 'side-note')) {
                    try {
                        await this.reloadDataFromDisk();
                    } catch (error) {
                        console.error("Error reloading plugin data:", error);
                    }
                } else if (file instanceof TFile && file.extension === 'md') {
                    try {
                        const fileContent = await this.app.vault.read(file);
                        this.commentManager.updateCommentCoordinatesForFile(fileContent, file.path);
                        await this.saveData();
                        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
                            if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
                        });
                    } catch (error) {
                        console.error("Error updating comment coordinates:", error);
                    }
                }
            })
        );

        // Accelerators only: they shorten the delay before the next scan, they never decide.
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') this.scheduleLinkScan();
        }));
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile && file.extension === 'md') this.scheduleLinkScan();
        }));

        // Note: no editor-change handler here. The highlight plugin tracks positions via
        // ChangeSet.mapPos() (OT-style) in its own update() method, so periodic
        // forceUpdateEffect dispatches from editor-change are not needed and would reset
        // OT-tracked positions back to (potentially stale) comment manager coordinates.
    }

    async activateViewAndHighlightComment(commentId: string) {
        await this.activateView();
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) leaf.view.highlightComment(commentId);
        });
    }

    private createResolverDeps(): ResolverDeps {
        return {
            listNotes: () => this.app.vault.getMarkdownFiles().map(file => file.path),
            readNote: async (path: string) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile)) return null;
                try {
                    return await this.app.vault.cachedRead(file);
                } catch {
                    return null;
                }
            },
            hashText: (text: string) => generateHash(text),
            sizeOf: (path: string) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                return file instanceof TFile ? file.stat.size : null;
            },
            // Ask the file system, not the index: a watcher miss would otherwise hide a moved note.
            exists: (path: string) => this.app.vault.adapter.exists(path),
        };
    }

    /**
     * Works out which comments point at a note that no longer exists. The result is kept in
     * memory; writes only happen for repairs whose evidence is conclusive (autoRelink).
     */
    async scanCommentLinks(notify = false): Promise<LinkReport | null> {
        if (this.isScanningLinks) return null;
        this.isScanningLinks = true;
        try {
            let report = await this.resolveLinkReport();

            // Only conclusive evidence is applied without asking: a unique content-hash match
            // or a unique quoted-text match. A rename (different file name) is asked for unless
            // the user opted in, because it rewrites the link to a differently named note.
            const plan = this.settings.autoRelink
                ? planAutomaticRepairs(report, { includeRenames: this.settings.autoRelinkRenames })
                : [];
            if (plan.length) {
                const applied = await this.applyRepairsInternal(plan);
                if (applied) {
                    new Notice(`SideNote: automatically re-linked ${applied} comment(s).`);
                    report = await this.resolveLinkReport();
                }
            }

            this.missingLinkPaths = new Set(report.missing.map(result => result.path));
            this.lastLinkScanAt = Date.now();
            this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
                if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
            });
            if (notify) this.notifyLinkScanResult(report);
            return report;
        } catch (error) {
            console.error("SideNote: comment link scan failed", error);
            return null;
        } finally {
            this.isScanningLinks = false;
        }
    }

    private resolveLinkReport(): Promise<LinkReport> {
        return resolveCommentLinks(this.comments, this.createResolverDeps());
    }

    private notifyLinkScanResult(report: LinkReport): void {
        if (!report.missing.length) {
            new Notice("SideNote: every comment is linked to an existing note.");
            return;
        }
        const missingComments = this.getMissingLinkCount();
        new Notice(`SideNote: ${missingComments} comment(s) point at ${report.missing.length} missing note(s).`);
    }

    private scheduleLinkScan(delayMs = this.linkScanDebounceMs): void {
        if (this.linkScanTimer !== null) window.clearTimeout(this.linkScanTimer);
        this.linkScanTimer = window.setTimeout(() => {
            this.linkScanTimer = null;
            void this.scanCommentLinks();
        }, delayMs);
    }

    /** True when the note this comment points at could not be found. */
    isLinkMissing(filePath: string): boolean {
        return this.missingLinkPaths.has(filePath);
    }

    getMissingLinkCount(): number {
        if (!this.missingLinkPaths.size) return 0;
        return this.commentManager.getComments().filter(c => this.missingLinkPaths.has(c.filePath)).length;
    }

    getMissingLinkPaths(): string[] {
        return Array.from(this.missingLinkPaths);
    }

    getLastLinkScanAt(): number {
        return this.lastLinkScanAt;
    }

    /** Scan, then let the user pick new targets for the comments that lost their note. */
    async openCommentLinkRepairModal(): Promise<void> {
        const report = await this.scanCommentLinks();
        if (!report) return;
        if (!report.missing.length) {
            new Notice("SideNote: every comment is linked to an existing note.");
            return;
        }
        new CommentLinkModal(this.app, report, {
            onApply: (repairs: RelinkRepair[]) => this.applyLinkRepairs(repairs),
            onDeleteComments: (commentIds: string[]) => this.deleteCommentsByIds(commentIds),
        }).open();
    }

    /** Deletes comments that can no longer belong to anything; backs up first. */
    private async deleteCommentsByIds(commentIds: string[]): Promise<number> {
        if (!commentIds.length) return 0;
        const backup = await this.backupDataBeforeRepair();
        if (!backup) {
            new Notice("SideNote: could not write a backup, so nothing was deleted.");
            return 0;
        }

        const targets = new Set(commentIds);
        const before = this.comments.length;
        for (let i = this.comments.length - 1; i >= 0; i--) {
            if (targets.has(this.comments[i].id)) this.comments.splice(i, 1);
        }
        const removed = before - this.comments.length;
        if (!removed) return 0;

        this.commentManager.updateComments(this.comments);
        await this.saveData();
        await this.scanCommentLinks();
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
        });
        this.refreshEditorDecorations();
        return removed;
    }

    /**
     * Applies confirmed re-links. Writes only `filePath` (and the derived `commentPath`):
     * ids, quoted text, anchors and bodies are left exactly as they were.
     */
    async applyLinkRepairs(repairs: RelinkRepair[]): Promise<number> {
        const applied = await this.applyRepairsInternal(repairs);
        if (!applied) return 0;
        await this.scanCommentLinks();
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
        });
        this.refreshEditorDecorations();
        return applied;
    }

    /** Backup → rewrite filePath → re-hash → save → read back → audit. No rescan here. */
    private async applyRepairsInternal(repairs: RelinkRepair[]): Promise<number> {
        if (!repairs.length || this.isApplyingRepairs) return 0;

        this.isApplyingRepairs = true;
        try {
            // A repair without a backup must not happen at all.
            const backup = await this.backupDataBeforeRepair();
            if (!backup) {
                new Notice("SideNote: could not write a backup, so nothing was changed.");
                return 0;
            }

            // Mutate the array that saveData() persists. The comment manager can hold a
            // different array after a data reload, so writing through it would silently
            // update an array nobody saves.
            const comments = this.comments;
            const records: AuditRecord[] = [];
            let applied = 0;

            for (const repair of repairs) {
                const result = applyRelink(
                    comments,
                    repair.from,
                    repair.to,
                    notePath => this.getSideNoteFilePath(notePath),
                );
                if (!result.changed) continue;
                applied += result.changed;
                records.push({
                    at: new Date().toISOString(),
                    from: repair.from,
                    to: repair.to,
                    evidence: repair.evidence,
                    commentIds: result.affectedIds,
                    backup,
                });
            }

            if (!applied) return 0;

            console.info(
                "SideNote: repairing links",
                { comments: applied, sharedArray: this.comments === this.commentManager.getComments() },
            );

            // Re-hash the note each comment now points at, so a later rename can be matched
            // by content instead of by file name (evidence tier S2).
            await this.refreshAttachHashes(repairs.map(repair => repair.to));

            this.commentManager.updateComments(this.comments);
            await this.saveData();

            const saved = await this.dataFileContainsEvery(repairs.map(repair => repair.to));
            if (!saved) {
                console.error("SideNote: repair was applied in memory but data.json does not contain the new paths");
                new Notice("SideNote: the repair did not reach data.json. Check the console.");
                return 0;
            }

            await this.appendLinkAudit(records);
            return applied;
        } finally {
            this.isApplyingRepairs = false;
        }
    }

    /**
     * Keeps only the most recent timestamped backups. Only files this plugin created with the
     * `data.v1-backup-<stamp>.json` pattern are touched: `data.json` and the hand-made
     * `data.v1-backup.json` are never candidates for deletion.
     */
    private async pruneOldBackups(keep = 5): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            const folder = this.pluginFolder();
            const listing = await adapter.list(folder);
            const backups = listing.files
                .filter(file => /data\.v1-backup-\d{8}-\d{6}\.json$/.test(file))
                .sort();
            const excess = backups.slice(0, Math.max(0, backups.length - keep));
            for (const file of excess) {
                await adapter.remove(file);
                console.info("SideNote: pruned old backup", file);
            }
        } catch (error) {
            console.warn("SideNote: could not prune old backups", error);
        }
    }

    private async refreshAttachHashes(paths: string[]): Promise<void> {        for (const path of new Set(paths)) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;
            try {
                const content = await this.app.vault.cachedRead(file);
                setAttachHash(this.comments, path, await generateHash(content), new TextEncoder().encode(content).length);
            } catch (error) {
                // The hash is a matching aid, never a reason to fail a repair.
                console.warn("SideNote: could not record the note hash", path, error);
            }
        }
    }

    /** Reads data.json back and checks the repaired paths actually landed there. */
    private async dataFileContainsEvery(paths: string[]): Promise<boolean> {
        const target = `${this.pluginFolder()}/data.json`;
        try {
            const raw = await this.app.vault.adapter.read(target);
            const data = JSON.parse(raw) as { comments?: Array<{ filePath?: string }> };
            const stored = new Set((data.comments ?? []).map(comment => comment.filePath));
            return paths.every(path => stored.has(path));
        } catch (error) {
            console.error("SideNote: could not verify data.json after repair", error);
            return false;
        }
    }

    /** Where this plugin's own files live; manifest.dir is not always populated. */
    private pluginFolder(): string {
        if (this.manifest.dir) return this.manifest.dir;
        const configDir = this.app.vault.configDir || ".obsidian";
        return `${configDir}/plugins/${this.manifest.id}`;
    }

    /**
     * Writes the SHA-256 of the running bundle plus a timestamp, so a stale reload is visible
     * from disk instead of being guessed from behaviour.
     */
    private async writeBuildMarker(): Promise<void> {
        try {
            const folder = this.pluginFolder();
            const adapter = this.app.vault.adapter;
            const source = await adapter.read(`${folder}/main.js`);
            const marker = {
                loadedAt: new Date().toISOString(),
                version: this.manifest.version,
                mainJsSha256: await generateHash(source),
                autoRelink: this.settings.autoRelink,
            };
            await adapter.write(`${folder}/build-marker.json`, JSON.stringify(marker, null, 2));
        } catch (error) {
            console.warn("SideNote: could not write the build marker", error);
        }
    }

    /** Copies data.json beside itself before the first write of a repair batch. */
    private async backupDataBeforeRepair(): Promise<string | null> {
        const target = `${this.pluginFolder()}/${backupFileName(new Date())}`;
        try {
            const snapshot = JSON.stringify({ ...this.settings, comments: this.comments }, null, 2);
            await this.app.vault.adapter.write(target, snapshot);
            if (!(await this.app.vault.adapter.exists(target))) {
                console.error("SideNote: backup write reported success but the file is missing", target);
                return null;
            }
            console.info("SideNote: backed up data.json to", target);
            await this.pruneOldBackups();
            return target;
        } catch (error) {
            console.error("SideNote: could not back up data.json before repair", error);
            return null;
        }
    }

    private async appendLinkAudit(records: AuditRecord[]): Promise<void> {
        if (!records.length) return;
        const target = `${this.pluginFolder()}/link-repair.log`;
        const text = records.map(record => formatAuditRecord(record)).join("\n") + "\n";
        try {
            // Read + write instead of adapter.append(): append fails when the log file does
            // not exist yet, and silently losing the audit trail is worse than a full rewrite.
            const adapter = this.app.vault.adapter;
            const existing = (await adapter.exists(target)) ? await adapter.read(target) : "";
            await adapter.write(target, existing + text);
            console.info("SideNote: appended link repair audit", target);
        } catch (error) {
            console.error("SideNote: could not write the link repair log", error);
            new Notice("SideNote: repaired, but the audit log could not be written.");
        }
    }

    onunload() {
        if (this.linkScanTimer !== null) {
            window.clearTimeout(this.linkScanTimer);
            this.linkScanTimer = null;
        }
    }

    async activateView() {
        const { workspace } = this.app;

        const leaves = workspace.getLeavesOfType("sidenote-view");
        let leaf = leaves.length > 0 ? leaves[0] : null;

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({ type: "sidenote-view", active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
            if (leaf.view instanceof SideNoteView) {
                leaf.view.updateActiveFile(workspace.getActiveFile());
            }
        }
    }

    async onCommentsChanged(message: string) {
        await this.saveData();
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
        });
        this.refreshEditorDecorations();
        this.rerenderReadingViews();
        new Notice(message);
    }

    // Reading view highlights are added only when the page is rendered (by the
    // markdown post processor), so re-render open Reading views after a comment
    // changes; otherwise e.g. a new color shows up only after reopening the note.
    private rerenderReadingViews() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") {
                leaf.view.previewMode.rerender(true);
            }
        });
    }

    private createAddFingerprint(comment: Comment): string {
        return [
            comment.filePath,
            comment.startLine,
            comment.startChar,
            comment.endLine,
            comment.endChar,
            comment.selectedText,
            comment.comment,
        ].join("|");
    }

    async addComment(newComment: Comment, message = "Comment added!") {
        const now = Date.now();
        const fingerprint = this.createAddFingerprint(newComment);
        if (
            this.lastAddFingerprint &&
            this.lastAddFingerprint.key === fingerprint &&
            now - this.lastAddFingerprint.at < this.duplicateAddWindowMs
        ) {
            return;
        }
        this.lastAddFingerprint = { key: fingerprint, at: now };
        await this.recordAttachHash(newComment);
        this.commentManager.addComment(newComment);
        await this.onCommentsChanged(message);
    }

    /** Stamps the note's content hash onto a new comment (used later to recognise renames). */
    private async recordAttachHash(comment: Comment): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(comment.filePath);
        if (!(file instanceof TFile)) return;
        try {
            const content = await this.app.vault.cachedRead(file);
            comment.fileHashAtAttach = await generateHash(content);
            // Byte length, matching TFile.stat.size: character count differs for non-ASCII text
            // (a two-character Chinese word is 6 bytes), which would break the size prefilter.
            comment.fileSizeAtAttach = new TextEncoder().encode(content).length;
        } catch (error) {
            console.warn("SideNote: could not record the note hash for a new comment", error);
        }
    }

    async editComment(commentId: string, newCommentText: string) {
        this.commentManager.editComment(commentId, newCommentText);
        await this.onCommentsChanged("Comment updated!");
    }

    async deleteComment(commentId: string) {
        this.commentManager.deleteComment(commentId);
        await this.onCommentsChanged("Comment deleted!");
    }

    async resolveComment(commentId: string) {
        this.commentManager.resolveComment(commentId);
        await this.onCommentsChanged("Comment resolved!");
    }

    async unresolveComment(commentId: string) {
        this.commentManager.unresolveComment(commentId);
        await this.onCommentsChanged("Comment reopened!");
    }

    async setCommentColor(commentId: string, color: CommentColor | null) {
        this.commentManager.setCommentColor(commentId, color);
        await this.onCommentsChanged("Comment color changed!");
    }

    private async getSelectionTarget(editor: Editor, filePath: string | undefined, view?: unknown) {
        // In Live Preview, a selection inside a table cell comes from the cell's nested
        // editor, whose coordinates are relative to the cell. Obsidian mirrors that
        // selection onto the note's main editor, so read it from there instead.
        if (view instanceof MarkdownView && view.editor !== editor && view.editor.somethingSelected()) {
            editor = view.editor;
        }
        const selection = editor.getSelection();
        if (!selection?.trim() || !filePath) return null;
        const cursorStart = editor.getCursor("from");
        const cursorEnd = editor.getCursor("to");

        // Record a little of the surrounding text: it is what lets a moved paragraph be found
        // again after the note is edited (see core/anchorResolver.ts).
        const doc = editor.getValue();
        const lines = doc.split("\n");
        let offset = 0;
        for (let i = 0; i < cursorStart.line && i < lines.length; i++) offset += lines[i].length + 1;
        offset += cursorStart.ch;
        const { prefix, suffix } = captureContext(doc, offset, offset + selection.length);

        return {
            filePath,
            isNoteComment: false,
            selectedText: selection,
            selectedTextHash: await generateHash(selection),
            startLine: cursorStart.line,
            startChar: cursorStart.ch,
            endLine: cursorEnd.line,
            endChar: cursorEnd.ch,
            prefix,
            suffix,
        };
    }

    private async openAddCommentModal(editor: Editor, filePath: string | undefined, view?: unknown) {
        const target = await this.getSelectionTarget(editor, filePath, view);
        if (!target) {
            new Notice("Please select some text to add a comment.");
            return;
        }
        await this.activateView();
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) {
                leaf.view.openInlineNewComment(target);
            }
        });
    }

    // Adds a comment with an empty body so the selection is highlighted without
    // interrupting reading to type text.
    private async highlightSelection(editor: Editor, filePath: string | undefined, view?: unknown) {
        const target = await this.getSelectionTarget(editor, filePath, view);
        if (!target) {
            new Notice("Please select some text to highlight.");
            return;
        }
        await this.addComment({
            ...target,
            id: generateCommentId(),
            comment: "",
            timestamp: Date.now(),
            isOrphaned: false,
        }, "Highlight added!");
    }

    private async openInlineNoteComment(filePath: string): Promise<void> {
        await this.activateView();
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) {
                leaf.view.openInlineNewComment({
                    filePath,
                    isNoteComment: true,
                    selectedText: "",
                    selectedTextHash: "",
                    startLine: 0,
                    startChar: 0,
                    endLine: 0,
                    endChar: 0,
                });
            }
        });
    }

    private getDataFingerprint(data: PluginData): string {
        // Helper function for readability in code. //
        return JSON.stringify(data);
    }

    private async reloadDataFromDisk(): Promise<boolean> {
        // Skip reloads while saving or while another reload is in progress so
        // SideNote does not race with itself.
        if (this.isSavingData || this.isReloadingData || this.isApplyingRepairs) return false;

        this.isReloadingData = true;
        try {
            const loadedData: PluginData = Object.assign({}, { comments: [] }, DEFAULT_SETTINGS, await this.loadData());
            const fingerprint = this.getDataFingerprint(loadedData);
            if (fingerprint === this.lastDataFingerprint) return false;

            await this.loadPluginData();
            await this.migrateComments();
            this.commentManager.updateComments(this.comments);
            this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
                if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
            });
            this.refreshEditorDecorations();
            return true;
        } finally {
            this.isReloadingData = false;
        }
    }

    async loadPluginData() {
        const loadedData: PluginData = Object.assign({}, { comments: [] }, DEFAULT_SETTINGS, await this.loadData());
        this.settings = {
            commentSortOrder: loadedData.commentSortOrder || DEFAULT_SETTINGS.commentSortOrder,
            commentSortDescending: loadedData.commentSortDescending !== undefined
                ? loadedData.commentSortDescending
                : DEFAULT_SETTINGS.commentSortDescending,
            showHighlights: loadedData.showHighlights !== undefined ? loadedData.showHighlights : DEFAULT_SETTINGS.showHighlights,
            markdownFolder: loadedData.markdownFolder || DEFAULT_SETTINGS.markdownFolder,
            highlightColor: loadedData.highlightColor || DEFAULT_SETTINGS.highlightColor,
            highlightOpacity: loadedData.highlightOpacity !== undefined ? loadedData.highlightOpacity : DEFAULT_SETTINGS.highlightOpacity,
            highlightStyle: loadedData.highlightStyle || DEFAULT_SETTINGS.highlightStyle,
            showResolvedComments: loadedData.showResolvedComments !== undefined ? loadedData.showResolvedComments : DEFAULT_SETTINGS.showResolvedComments,
            allowEmptyComments: loadedData.allowEmptyComments !== undefined ? loadedData.allowEmptyComments : DEFAULT_SETTINGS.allowEmptyComments,
            autoRelink: loadedData.autoRelink !== undefined ? loadedData.autoRelink : DEFAULT_SETTINGS.autoRelink,
            autoRelinkRenames: loadedData.autoRelinkRenames !== undefined ? loadedData.autoRelinkRenames : DEFAULT_SETTINGS.autoRelinkRenames,
        };
        this.comments = loadedData.comments || [];
        if (this.commentManager) this.applyHighlightColor();
        this.lastDataFingerprint = this.getDataFingerprint(loadedData);
    }

    async migrateComments() {
        let needsSave = false;

        for (const comment of this.comments) {
            if (!comment.id) {
                comment.id = generateCommentId();
                needsSave = true;
            }
            if (!comment.selectedTextHash && comment.selectedText) {
                comment.selectedTextHash = await generateHash(comment.selectedText);
                needsSave = true;
            }
            if (comment.isOrphaned === undefined) {
                comment.isOrphaned = false;
                needsSave = true;
            }
            if (comment.isNoteComment === undefined) {
                comment.isNoteComment = false;
                needsSave = true;
            }
        }

        if (needsSave) await this.saveData();
    }

    async migrateInlineCommentsToMarkdown() {
        let changed = false;
        for (const comment of this.comments) {
            if (!comment.commentPath) {
                const path = await this.writeCommentToMarkdown(
                    comment.filePath, comment.selectedText, comment.comment, comment.id
                );
                comment.commentPath = path;
                changed = true;
            }
        }
        if (changed) await this.saveData();
    }

    private registerMarkdownPreviewHighlights() {
        // Runs in Reading view and also on blocks Live Preview renders as widgets
        // (e.g. table cells), where the CM6 decorations cannot reach the text.
        this.registerMarkdownPostProcessor((element, context) => {
            this.applyRenderedHighlights(element, context.sourcePath);
        });
    }

    private applyRenderedHighlights(element: HTMLElement, sourcePath: string) {
        // Unwrap highlights from a previous pass so this can be re-run on live DOM.
        const existing = element.querySelectorAll('.sidenote-highlight-preview');
        existing.forEach(span => span.replaceWith(...Array.from(span.childNodes)));
        if (existing.length) element.normalize();
        if (!this.settings.showHighlights) return;

        const comments = this.commentManager
            .getCommentsForFile(sourcePath)
            .filter(c => !c.isOrphaned && !!c.selectedText);

        if (!comments.length) return;

        const textNodes: Array<{ node: Text; start: number; end: number }> = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let offset = 0;

        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const value = node.nodeValue || "";
            if (!value.length) continue;
            textNodes.push({ node, start: offset, end: offset + value.length });
            offset += value.length;
        }

        const fullText = textNodes.map(t => t.node.nodeValue || "").join("");
        if (!fullText.length) return;

        const wraps: Array<{ start: number; end: number; comment: Comment }> = [];
        for (const comment of comments) {
            if (!comment.selectedText) continue;
            const idx = fullText.indexOf(comment.selectedText);
            if (idx !== -1) wraps.push({ start: idx, end: idx + comment.selectedText.length, comment });
        }

        if (!wraps.length) return;

        const findPos = (absolute: number): { node: Text; offsetInNode: number } | null => {
            for (const entry of textNodes) {
                if (absolute >= entry.start && absolute <= entry.end) {
                    return { node: entry.node, offsetInNode: absolute - entry.start };
                }
            }
            return null;
        };

        wraps.sort((a, b) => b.start - a.start);

        for (const wrap of wraps) {
            const startPos = findPos(wrap.start);
            const endPos = findPos(wrap.end);
            if (!startPos || !endPos) continue;

            try {
                const range = document.createRange();
                range.setStart(startPos.node, startPos.offsetInNode);
                range.setEnd(endPos.node, endPos.offsetInNode);

                const span = document.createElement('span');
                span.classList.add('sidenote-highlight', 'sidenote-highlight-preview');
                span.dataset.commentId = wrap.comment.id;
                if (wrap.comment.color) span.dataset.sidenoteColor = wrap.comment.color;
                span.addEventListener('click', (event: MouseEvent) => {
                    if (event.button !== 0) return;
                    void this.activateViewAndHighlightComment(wrap.comment.id);
                });
                span.addEventListener('contextmenu', () => { /* keep default */ });

                range.surroundContents(span);
            } catch (e) {
                console.warn('Failed to wrap preview highlight', e);
            }
        }
    }

    applyHighlightColor() {
        const root = document.documentElement;
        const { highlightColor: color, highlightOpacity: opacity, highlightStyle } = this.settings;
        const rgb = this.hexToRgb(color);

        // Per-comment colors in styles.css reuse this opacity with their own RGB.
        root.style.setProperty('--sidenote-highlight-opacity', String(opacity));
        root.style.setProperty('--sidenote-highlight-color', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
        root.style.setProperty('--sidenote-highlight-hover', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)})`);
        root.style.setProperty('--sidenote-highlight-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)})`);
        root.style.setProperty('--sidenote-orphaned-color', `rgba(255, 100, 100, ${opacity})`);
        root.style.setProperty('--sidenote-orphaned-hover', `rgba(255, 100, 100, ${Math.min(opacity + 0.15, 1)})`);
        root.style.setProperty('--sidenote-orphaned-border', `rgba(255, 100, 100, ${Math.min(opacity + 0.35, 1)})`);
        root.setAttribute('data-sidenote-highlight-style', highlightStyle);

        this.refreshEditorDecorations();
    }

    hexToRgb(hex: string): { r: number; g: number; b: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
            : { r: 255, g: 200, b: 0 };
    }

    async saveData() {
        const dataToSave: PluginData = { ...this.settings, comments: this.comments };
        this.isSavingData = true;
        try {
            await super.saveData(dataToSave);
            this.lastDataFingerprint = this.getDataFingerprint(dataToSave);
            this.refreshEditorDecorations();
        } finally {
            this.isSavingData = false;
        }
    }

    refreshEditorDecorations() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as unknown as EditorWithCM).cm;
                if (cm?.dispatch) {
                    cm.dispatch({ effects: [forceUpdateEffect.of(null)] });
                }
                // Live Preview renders tables as widgets whose cells are only post-processed
                // when the table re-renders, so refresh their highlights directly. Skip the
                // wrapper of a cell currently being edited (it hosts a nested editor).
                const file = leaf.view.file;
                if (file) {
                    leaf.view.contentEl
                        .querySelectorAll<HTMLElement>('.cm-table-widget .table-cell-wrapper')
                        .forEach(cellEl => {
                            if (!cellEl.querySelector('.cm-editor')) this.applyRenderedHighlights(cellEl, file.path);
                        });
                }
            }
        });
    }
}
