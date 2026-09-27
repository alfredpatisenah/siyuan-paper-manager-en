import { Dialog, showMessage } from "siyuan";
import { CITATION_FORMAT_LABELS, exportCitations, type CitationExportFormat } from "../../services/citation-export";
import type { LibraryService, LibraryPaperRecord, PaperLibraryInfo } from "../../services/library-service";
import { button, escapeHtml } from "../dom";
import { errorMessage } from "../../core/errors";

/**
 * Citation export dialog: can be opened from any document, and the library is selected inside the dialog.
 * preferredDocId is the current document: if it is itself a library then select it; otherwise select its owning library.
 */
export async function openCitationExportDialog(libraries: LibraryService, preferredDocId?: string): Promise<void> {
  const all = await libraries.discoverLibraries();
  if (!all.length) {
    showMessage("No paper library exists yet; please finish initialization in settings first", 5000, "error");
    return;
  }
  let revokeTimer: ReturnType<typeof setTimeout> | undefined;
  let initialId = all[0]!.docId;
  if (preferredDocId) {
    if (all.some((library) => library.docId === preferredDocId)) {
      initialId = preferredDocId;
    } else {
      const entry = await libraries.findPaperEntry(preferredDocId);
      if (entry) initialId = entry.library.docId;
    }
  }

  const dialog = new Dialog({
    title: "Export citations",
    width: "960px",
    destroyCallback: () => { if (revokeTimer) clearTimeout(revokeTimer); },
    content: `<div class="b3-dialog__content paper-manager-form paper-manager-export">
      <div class="paper-manager-export-toolbar">
        <label class="paper-manager-field paper-manager-field--column"><span>Library</span><select class="b3-select" data-library title="Library">${all.map((library) => `<option value="${escapeHtml(library.docId)}">${escapeHtml(library.title)}</option>`).join("")}</select></label>
        <label class="paper-manager-field paper-manager-field--column"><span>Search papers</span><input class="b3-text-field" data-search placeholder="Search title, author, DOI, or citekey"></label>
        <label class="paper-manager-field paper-manager-field--column"><span>Project</span><select class="b3-select" data-project></select></label>
        <label class="paper-manager-field paper-manager-field--column"><span>Citation format</span><select class="b3-select" data-format>${Object.entries(CITATION_FORMAT_LABELS).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}</select></label>
      </div>
      <div class="paper-manager-export-body">
        <div class="paper-manager-export-side">
          <div class="paper-manager-export-side-bar">
            <span data-count></span>
            <span class="paper-manager-export-side-actions">
              <button type="button" class="b3-button b3-button--text" data-select-visible>Select visible results</button><button type="button" class="b3-button b3-button--text" data-clear>Clear</button>
            </span>
          </div>
          <div class="paper-manager-export-list" data-list></div>
        </div>
        <textarea class="b3-text-field paper-manager-export-output" aria-label="Citation preview" readonly data-output></textarea>
      </div>
      <div class="paper-manager-export-footer">
        <span class="paper-manager-hint" data-warnings></span>
        <span class="paper-manager-export-footer-actions" data-actions></span>
      </div>
    </div>`,
  });
  const list = dialog.element.querySelector<HTMLElement>("[data-list]")!;
  const output = dialog.element.querySelector<HTMLTextAreaElement>("[data-output]")!;
  const warnings = dialog.element.querySelector<HTMLElement>("[data-warnings]")!;
  const count = dialog.element.querySelector<HTMLElement>("[data-count]")!;
  const search = dialog.element.querySelector<HTMLInputElement>("[data-search]")!;
  const librarySelect = dialog.element.querySelector<HTMLSelectElement>("[data-library]")!;
  const project = dialog.element.querySelector<HTMLSelectElement>("[data-project]")!;
  const format = dialog.element.querySelector<HTMLSelectElement>("[data-format]")!;

  let library: PaperLibraryInfo = all.find((candidate) => candidate.docId === initialId)!;
  let records: LibraryPaperRecord[] = [];
  let selected = new Set<string>();
  let visible: LibraryPaperRecord[] = [];
  let loadVersion = 0;

  const refreshOutput = () => {
    const chosen = records.filter((record) => selected.has(record.docId)).map((record) => record.paper);
    const result = exportCitations(chosen, format.value as CitationExportFormat);
    output.value = result.content;
    output.dataset.extension = result.extension;
    output.dataset.mime = result.mimeType;
    warnings.textContent = result.warnings.length ? `Hint: ${result.warnings.join("; ")}` : `${chosen.length} papers are ready`;
  };
  const renderList = () => {
    const query = search.value.trim().toLocaleLowerCase();
    visible = records.filter((record) => {
      const c = record.paper.canonical;
      const text = [c.title, c.doi, record.paper.citekey, ...c.creators.map((creator) => `${creator.family} ${creator.given}`)].join(" ").toLocaleLowerCase();
      return (!query || text.includes(query)) && (!project.value || record.projectNames.includes(project.value));
    });
    list.innerHTML = visible.length ? visible.map((record) => `<label class="paper-manager-export-row"><input type="checkbox" data-doc-id="${escapeHtml(record.docId)}" ${selected.has(record.docId) ? "checked" : ""}><span>${escapeHtml(record.paper.canonical.title || record.paper.citekey)}</span></label>`).join("") : '<div class="paper-manager-preview">No matching papers</div>';
    for (const checkbox of list.querySelectorAll<HTMLInputElement>("[data-doc-id]")) checkbox.onchange = () => {
      if (checkbox.checked) selected.add(checkbox.dataset.docId!); else selected.delete(checkbox.dataset.docId!);
      refreshOutput();
    };
    count.textContent = `Selected ${selected.size} / ${records.length} papers`;
    refreshOutput();
  };
  const loadLibrary = async (docId: string) => {
    const version = ++loadVersion;
    list.innerHTML = "<div class=\"paper-manager-preview\">Loading…</div>";
    output.value = "";
    const loadedLibrary = await libraries.getLibrary(docId);
    const loadedRecords = await libraries.listPapers(docId);
    if (version !== loadVersion) return;
    library = loadedLibrary;
    records = loadedRecords;
    selected = new Set(records.map((record) => record.docId));
    search.value = "";
    const projectNames = [...new Set(records.flatMap((record) => record.projectNames))];
    project.innerHTML = `<option value="">All projects</option>${projectNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
    renderList();
  };
  librarySelect.value = initialId;
  librarySelect.onchange = () => void loadLibrary(librarySelect.value).catch((error) => {
    showMessage(`Library load failed: ${errorMessage(error)}`, 6000, "error");
  });
  search.oninput = renderList;
  project.onchange = renderList;
  format.onchange = refreshOutput;
  dialog.element.querySelector<HTMLButtonElement>("[data-select-visible]")!.onclick = () => { for (const record of visible) selected.add(record.docId); renderList(); };
  dialog.element.querySelector<HTMLButtonElement>("[data-clear]")!.onclick = () => { selected.clear(); renderList(); };

  const cancel = button("Close");
  const copy = button("Copy", false);
  const download = button("Download file", true);
  cancel.onclick = () => dialog.destroy();
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      showMessage("Citations copied", 3000, "info");
    } catch (error) {
      showMessage(`Copy failed; please manually select the preview content: ${errorMessage(error)}`, 6000, "error");
    }
  };
  download.onclick = () => {
    const blob = new Blob([output.value], { type: output.dataset.mime ?? "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(library.title)}-references.${output.dataset.extension ?? "txt"}`;
    anchor.click();
    revokeTimer = setTimeout(() => { revokeTimer = undefined; URL.revokeObjectURL(url); }, 1000);
  };
  dialog.element.querySelector<HTMLElement>("[data-actions]")!.append(cancel, copy, download);
  await loadLibrary(initialId);
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?\"<>|]/g, "_").slice(0, 100) || "library";
}

