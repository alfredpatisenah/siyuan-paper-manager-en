import { canUseNode, requireNode } from "../core/env";
import { Setting, showMessage, confirm } from "siyuan";
import type { KernelClient } from "../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../services/library-service";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, pdf2zhLanguageCode, serializeArgs, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";
import { openOnboardingDialog } from "./dialogs/onboarding";
import { configPath, detectPdf2zh, findUv, installPdf2zh, installUv, inspectPdf2zh, systemConfigPath, uninstallPdf2zh, resolvePdf2zh, scanPython } from "../services/pdf2zh-deployment";
import { canonicalSecretEnvKey, pdf2zhPrimarySecretKey, pdf2zhRequiresSecret, withCredentialPlaceholders } from "../services/pdf2zh-secrets";
import { canonicalPdf2zhConfig, cloneConfig, configModelValue, configTranslatorValue, firstTranslator, maskSecrets, modelEnvKey, restoreMaskedSecrets, secretSafeConfig } from "../services/pdf2zh-config";
import { errorMessage } from "../core/errors";

type TabName = "library" | "receiving" | "storage" | "metadata" | "translation";

const TAB_NAMES: Array<[TabName, string]> = [
  ["library", "Library"], ["receiving", "Import & Intake"], ["storage", "Paper Storage"],
  ["metadata", "PDF Metadata"], ["translation", "Translation"],
];

