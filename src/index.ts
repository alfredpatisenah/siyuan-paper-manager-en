import { validateCitekeyFormat } from "./core/naming";
import { openConnectorMetadataDialog, openMetadataDialog } from "./ui/dialogs/edit-metadata";
import { disposeCnkiClient } from "./services/cnki-desktop";
import { Dialog, Plugin, confirm, getFrontend, showMessage } from "siyuan";
import { ATTR, PLUGIN_NAME } from "./constants";
import { canUseNode, getPluginTempDir } from "./core/env";
import { KernelClient } from "./core/kernel";
import { StatusStore } from "./core/status";
import { TemplateService } from "./core/templates";
import { ConnectorServer } from "./server/connector-server";
import { buildEnvironmentReport } from "./services/environment-check";
import { ItemProcessor } from "./services/item-processor";
import { syncDocumentTags } from "./services/document-tags";
import { SettingsStore } from "./services/settings-store";
import { TranslatorService } from "./services/translator";
import { LibraryService } from "./services/library-service";
import type { PluginSettings } from "./types/settings";
import { openDuplicateResolutionDialog } from "./ui/dialogs/duplicate";
import { openImportPdfDialog } from "./ui/dialogs/import-pdf";
import { registerPaperUi } from "./ui/commands";
import { escapeHtml } from "./ui/dom";
import { SettingsPanel } from "./ui/settings";
import { mountTranslationStatusBar } from "./ui/statusbar";
import { openOnboardingDialog } from "./ui/dialogs/onboarding";
import { openBatchTranslationDialog } from "./ui/dialogs/batch-translation";
import { openCitationExportDialog } from "./ui/dialogs/export-citations";
import { LibraryMembershipService } from "./services/library-membership";
import { monitorLibraryMembership } from "./ui/library-membership-monitor";
import { errorMessage } from "./core/errors";

export default class PaperManagerPlugin extends Plugin {
  private readonly kernelClient = new KernelClient();
  private readonly statusStore = new StatusStore();
  private settingsStore!: SettingsStore;
  private settings!: PluginSettings;
  private settingsPanel!: SettingsPanel;
  private templates!: TemplateService;
  private processor!: ItemProcessor;
  private libraries!: LibraryService;
  private translator: TranslatorService | null = null;
  private connector: ConnectorServer | null = null;
  private connectorQueue: Promise<void> = Promise.resolve();
  private readonly documentKinds = new Map<string, "paper" | "library">();
  private cleanup: Array<() => void> = [];

