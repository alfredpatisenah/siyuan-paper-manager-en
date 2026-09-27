import { Dialog, showMessage } from "siyuan";
import type { KernelClient } from "../../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../../services/library-service";
import { button, dialogFooter, escapeHtml, inputValue } from "../dom";
import { errorMessage } from "../../core/errors";

export async function openOnboardingDialog(
  kernel: KernelClient,
  libraries: LibraryService,
  onCreated: (library: PaperLibraryInfo) => Promise<void>,
  title = "Initialize paper library",
): Promise<void> {
  const notebooks = await kernel.listNotebooks();
  if (!notebooks.length) throw new Error("Create and open a notebook in SiYuan first");
  const dialog = new Dialog({
    title,
    width: "680px",
    content: `<div class="b3-dialog__content paper-manager-dialog">
      <div class="paper-manager-dialog-scroll paper-manager-form"><p class="paper-manager-hint">A paper library is a real document; the plugin creates a SiYuan database inside it. Imported papers become entries in that database.</p>
      <label class="paper-manager-field"><span>Notebook</span><select class="b3-select" data-notebook>${notebooks.map((notebook) =>
        `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.name)}</option>`).join("")}</select></label>
      <label class="paper-manager-field"><span>Library name</span><input class="b3-text-field" data-title value="Paper Library"></label>
      <label class="paper-manager-field"><span>Document path</span><input class="b3-text-field" data-path value="/Paper Library"></label>
      </div>${dialogFooter("data-actions")}
    </div>`,
  });
  const actions = dialog.element.querySelector<HTMLElement>("[data-actions]")!;
  const cancel = button("Later");
  const create = button("Create and set as default", true);
  cancel.addEventListener("click", () => dialog.destroy());
  create.addEventListener("click", async () => {
    create.disabled = true;
    create.textContent = "Creating database…";
    try {
      const notebookId = inputValue(dialog.element, "[data-notebook]");
      const libraryTitle = inputValue(dialog.element, "[data-title]") || "Paper Library";
      const hPath = normalizePath(inputValue(dialog.element, "[data-path]") || `/${libraryTitle}`);
      const library = await libraries.createLibrary(notebookId, hPath, libraryTitle);
      await onCreated(library);
      showMessage("Paper library created", 4000, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`Failed to create library: ${errorMessage(error)}`, 7000, "error");
      create.disabled = false;
      create.textContent = "Create and set as default";
    }
  });
  actions.append(cancel, create);
}

function normalizePath(value: string): string {
  const clean = value.trim().replace(/\\/g, "/").replace(/\.{2,}/g, "").replace(/\/+$/, "");
  return clean.startsWith("/") ? clean : `/${clean}`;
}