function activateTab(tabs: HTMLElement, panels: Map<TabName, HTMLElement>, name: TabName): void {
  for (const panel of panels.values()) {
    const active = panel.dataset.panel === name;
    panel.dataset.active = String(active);
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
  }
  for (const tab of tabs.querySelectorAll<HTMLButtonElement>("button")) {
    const active = tab.dataset.tab === name;
    tab.dataset.active = String(active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
}

function receivingPanelHtml(draft: PluginSettings): string {
  if (!canUseNode()) return `<div class="paper-manager-preview">The current environment does not support Zotero Connector browser-extension intake. Please use local PDF import instead. Intake settings are retained for desktop use.</div>`;
  return `
      ${numberField("Zotero port", "zoteroPort", draft.zoteroPort)}
      ${switchField("Auto-listen on startup", "autoListen", draft.autoListen)}
      <div class="paper-manager-preview">Connector and local PDFs always import into the default library.</div>`;
}

function storagePanelHtml(draft: PluginSettings): string {
  return `
      ${textField("Citekey generation format", "citekeyFormat", draft.citekeyFormat)}
      <p class="paper-manager-hint">Placeholders: {title} first part of title (max 16 chars), {year} year, {author} surname of first author. Chinese names are converted to unaccented pinyin and the result is lowercased. You can add a suffix using a custom pattern.</p>
      <p class="paper-manager-hint">Default: {title}{year}{author}, for example flashaccel2026wang. You can change it to {author}_{year}_{title}. Basic citekeys are limited to 64 characters; duplicates get an automatic suffix.</p>
      ${textField("Default paper document tag (leave blank to disable)", "defaultDocumentTag", draft.defaultDocumentTag)}
      <p class="paper-manager-hint">Use a single tag name without #, commas, or newlines. Saving will sync the tag across all paper documents; new papers will also receive it automatically. Changing this replaces the previous default tag.</p>
      ${textField("Attachment directory", "assetsDir", draft.assetsDir)}
      <div class="paper-manager-preview">Metadata templates and note templates are bundled with the plugin and are not written to data/templates.</div>`;
}

function metadataPanelHtml(draft: PluginSettings): string {
  return `
      ${switchField("Auto-extract metadata", "autoExtractMetadata", draft.autoExtractMetadata)}
      <p class="paper-manager-hint">When a PDF is selected, metadata is extracted and supplemented online automatically. You can still click “Extract metadata” on the import page when this is off.</p>
      ${switchField("Use Zotero online recognition", "enableZoteroRecognizer", draft.enableZoteroRecognizer)}
      <p class="paper-manager-hint">When enabled, the first five PDF pages, layout, embedded metadata, and filename are sent to Zotero’s official recognition service for extraction.</p>
      ${switchField("Chinese search (experimental)", "enableCnki", draft.enableCnki)}
      ${numberField("CNKI single-request timeout (seconds, 1–120)", "cnkiTimeoutSeconds", draft.cnkiTimeoutSeconds, 1, 120)}
      <div class="paper-manager-preview">Default 10 seconds. Each value is used for a single network request for search, details, and citation enhancement, including connection and full response time; it does not include manual verification wait time.</div>
      <label class="paper-manager-field"><span>CNKI site</span><select class="b3-select" data-key="cnkiRegion"><option value="mainland" ${draft.cnkiRegion !== "oversea" ? "selected" : ""}>Mainland</option><option value="oversea" ${draft.cnkiRegion === "oversea" ? "selected" : ""}>Overseas</option></select></label>
      <div class="paper-manager-preview">CNKI search requires the SiYuan desktop client. The first search or after an expired session, the CNKI window opens; complete verification and return to continue, and the same session will be reused automatically.</div>
      <div class="paper-manager-preview">Extraction results display multiple candidates; you can review and edit titles, authors, and abstracts before import.</div>`;
}

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;
  private configSaveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly displayName: string,
    private readonly getSettings: () => PluginSettings,
    private readonly kernel: KernelClient,
    private readonly libraries: LibraryService,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
    private readonly getSecret?: (name: string) => string,
  ) {
    this.draft = structuredClone(getSettings());
    this.setting = new Setting({
      width: "820px",
      height: "680px",
      confirmCallback: () => { void this.save(); },
      destroyCallback: () => { if (this.configSaveTimer) clearTimeout(this.configSaveTimer); this.configSaveTimer = undefined; },
    });
    this.setting.addItem({ title: "", direction: "column", createActionElement: () => this.build() });
  }

  open(): void { this.setting.open(this.displayName); }

  private build(): HTMLElement {
    this.draft = structuredClone(this.getSettings());
    const root = document.createElement("div");
    root.className = "paper-manager-form paper-manager-settings";
    const tabs = document.createElement("div");
    tabs.className = "paper-manager-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Paper Manager settings");
    const panels = new Map<TabName, HTMLElement>();
    const activate = (name: TabName) => activateTab(tabs, panels, name);
    for (const [name, label] of TAB_NAMES) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "paper-manager-tab";
      tab.textContent = label;
      tab.dataset.tab = name;
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); activate(name); });
      tabs.append(tab);
      const panel = document.createElement("section");
      panel.className = "paper-manager-panel";
      panel.dataset.panel = name;
      panel.setAttribute("role", "tabpanel");
      panels.set(name, panel);
      root.append(panel);
    }
    root.prepend(tabs);
    this.renderPanels(panels);
    this.bindEvents(root);
    this.bindConfigTabs(root);
    this.renderConfigVisual(root);
    void this.scanPdf2zh(root);
    activate("library");
    void this.renderLibraries(root);
    return root;
  }

  private renderPanels(panels: Map<TabName, HTMLElement>): void {
    panels.get("library")!.innerHTML = `<div data-library-content>Loading libraries…</div>`;
    panels.get("receiving")!.innerHTML = receivingPanelHtml(this.draft);
    panels.get("storage")!.innerHTML = storagePanelHtml(this.draft);
    panels.get("metadata")!.innerHTML = metadataPanelHtml(this.draft);
    panels.get("translation")!.innerHTML = this.translationPanelHtml();
  }

  private bindEvents(root: HTMLElement): void {
    root.addEventListener("input", (event) => this.capture(event));
    root.addEventListener("change", (event) => this.capture(event));
    root.querySelector<HTMLInputElement>("[data-secret-name]")?.addEventListener("input", (event) => { this.setSecretName(String((event.target as HTMLInputElement).value), configTranslatorValue(this.draft.pdf2zhConfig ?? {})); });
    root.querySelector<HTMLSelectElement>("[data-config-key=translator]")?.addEventListener("change", (event) => { const service = String((event.target as HTMLSelectElement).value).trim(); this.setSecretNameForService(service, root); });
    root.querySelector<HTMLButtonElement>("[data-scan-python]")?.addEventListener("click", () => void this.scanPython(root));
    root.querySelector<HTMLButtonElement>("[data-scan-pdf2zh]")?.addEventListener("click", () => void this.scanPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-uninstall-pdf2zh]")?.addEventListener("click", () => void this.uninstallPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-upgrade-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root, true));
    root.querySelector<HTMLButtonElement>("[data-install-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root));
    root.querySelector<HTMLInputElement>("[data-python-manual]")?.addEventListener("change", () => void this.selectPython(root, root.querySelector<HTMLInputElement>("[data-python-manual]")!.value));
    root.querySelector<HTMLButtonElement>("[data-test-secrets]")?.addEventListener("click", () => { try { const value = ({ [this.secretEnvKey(configTranslatorValue(this.draft.pdf2zhConfig ?? {}))]: this.secretNameForService(configTranslatorValue(this.draft.pdf2zhConfig ?? {})) } as Record<string, string>)[this.secretEnvKey(configTranslatorValue(this.draft.pdf2zhConfig ?? {}))]; if (value) showMessage(`Secret ${value} is configured`, 3000, "info"); } catch (error) { showMessage(`Test failed: ${errorMessage(error)}`, 5000, "error"); } });
    root.querySelector<HTMLButtonElement>("[data-load-config]")?.addEventListener("click", () => void this.loadConfig(root));
    root.querySelector<HTMLButtonElement>("[data-import-system-config]")?.addEventListener("click", () => void this.importSystemConfig(root));
  }

  private translationPanelHtml(): string {
    if (!canUseNode()) return `<div class="paper-manager-preview">The current environment does not support pdf2zh translation. You can read PDFs synced from the desktop client; translation settings remain available for desktop use.</div>`;
    const config = this.draft.pdf2zhConfig ?? {};
    const service = configTranslatorValue(config);
    return `
      <h3>pdf2zh deployment <span class="paper-manager-badge paper-manager-badge--testing">Experimental</span></h3><div class="paper-manager-actions"><button type="button" class="b3-button" data-scan-pdf2zh>Scan installation</button><button type="button" class="b3-button" data-install-pdf2zh>Install / repair</button><button type="button" class="b3-button" data-uninstall-pdf2zh>Uninstall</button><button type="button" class="b3-button" data-upgrade-pdf2zh>Upgrade</button></div>
      <div class="paper-manager-preview" data-pdf2zh-status></div>
      <h3>pdf2zh config file</h3>
      <div class="paper-manager-actions"><button type="button" class="b3-button" data-load-config>Read managed config</button><button type="button" class="b3-button" data-import-system-config>Import system config</button></div>
      <div class="paper-manager-tabs paper-manager-config-tabs"><button type="button" data-config-tab="visual" data-active="true">Visual</button><button type="button" data-config-tab="json">JSON</button></div>
      <section data-config-panel="visual"><label class="paper-manager-field"><span>Font path</span><input class="b3-text-field" data-config-key="NOTO_FONT_PATH"></label>${translatorSelect(config)}${serviceSupportsModel(service) ? `<label class="paper-manager-field"><span>Model</span><input class="b3-text-field" data-config-key="model" placeholder="optional"></label>` : ""}</section>
      <section data-config-panel="json" hidden><textarea class="b3-text-field" rows="9" data-config-json placeholder="{}"></textarea></section>
      <div class="paper-manager-inline-field"><label class="paper-manager-field"><span>Service key name</span><input class="b3-text-field" data-secret-name value="${escapeHtml(this.secretNameForService(service) ?? "")}"></label></div>
      <div class="paper-manager-preview">The visual editor and JSON editor touch the same pdf2zh config object; unknown fields remain only in the JSON tab. Provide only one SiYuan “Secrets and Variables” entry name, not the actual secret value.</div>
      <h3>Plugin translation settings</h3>
      ${languageSelect("Source language", "translateFrom", pdf2zhLanguageCode(this.draft.translateFrom), true, "data-key")}
      ${languageSelect("Target language", "translateTo", pdf2zhLanguageCode(this.draft.translateTo), false, "data-key")}
      <div class="paper-manager-preview">Languages are passed to pdf2zh via the <code>-li</code>/<code>-lo</code> CLI flags. pdf2zh only reads language keys in the GUI configuration, while the CLI ignores them.</div>
      ${textField("pdf2zh path", "pdf2zhPath", this.draft.pdf2zhPath)}
      ${numberField("Request concurrency (per PDF, 1–128)", "translationThreads", this.draft.translationThreads, 1, 128)}
      ${numberField("Parallel translations (1–8)", "translationConcurrency", this.draft.translationConcurrency, 1, 8)}
      ${switchField("Keep bilingual version", "translationDual", this.draft.translationDual)}
      ${switchField("Delete old versions after re-translation", "autoDeleteOldTranslations", this.draft.autoDeleteOldTranslations)}
      ${textareaField("Extra CLI args", "pdf2zhArgs", serializeArgs(this.draft.pdf2zhArgs))}
      ${textField("Translation asset directory", "translationAssetsDir", this.draft.translationAssetsDir)}
      <div class="paper-manager-preview">Request concurrency corresponds to pdf2zh’s --thread (-t), default 4; when translating multiple papers simultaneously, the total request concurrency is approximately the product of the two settings. The service’s required credentials are read from the secret store.</div>
   `;
  }

  private async scanPdf2zh(root: HTMLElement): Promise<void> { const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!; try { const installed = await inspectPdf2zh(); const existi = installed?.path ?? ""; status.textContent = existi ? `Found pdf2zh: ${existi}` : "pdf2zh not found; install it or select a Python environment."; } catch (error) { status.textContent = `Check failed: ${errorMessage(error)}`; } }

  private async uninstallPdf2zh(root: HTMLElement): Promise<void> { const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!; try { const result = await uninstallPdf2zh(); status.textContent = result ? `Uninstalled: ${result}` : "pdf2zh uninstallation completed."; } catch (error) { status.textContent = `Uninstall failed: ${errorMessage(error)}`; } }

  private bindConfigTabs(root: HTMLElement): void {
    for (const tab of root.querySelectorAll<HTMLButtonElement>("[data-config-tab]")) tab.addEventListener("click", () => {
      const name = tab.dataset.configTab;
      for (const button of root.querySelectorAll<HTMLButtonElement>("[data-config-tab]")) button.dataset.active = String(button === tab);
      for (const panel of root.querySelectorAll<HTMLElement>("[data-config-panel]")) panel.hidden = panel.dataset.configPanel !== name;
      if (name === "json") this.syncVisualToJson(root);
    });
    root.querySelectorAll<HTMLElement>("[data-config-key]").forEach(input => { const sync = () => { this.syncVisualToJson(root); this.scheduleSaveConfig(root); }; input.addEventListener("input", sync); input.addEventListener("change", sync); });
    root.querySelector<HTMLTextAreaElement>("[data-config-json]")?.addEventListener("input", () => { this.syncJsonToVisual(root); this.scheduleSaveConfig(root); });
  }

  private renderConfigVisual(root: HTMLElement): void {
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]");
    if (area && !area.value.trim()) area.value = JSON.stringify(maskSecrets(cloneConfig(this.draft.pdf2zhConfig)), null, 2);
    this.syncJsonToVisual(root);
  }

  private syncVisualToJson(root: HTMLElement): void {
    const config = cloneConfig(this.draft.pdf2zhConfig);
    const values = new Map<string, string>();
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-config-key]")) values.set(input.dataset.configKey!, input.value);
    const fontPath = values.get("NOTO_FONT_PATH");
    if (fontPath != null && fontPath !== "") config["NOTO_FONT_PATH"] = fontPath;
    const service = values.get("translator")?.trim() || configTranslatorValue(config);
    const model = values.get("model")?.trim() || "";
    const previous = firstTranslator(config);
    const envs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(previous?.envs && typeof previous.envs === "object" ? previous.envs as Record<string, unknown> : {})) {
      if (/_MODEL$/i.test(key)) continue;
      envs[canonicalSecretEnvKey(key)] = value;
    }
    if (serviceSupportsModel(service) && model) envs[modelEnvKey(service)] = model;
    const entry: Record<string, unknown> = { ...(previous ?? {}), name: service, envs: withCredentialPlaceholders(envs, service) };
    config.translators = [entry];
    delete config.translator;
    this.draft.pdf2zhConfig = config;
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]");
    if (area) area.value = JSON.stringify(maskSecrets(config), null, 2);
    this.refreshTranslatorControls(root, service);
  }

  private syncJsonToVisual(root: HTMLElement): void {
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]"); if (!area) return;
    try {
      const parsed = JSON.parse(area.value || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const config = canonicalPdf2zhConfig(restoreMaskedSecrets(parsed, this.draft.pdf2zhConfig) as Record<string, unknown>);
      this.draft.pdf2zhConfig = config;
      const service = configTranslatorValue(config);
      for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-config-key]")) {
        const key = input.dataset.configKey!;
        const raw = key === "translator" ? service : key === "model" ? configModelValue(config) : config[key];
        input.value = raw == null ? "" : String(raw);
      }
      const secret = root.querySelector<HTMLInputElement>("[data-secret-name]");
      if (secret) secret.value = this.secretNameForService(service);
      this.refreshTranslatorControls(root, service);
    } catch { /* leave invalid JSON visible for save validation */ }
  }

  private refreshTranslatorControls(root: HTMLElement, service: string): void {
    const secret = root.querySelector<HTMLInputElement>("[data-secret-name]");
    if (secret) secret.disabled = !serviceRequiresKey(service);
    const model = root.querySelector<HTMLInputElement>("[data-config-key=model]");
    if (model) model.disabled = !serviceSupportsModel(service);
    const test = root.querySelector<HTMLButtonElement>("[data-test-secrets]");
    if (test) test.disabled = !serviceRequiresKey(service);
  }

  private async scanPython(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!; const select = root.querySelector<HTMLSelectElement>("[data-python-select]")!;
    try { const list = await scanPython(); select.innerHTML = list.map(item => `<option value="${escapeHtml(item.path)}" ${item.path === this.draft.pythonPath ? "selected" : ""} ${item.supported ? "" : "disabled"}>${escapeHtml(item.path)}${item.supported ? "" : " (unsupported)"}</option>`).join(""); if (!this.draft.pythonPath && list[0]) { this.draft.pythonPath = list[0].path; } status.textContent = list.length ? `Detected ${list.length} Python environment(s)` : "No supported Python environment detected."; } catch (error) { status.textContent = `Python scan failed: ${errorMessage(error)}`; }
  }

  private async selectPython(root: HTMLElement, python: string): Promise<void> { const status = root.querySelector<HTMLElement>("[data-deploy-status]")!; const value = python.trim(); if (!value) { status.textContent = "Please scan and select a Python 3.11–3.13 environment first."; return; } this.draft.pythonPath = value; status.textContent = `Selected Python: ${value}`; }

  private async installPdf2zh(root: HTMLElement, upgrade = false): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!; const python = root.querySelector<HTMLSelectElement>("[data-python-select]")?.value || root.querySelector<HTMLInputElement>("[data-python-manual]")?.value || this.draft.pythonPath;
    if (!python) { status.textContent = "Please scan and select Python 3.11–3.13 first."; return; }
    try { let uv = await findUv(); if (!uv) { status.textContent = "Installing uv…"; const result = await installUv(python); if (result.code !== 0) throw new Error(result.stderr || "uv installation failed"); uv = result.binaryPath; } const result = await installPdf2zh({ python, uv, upgrade }); status.textContent = result.success ? `pdf2zh installed successfully: ${result.path}` : `Installation failed: ${result.error}`; } catch (error) { status.textContent = `Installation failed: ${errorMessage(error)}`; }
  }

  private async loadConfig(root: HTMLElement): Promise<void> {
    try {
      const fs = requireNode<typeof import("node:fs")>("fs");
      const path = requireNode<typeof import("node:path")>("path");
      const workspace = await this.kernel.getWorkspaceInfo();
      const target = configPath(workspace.workspaceDir);
      this.draft.pdf2zhConfigPath = target;
      const exists = fs.existsSync(target);
      const parsed = canonicalPdf2zhConfig(exists ? JSON.parse(fs.readFileSync(target, "utf8")) : (this.draft.pdf2zhConfig ?? {}));
      const repaired = secretSafeConfig(parsed);
      this.draft.pdf2zhConfig = repaired;
      if (!exists || JSON.stringify(parsed) !== JSON.stringify(repaired)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");
      }
      root.querySelector<HTMLTextAreaElement>("[data-config-json]")!.value = JSON.stringify(maskSecrets(repaired), null, 2);
      this.syncJsonToVisual(root);
    } catch (error) { showMessage(`Failed to read config: ${errorMessage(error)}`, 5000, "error"); }
  }

  private async importSystemConfig(root: HTMLElement): Promise<void> {
    confirm("Importing the system config will overwrite the managed config. Continue?", "", () => { void this.performSystemImport(root); });
  }

  private async performSystemImport(root: HTMLElement): Promise<void> {
    try {
      const fs = requireNode<typeof import("node:fs")>("fs"); const source = systemConfigPath();
      if (!fs.existsSync(source)) throw new Error(`System config not found: ${source}`);
      const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("System config is not a JSON object");
      const workspace = await this.kernel.getWorkspaceInfo(); const target = configPath(workspace.workspaceDir);
      const path = requireNode<typeof import("node:path")>("path"); fs.mkdirSync(path.dirname(target), { recursive: true });
      const safeConfig = secretSafeConfig(canonicalPdf2zhConfig(parsed));
      fs.writeFileSync(target, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
      this.draft.pdf2zhConfigPath = target; this.draft.pdf2zhConfig = safeConfig;
      await this.loadConfig(root); showMessage("System config imported into managed config", 3000);
    } catch (error) { showMessage(`System config import failed: ${errorMessage(error)}`, 5000, "error"); }
  }

  private scheduleSaveConfig(root: HTMLElement): void { if (this.configSaveTimer) clearTimeout(this.configSaveTimer); this.configSaveTimer = setTimeout(() => { this.configSaveTimer = undefined; void this.saveConfig(root); }, 300); }

  private async saveConfig(root: HTMLElement): Promise<void> { try { const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]")!; if (root.querySelector<HTMLButtonElement>("[data-config-tab=json]")?.dataset.active === "true") this.syncJsonToVisual(root); const raw = area.value.trim(); if (!raw) return; const parsed = JSON.parse(raw); this.draft.pdf2zhConfig = canonicalPdf2zhConfig(parsed); await this.onSave(normalizeSettings(this.draft)); } catch (error) { showMessage(`Failed to save config: ${errorMessage(error)}`, 5000, "error"); } }

  private secretEnvKey(service: string): string { return pdf2zhPrimarySecretKey(service) || `${service.trim().toUpperCase()}_API_KEY`; }
  private secretNameForService(service: string): string { return this.draft.pdf2zhSecretNames?.[this.secretEnvKey(service)] ?? ""; }
  private setSecretName(name: string, service = configTranslatorValue(this.draft.pdf2zhConfig ?? {})): void { const key = this.secretEnvKey(service); if (!serviceRequiresKey(service)) { const next = { ...this.draft.pdf2zhSecretNames }; delete next[key]; this.draft.pdf2zhSecretNames = next; return; } this.draft.pdf2zhSecretNames = { ...(this.draft.pdf2zhSecretNames ?? {}), [key]: name }; }
  private setSecretNameForService(service: string, root?: HTMLElement): void { const input = (root ?? document).querySelector<HTMLInputElement>("[data-secret-name]"); if (input) input.value = this.secretNameForService(service); }

  private capture(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const key = input.dataset.key as keyof PluginSettings | undefined;
    if (!key) return;
    let value: unknown = input instanceof HTMLInputElement && input.type === "checkbox"
      ? input.checked
      : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
    if (key === "pdf2zhArgs") value = splitArgString(String(value));
    (this.draft as unknown as Record<string, unknown>)[key] = value;
  }

  private async renderLibraries(root: HTMLElement): Promise<void> {
    const container = root.querySelector<HTMLElement>("[data-library-content]")!;
    try {
      const libraries = await this.libraries.discoverLibraries();
      if (!this.draft.defaultLibraryDocId && libraries[0]) this.draft.defaultLibraryDocId = libraries[0].docId;
      container.innerHTML = `${libraries.length ? librarySelector(libraries, this.draft.defaultLibraryDocId) : "<div class=\"paper-manager-preview\">No paper library has been created yet.</div>"}
        <div class="paper-manager-actions"><button type="button" class="b3-button" data-create-library>Create library</button></div>
        <div data-library-editor></div>`;
      container.querySelector<HTMLSelectElement>("[data-default-library]")?.addEventListener("change", (event) => {
        this.draft.defaultLibraryDocId = (event.target as HTMLSelectElement).value;
        void this.renderLibraryEditor(container, libraries);
      });
      container.querySelector<HTMLButtonElement>("[data-create-library]")!.addEventListener("click", () => {
        void openOnboardingDialog(this.kernel, this.libraries, async (library) => {
          this.draft.defaultLibraryDocId = library.docId;
          this.draft.onboardingCompleted = true;
          await this.onSave(normalizeSettings(this.draft));
          await this.renderLibraries(root);
        }, "Create paper library");
      });
      await this.renderLibraryEditor(container, libraries);
    } catch (error) {
      container.innerHTML = `<div class="paper-manager-preview">Read failed: ${escapeHtml(errorMessage(error))}</div>`;
    }
  }

  private async renderLibraryEditor(container: HTMLElement, libraries: PaperLibraryInfo[]): Promise<void> {
    const editor = container.querySelector<HTMLElement>("[data-library-editor]");
    if (!editor) return;
    const selected = libraries.find((library) => library.docId === this.draft.defaultLibraryDocId) ?? libraries[0];
    if (!selected) { editor.innerHTML = ""; return; }
    editor.innerHTML = `<hr class="b3-hr"><h3>${escapeHtml(selected.title)}</h3>
      <div class="paper-manager-preview">${escapeHtml(selected.hPath)} · Database ${escapeHtml(selected.data.avId)}</div>
      <div class="paper-manager-preview">Edit or select project membership directly in the database “Related project” field; multi-select is supported. Column display and ordering are managed in the database view.</div>
      <div class="paper-manager-actions">
        <button type="button" class="b3-button b3-button--text" data-sync>Re-sync</button>
        <button type="button" class="b3-button b3-button--text" data-repair>Repair database</button>
      </div>`;
    editor.querySelector<HTMLButtonElement>("[data-sync]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.syncLibrary(selected.docId);
      return `Sync completed: ${result.papers} papers, restored ${result.restoredRows} rows, removed ${result.removedRows} rows, failed ${result.failed.length} papers`;
    });
    editor.querySelector<HTMLButtonElement>("[data-repair]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.repairLibrary(selected.docId);
      return `Repair completed: synced ${result.papers} papers`;
    });
  }

  private async save(): Promise<void> {
    try {
      const settings = normalizeSettings(this.draft);
      settings.onboardingCompleted = Boolean(settings.defaultLibraryDocId);
      await this.onSave(settings);
      this.draft = structuredClone(settings);
    } catch (error) {
      showMessage(`Failed to save settings: ${errorMessage(error)}`, 5000, "error");
      return;
    }
    showMessage("Paper Manager settings saved", 5000, "info");
  }
}

