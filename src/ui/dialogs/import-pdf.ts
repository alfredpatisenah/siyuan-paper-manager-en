import { uniqueMetadataCandidates } from "../../services/metadata-candidates";
import { metadataProgress, metadataResultHtml } from "./metadata-status";
import { Dialog, showMessage } from "siyuan";
import { SOURCE } from "../../constants";
import type { ItemProcessor } from "../../services/item-processor";
import { MetadataExtractor } from "../../services/metadata-extractor";
import type { MetadataCandidate } from "../../types/import";
import type { PluginSettings } from "../../types/settings";
import { candidatePreviewHtml } from "./paper-preview";
import { button, creatorLines, escapeHtml, parseCreatorLines } from "../dom";
import { errorMessage } from "../../core/errors";

export async function openImportPdfDialog(
  processor: ItemProcessor,
  getSettings: () => PluginSettings,
): Promise<void> {
  let extractionController: AbortController | undefined;
  const dialog = new Dialog({
    destroyCallback: () => extractionController?.abort(),
    title: "Search paper / import PDF",
    width: "720px",
    content: `<div class="b3-dialog__content paper-manager-import"><div class="paper-manager-import-scroll paper-manager-form">
      <section class="paper-manager-import-section">
        <label class="paper-manager-field paper-manager-field--column"><span class="paper-manager-import-label">PDF file <span class="paper-manager-import-optional">(optional)</span></span><input class="b3-text-field" type="file" accept="application/pdf" data-file></label>
        <div class="paper-manager-import-lookup"><p class="paper-manager-import-hint">You can extract metadata manually or fetch it again online; automatic extraction and Zotero recognition are configured in plugin settings.</p><div data-extract-action></div></div>
      </section>
      <section class="paper-manager-import-section">
        <label class="paper-manager-field paper-manager-field--column"><span class="paper-manager-import-label">Identifier / paper URL / BibTeX</span><textarea class="b3-text-field" data-query rows="3" placeholder="DOI, URL, or BibTeX"></textarea></label>
        <div class="paper-manager-import-lookup"><p class="paper-manager-import-hint">Search sends the identifier or URL to the public metadata API; BibTeX is parsed locally.</p><div data-lookup-action></div></div>
      </section>
      <section class="paper-manager-import-section paper-manager-import-results">
      <label class="paper-manager-field paper-manager-field--column"><span class="paper-manager-import-label">Recognition candidates</span><select class="b3-select" data-candidates disabled><option>Select candidate…</option></select></label>
      <section class="paper-manager-paper-preview" data-preview aria-live="polite">Select a PDF or search for a paper, then preview the metadata here.</section>
      <div class="paper-manager-import-warnings" data-warnings role="status" hidden></div>
      <details class="paper-manager-import-editor"><summary>Edit metadata (used during import)</summary>
      <div class="paper-manager-import-editor-fields">${[["title", "Title"], ["authors", "Author (one per line, Family, Given)"], ["date", "Date"], ["doi", "DOI"], ["url", "URL"], ["journal", "Journal / book"], ["publisher", "Publisher"], ["abstract", "Abstract"]].map(([key, label]) => `<label class="paper-manager-field paper-manager-field--column"><span>${label}</span><textarea class="b3-text-field" data-edit="${key}" rows="${key === "abstract" ? "4" : "2"}"></textarea></label>`).join("")}</div>
      </details>
      </section>
      </div><div class="paper-manager-import-footer"><span class="paper-manager-import-hint">This will import into the current default library</span><div class="paper-manager-actions" data-actions></div></div>
    </div>`,
  });
  const fileInput = dialog.element.querySelector<HTMLInputElement>("[data-file]")!;
  const extractButton = button("Extract metadata");
  extractButton.disabled = true;
  dialog.element.querySelector("[data-extract-action]")!.append(extractButton);
  const candidateSelect = dialog.element.querySelector<HTMLSelectElement>("[data-candidates]")!;
  const preview = dialog.element.querySelector<HTMLElement>("[data-preview]")!;
  const warningBox = dialog.element.querySelector<HTMLElement>("[data-warnings]")!;
  const setWarnings = (warnings: string[]) => {
    warningBox.hidden = !warnings.length;
    warningBox.textContent = warnings.join("; ");
  };
  const query = dialog.element.querySelector<HTMLTextAreaElement>("[data-query]")!;
  const lookupButton = button("Search / parse");
  dialog.element.querySelector("[data-lookup-action]")!.append(lookupButton);
  const importButton = button("Import and create", true);
  const cancel = button("Cancel");
  let bytes: Uint8Array | null = null;
  let candidates: MetadataCandidate[] = [];
  let extractionRequest = 0;
  importButton.disabled = true;

  const updatePreview = () => {
    const selected = candidates[Number(candidateSelect.value)] ?? candidates[0];
    if (!selected) return;
    const c = selected.canonical;
    dialog.element.querySelectorAll<HTMLTextAreaElement>("[data-edit]").forEach(input => {
      const key = input.dataset.edit!;
      input.value = key === "authors" ? creatorLines(c.creators) : String(c[key as keyof typeof c] ?? "");
    });
    preview.innerHTML = candidatePreviewHtml(selected);
  };

  candidateSelect.addEventListener("change", updatePreview);
  const extract = async (manual = false) => {
    const settings = getSettings();
    const shouldExtract = manual || settings.autoExtractMetadata;
    extractionController?.abort();
    const controller = new AbortController();
    extractionController = controller;
    const request = ++extractionRequest;
    setWarnings([]);
    const file = fileInput.files?.[0];
    lookupButton.disabled = true;
    extractButton.disabled = true;
    bytes = null;
    candidates = [];
    importButton.disabled = true;
    candidateSelect.disabled = true;
    if (!file) { lookupButton.disabled = false; preview.textContent = "No PDF selected yet."; return; }
    preview.textContent = shouldExtract ? "Extracting metadata…" : "Creating metadata from the filename only.";
    const progress = metadataProgress(controller.signal, text => { if (request === extractionRequest) preview.textContent = text; });
    try {
      const selectedBytes = new Uint8Array(await file.arrayBuffer());
      if (request !== extractionRequest || controller.signal.aborted) return;
      bytes = selectedBytes;
      const extractor = new MetadataExtractor({ onProgress: progress.update, enableZoteroRecognizer: settings.enableZoteroRecognizer, enableCnki: settings.enableCnki, cnkiRegion: settings.cnkiRegion,
        cnkiTimeoutSeconds: settings.cnkiTimeoutSeconds });
      const result = shouldExtract
        ? await extractor.extract(selectedBytes, file.name)
        : filenameOnlyResult(file.name);
      if (request !== extractionRequest || controller.signal.aborted) return;
      candidates = uniqueMetadataCandidates([result.selected, ...result.candidates]);
      candidateSelect.innerHTML = candidates.map((candidate, index) =>
        `<option value="${index}">${escapeHtml(candidate.provider)} · ${escapeHtml(candidate.canonical.title)} · ${candidate.confidence.toFixed(2)}</option>`).join("");
      candidateSelect.disabled = candidates.length <= 1;
      candidateSelect.value = String(Math.max(0, candidates.indexOf(result.selected)));
      updatePreview();
      warningBox.hidden = false; warningBox.innerHTML = metadataResultHtml(result);
    } catch (error) {
      if (request !== extractionRequest || controller.signal.aborted) return;
      const title = file.name.replace(/\.pdf$/i, "") || "Unnamed paper";
      candidates = [{
        provider: "filename",
        confidence: 0.2,
        reason: `Extraction failed: ${errorMessage(error)}`,
        canonical: { itemType: "journalArticle", title, creators: [], tags: [] },
      }];
      candidateSelect.innerHTML = `<option value="0">Filename fallback · ${escapeHtml(title)}</option>`;
      updatePreview();
    } finally {
      progress.stop();
      if (request === extractionRequest) { extractButton.disabled = !fileInput.files?.length; lookupButton.disabled = false; importButton.disabled = !bytes || !candidates.length; }
    }
  };
  fileInput.addEventListener("change", () => { void extract(); });
  extractButton.addEventListener("click", () => { void extract(true); });

  lookupButton.addEventListener("click", async () => {
    if (!query.value.trim()) { showMessage("Please enter an identifier, URL, or BibTeX"); return; }
    extractionController?.abort();
    const controller = new AbortController();
    extractionController = controller;
    const request = ++extractionRequest;
    setWarnings([]);
    importButton.disabled = true;
    lookupButton.disabled = extractButton.disabled = true;
    preview.textContent = "Searching…";
    const progress = metadataProgress(controller.signal, text => { if (request === extractionRequest) preview.textContent = text; });
    try {
      const result = await new MetadataExtractor({ signal: controller.signal, onProgress: progress.update }).lookup(query.value);
      if (request !== extractionRequest || controller.signal.aborted) return;
      candidates = uniqueMetadataCandidates([result.selected, ...result.candidates, ...candidates]);
      candidateSelect.innerHTML = candidates.map((candidate, index) => `<option value="${index}">${escapeHtml(candidate.provider)} · ${escapeHtml(candidate.canonical.title)}</option>`).join("");
      candidateSelect.value = "0";
      candidateSelect.disabled = candidates.length <= 1;
      updatePreview();
      warningBox.hidden = false; warningBox.innerHTML = metadataResultHtml(result);
    } catch (error) {
      if (request !== extractionRequest || controller.signal.aborted) return;
      updatePreview();
      setWarnings([`Search incomplete: ${errorMessage(error)}.${candidates.length ? " Existing candidates remain available." : " Please retry."}`]);
    } finally {
      progress.stop();
      if (request === extractionRequest) {
        importButton.disabled = !candidates.length;
        lookupButton.disabled = false;
        extractButton.disabled = !fileInput.files?.length;
      }
    }
  });

  cancel.addEventListener("click", () => { extractionRequest += 1; dialog.destroy(); });
  importButton.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    const selected = candidates[Number(candidateSelect.value)] ?? candidates[0];
    if (!selected || (file && !bytes)) {
      showMessage("Please choose a PDF and wait for metadata extraction to finish", 4000, "error");
      return;
    }
    const edited = { ...selected.canonical };
    dialog.element.querySelectorAll<HTMLTextAreaElement>("[data-edit]").forEach(input => {
      const key = input.dataset.edit!;
      if (key === "authors") edited.creators = parseCreatorLines(input.value);
      else Object.assign(edited, { [key]: input.value.trim() || undefined });
    });
    if (!edited.title) { showMessage("Title cannot be empty", 4000, "error"); return; }
    importButton.disabled = true;
    importButton.textContent = "Importing…";
    fileInput.disabled = extractButton.disabled = lookupButton.disabled = query.disabled = true;
    try {
      const result = await processor.process({
        id: `pdf-${Date.now()}`,
        source: file ? SOURCE.pdf : SOURCE.manual,
        canonical: edited,
        raw: selected.raw ?? { provider: selected.provider, filename: file?.name },
        attachments: file && bytes ? [{ title: file.name, mimeType: "application/pdf", bytes }] : [],
      });
      if (result.action !== "cancelled") showMessage(`PDF import complete: ${result.title}`, 5000, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`PDF import failed: ${errorMessage(error)}`, 7000, "error");
      importButton.disabled = false;
      importButton.textContent = "Import and create";
      fileInput.disabled = extractButton.disabled = lookupButton.disabled = query.disabled = false;
    }
  });
  dialog.element.querySelector<HTMLElement>("[data-actions]")!.append(cancel, importButton);
}

function filenameOnlyResult(filename: string) {
  const title = filename.replace(/\.pdf$/i, "").replace(/_/g, " ").trim() || "Unnamed paper";
  const candidate: MetadataCandidate = {
    provider: "filename",
    confidence: 0.25,
    reason: "Automatic extraction is off; using filename",
    canonical: { itemType: "journalArticle", title, creators: [], tags: [] },
  };
  return { selected: candidate, candidates: [candidate], warnings: [] as string[] };
}