  async onload(): Promise<void> {
    console.log(`[paper-manager] onload (${getFrontend()})`);
    this.settingsStore = new SettingsStore(this);
    this.settings = await this.settingsStore.load();
    this.templates = new TemplateService(this.kernelClient, {
      getDefaultDocumentTag: () => this.settings.defaultDocumentTag,
      onModeChange: (templateMode) => this.statusStore.update({ templateMode }),
    });
    this.libraries = new LibraryService(this.kernelClient);
    this.processor = new ItemProcessor(
      this.kernelClient,
      this.templates,
      () => this.settings,
      openDuplicateResolutionDialog,
      this.libraries,
    );
    if (canUseNode()) {
      this.translator = new TranslatorService(this.kernelClient, {
        onState: (translation) => this.statusStore.update({ translation }),
        readPaper: (docId) => this.libraries.readPaper(docId),
        withPaperLock: work => this.processor.runMembershipChange(work),
        persist: (docId, paper) => this.processor.persistAndRefresh(docId, paper),
        getSecret: (name) => this.getSecret(name),
      });
    }
    this.settingsPanel = new SettingsPanel(
      "Paper Manager",
      () => this.settings,
      this.kernelClient,
      this.libraries,
      (settings) => this.updateSettings(settings),
      (name) => this.getSecret(name),
    );
    this.setting = this.settingsPanel.setting;
    await this.refreshDocumentKinds();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshKinds = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void this.refreshDocumentKinds().catch(error => console.warn("[paper-manager] Failed to refresh library menu index", error));
      }, 100);
    };
    this.eventBus.on("ws-main", refreshKinds);
    this.cleanup.push(() => { clearTimeout(refreshTimer); this.eventBus.off("ws-main", refreshKinds); });
    this.cleanup.push(registerPaperUi(this, {
      importPdf: () => openImportPdfDialog(this.processor, () => this.settings),
      translate: (docId) => this.translate(docId),
      repair: (docId) => this.repair(docId),
      editMetadata: async (docId) => {
        const paper = await this.libraries.readPaper(docId);
        await openMetadataDialog(paper, () => this.settings,
          (draft, citekey, attachments) => this.processor.editMetadata(docId, paper.canonical, draft, { baseline: paper.citekey, value: citekey }, attachments),
          await this.libraries.citekeys(paper.libraryId, docId));
      },
      translateLibrary: (docId) => this.translateLibrary(docId),
      exportLibrary: (docId) => openCitationExportDialog(this.libraries, docId),
      openSettings: () => this.settingsPanel.open(),
      selfCheck: () => this.selfCheck(),
      toggleConnector: () => this.toggleConnector(),
      getStatus: () => this.statusStore.get(),
      detectDocKind: (docId) => this.documentKinds.get(docId) ?? null,
    }));
    if (canUseNode()) this.cleanup.push(mountTranslationStatusBar(this, this.statusStore));
    this.cleanup.push(monitorLibraryMembership(this, new LibraryMembershipService(this.kernelClient, this.templates), this.processor));
    if (canUseNode() && this.settings.autoListen) void this.startConnector();
  }

  onLayoutReady(): void {
    const timer = setTimeout(() => { void this.ensureOnboarding(); }, 500);
    this.cleanup.push(() => clearTimeout(timer));
  }

  onunload(): void {
    disposeCnkiClient();
    console.log("[paper-manager] onunload");
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.translator?.cancel();
    if (this.connector) void this.connector.stop();
    this.connector = null;
  }

  private async updateSettings(next: PluginSettings): Promise<void> {
    validateCitekeyFormat(next.citekeyFormat);
    const restart = next.zoteroPort !== this.settings.zoteroPort || next.autoListen !== this.settings.autoListen;
    if (/[,，#\r\n]/u.test(next.defaultDocumentTag)) throw new Error("Default tag must be a single tag name without #, commas, or line breaks; leave empty to disable.");
    await this.processor.runMembershipChange(async () => {
      await this.settingsStore.save(next);
      this.settings = next;
      await syncDocumentTags(this.kernelClient, next.defaultDocumentTag);
    });
    if (restart && canUseNode()) await this.restartConnector(next.autoListen);
  }

  private async ensureOnboarding(): Promise<void> {
    try {
      const libraries = await this.libraries.discoverLibraries();
      const current = libraries.find((library) => library.docId === this.settings.defaultLibraryDocId);
      if (current) {
        if (!this.settings.onboardingCompleted) {
          await this.updateSettings({ ...this.settings, onboardingCompleted: true });
        }
        return;
      }
      if (libraries.length) {
        await this.updateSettings({
          ...this.settings,
          defaultLibraryDocId: libraries[0]!.docId,
          onboardingCompleted: true,
        });
        return;
      }
      await openOnboardingDialog(this.kernelClient, this.libraries, async (library) => {
        await this.updateSettings({ ...this.settings, defaultLibraryDocId: library.docId, onboardingCompleted: true });
      });
    } catch (error) {
      showMessage(`Failed to initialize the library: ${errorMessage(error)}`, 7000, "error");
    }
  }

  private async startConnector(): Promise<void> {
    if (this.connector) return;
    if (!canUseNode()) {
      const message = "Connector is only supported in the SiYuan desktop client with Node integration";
      this.statusStore.update({ connector: { state: "error", message } });
      return;
    }
    try {
      const connector = new ConnectorServer({
        port: this.settings.zoteroPort,
        tempDirectory: getPluginTempDir(PLUGIN_NAME),
        onImport: (candidate) => this.confirmConnectorImport(candidate),
        onAdditionalAttachments: (docId, attachments) => this.processor.addAttachments(docId, attachments),
        onStatus: (status) => this.statusStore.update({
          connector: status.error
            ? { state: "error", message: status.error }
            : status.listening
              ? { state: "listening", port: status.port }
              : { state: "stopped" },
        }),
        onProtocolError: (message) => showMessage(`Zotero Connector: ${message}`, 5000, "error"),
      });
      await connector.start();
      this.connector = connector;
    } catch (error) {
      const message = errorMessage(error);
      this.statusStore.update({ connector: { state: "error", message } });
      showMessage(`Connector failed to start: ${message}`, 7000, "error");
    }
  }

  private async stopConnector(): Promise<void> {
    if (!this.connector) {
      this.statusStore.update({ connector: { state: "stopped" } });
      return;
    }
    const connector = this.connector;
    this.connector = null;
    await connector.stop();
  }

  /**
   * Start/stop operations must be serialized: both are awaited, and if they race,
   * the old instance can still be closing while the new one begins listening on the same port.
   */
  private enqueueConnector(work: () => Promise<void>): Promise<void> {
    const next = this.connectorQueue.then(work, work);
    this.connectorQueue = next.catch(() => {});
    return next;
  }

  private toggleConnector(): Promise<void> {
    return this.enqueueConnector(async () => {
      if (this.connector) await this.stopConnector();
      else await this.startConnector();
    });
  }

  private restartConnector(enable: boolean): Promise<void> {
    return this.enqueueConnector(async () => {
      await this.stopConnector();
      if (enable) await this.startConnector();
    });
  }

  private async enqueueImport(candidate: Parameters<ItemProcessor["process"]>[0]): Promise<string | undefined> {
    try {
      const result = await this.processor.process(candidate);
      if (result.action === "cancelled") throw new Error("Import cancelled by user");
      showMessage(`Paper ${actionLabel(result.action)}: ${result.title}`, 5000, "info");
      return result.docId;
    } catch (error) {
      showMessage(`Paper import failed: ${errorMessage(error)}`, 7000, "error");
      throw error;
    }
  }

  private async confirmConnectorImport(candidate: Parameters<ItemProcessor["process"]>[0]): Promise<string | undefined> {
    let result: string | undefined;
    await openConnectorMetadataDialog(candidate, () => this.settings, async (edited) => {
      result = await this.enqueueImport(edited);
    });
    if (!result) throw new Error("Import cancelled by user");
    return result;
  }

  private async refreshDocumentKinds(): Promise<void> {
    const rows = await this.kernelClient.query(`SELECT b.id, a.name FROM blocks b JOIN attributes a ON a.block_id = b.id WHERE b.type = 'd' AND a.name IN ('${ATTR.libraryId}', '${ATTR.libraryData}')`);
    this.documentKinds.clear();
    for (const row of rows) {
      const id = String(row.id);
      if (row.name === ATTR.libraryData) this.documentKinds.set(id, "library");
      else if (!this.documentKinds.has(id)) this.documentKinds.set(id, "paper");
    }
  }

  private async repair(docId: string): Promise<void> {
    await this.processor.repair(docId);
    showMessage("Paper metadata summary refreshed", 4000, "info");
  }

  private async translateLibrary(docId: string): Promise<void> {
    if (!this.translator) throw new Error("Batch translation is only supported in the SiYuan desktop client");
    await openBatchTranslationDialog(this.libraries, this.translator, () => this.settings, docId);
  }

  private async translate(docId: string): Promise<void> {
    if (!this.translator) throw new Error("The current environment does not support calling the pdf2zh subprocess");
    const entry = await this.libraries.requirePaperEntry(docId);
    const paper = await this.libraries.readPaper(docId, entry);
    if (paper.translation.mono || paper.translation.dual) {
      const cleanup = this.settings.autoDeleteOldTranslations
        ? "The plugin deletes the old translated resources after saving the new version and metadata."
        : "The plugin replaces the metadata link but keeps the old translation resources.";
      const accepted = await confirmAsync("Translate again", `This paper already has a translation. ${cleanup} Continue?`);
      if (!accepted) return;
    }
    const result = await this.translator.translate(docId, this.settings);
    const cleaned = result.deletedOldAssets.length ? `, deleted ${result.deletedOldAssets.length} old versions` : "";
    showMessage(`Translation complete in ${(result.elapsedMs / 1000).toFixed(1)}s${cleaned}`, 6000, "info");
    if (result.cleanupWarnings.length) {
      showMessage(`The new translation has been saved, but ${result.cleanupWarnings.length} old resources could not be deleted`, 7000, "error");
    }
  }

  private async selfCheck(): Promise<void> {
    const report = await buildEnvironmentReport(this.settings, this.statusStore.get());
    const rows = Object.entries(report).map(([name, result]) =>
      `<section class="paper-manager-check-row"><div><strong>${escapeHtml(reportLabel(name))}</strong><span class="paper-manager-check-state" data-ok="${result.ok || result.skipped}">${result.skipped ? "skipped" : result.ok ? "ok" : "error"}</span></div><div>${escapeHtml(result.message ?? "")}</div></section>`).join("");
    const dialog = new Dialog({
      title: "Paper Manager environment check",
      width: "680px",
      content: `<div class="b3-dialog__content paper-manager-dialog"><div class="paper-manager-dialog-scroll paper-manager-form">${rows}<p class="paper-manager-hint">Metadata and reading-note templates are built in.</p></div><div class="paper-manager-dialog-footer"><div class="paper-manager-actions"><button class="b3-button b3-button--cancel" data-check-close>Close</button></div></div></div>`,
    });
    dialog.element.querySelector<HTMLButtonElement>("[data-check-close]")!.onclick = () => dialog.destroy();
  }
}

function confirmAsync(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => confirm(title, text, () => resolve(true), () => resolve(false)));
}

function actionLabel(action: "created" | "merged" | "copied"): string {
  return action === "created" ? "created" : action === "merged" ? "merged" : "copy created";
}

function reportLabel(key: string): string {
  return ({ desktopNode: "Desktop Node environment", connector: "Zotero Connector", pdf2zh: "pdf2zh", template: "Template engine" } as Record<string, string>)[key] ?? key;
}