function textField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}
function numberField(label: string, key: keyof PluginSettings, value: number, min = 1024, max = 65535): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" type="number" min="${min}" max="${max}" step="1" data-key="${key}" value="${value}"></label>`;
}
function switchField(label: string, key: keyof PluginSettings, value: boolean): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><span><input class="b3-switch" type="checkbox" data-key="${key}" ${value ? "checked" : ""}></span></label>`;
}
function textareaField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field paper-manager-field--column"><span>${escapeHtml(label)}</span><textarea class="b3-text-field" rows="4" data-key="${key}">${escapeHtml(value)}</textarea></label>`;
}
const PDF2ZH_LANGUAGES: Array<[string, string]> = [
  ["auto", "Auto-detect"], ["en", "English"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"],
  ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"],
  ["ru", "Russian"], ["ar", "Arabic"], ["nl", "Dutch"], ["pl", "Polish"], ["uk", "Ukrainian"],
  ["tr", "Turkish"], ["vi", "Vietnamese"], ["th", "Thai"], ["id", "Indonesian"], ["hi", "Hindi"],
  ["he", "Hebrew"], ["cs", "Czech"], ["da", "Danish"], ["fi", "Finnish"], ["el", "Greek"],
  ["hu", "Hungarian"], ["no", "Norwegian"], ["ro", "Romanian"], ["sk", "Slovak"], ["sv", "Swedish"],
];
function languageSelect(label: string, key: string, value = "", allowAuto = false, attribute: "data-config-key" | "data-key" = "data-config-key"): string {
  const languages = allowAuto ? PDF2ZH_LANGUAGES : PDF2ZH_LANGUAGES.filter(([code]) => code !== "auto");
  const options = languages.some(([code]) => code === value) || !value ? languages : [[value, `${value} (custom)`] as [string, string], ...languages];
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><select class="b3-select" ${attribute}="${key}">${options.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === value ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>`;
}
const PDF2ZH_SERVICES: Array<[string, string]> = [
  ["google", "Google"], ["bing", "Bing"], ["deepl", "DeepL"], ["deeplx", "DeepLX"], ["openai", "OpenAI"],
  ["ollama", "Ollama"], ["xinference", "Xinference"], ["azure-openai", "Azure OpenAI"], ["zhipu", "Zhipu"],
  ["modelscope", "ModelScope"], ["silicon", "SiliconCloud"], ["gemini", "Gemini"], ["azure", "Azure"],
  ["tencent", "Tencent"], ["dify", "Dify"], ["anythingllm", "AnythingLLM"], ["argos", "Argos Translate"],
  ["grok", "Grok"], ["groq", "Groq"], ["deepseek", "DeepSeek"], ["openailiked", "OpenAI-compatible"], ["qwen-mt", "Alibaba Tongyi"],
];
function serviceRequiresKey(service: string): boolean { return pdf2zhRequiresSecret(service); }
const MODEL_SERVICES = new Set(["openai", "ollama", "xinference", "azure-openai", "zhipu", "modelscope", "silicon", "gemini", "grok", "groq", "deepseek", "openailiked", "qwen-mt"]);
function serviceSupportsModel(service: string): boolean { return MODEL_SERVICES.has(service); }
function translatorSelect(config: Record<string, unknown>): string {
  const value = configTranslatorValue(config); const options = PDF2ZH_SERVICES.some(([code]) => code === value) ? PDF2ZH_SERVICES : [[value, `${value} (custom)`] as [string, string], ...PDF2ZH_SERVICES];
  return `<label class="paper-manager-field"><span>Default service</span><select class="b3-select" data-config-key="translator">${options.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === value ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>`;
}
function librarySelector(libraries: PaperLibraryInfo[], selected: string): string {
  return `<label class="paper-manager-field"><span>Default library</span><select class="b3-select" data-default-library>${libraries.map((library) =>
    `<option value="${escapeHtml(library.docId)}" ${library.docId === selected ? "selected" : ""}>${escapeHtml(library.title)}</option>`).join("")}</select></label>`;
}

async function actionMessage(action: () => Promise<string>): Promise<void> {
  try { showMessage(await action(), 5000, "info"); }
  catch (error) { showMessage(`Library operation failed: ${errorMessage(error)}`, 7000, "error"); }
}

