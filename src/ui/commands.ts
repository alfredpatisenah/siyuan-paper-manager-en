import { canUseNode } from "../core/env";
import { Menu, Plugin, showMessage } from "siyuan";
import type { PluginStatus } from "../types/status";
import { currentDocumentId } from "./dom";
import { errorMessage } from "../core/errors";

export type DocKind = "library" | "paper" | null;

export interface PaperUiActions {
  importPdf: () => Promise<void>;
  translate: (docId: string) => Promise<void>;
  editMetadata: (docId: string) => Promise<void>;
  repair: (docId: string) => Promise<void>;
  translateLibrary: (docId: string) => Promise<void>;
  exportLibrary: (docId?: string) => Promise<void>;
  openSettings: () => void;
  selfCheck: () => Promise<void>;
  toggleConnector: () => Promise<void>;
  getStatus: () => PluginStatus;
  /** Synchronously read document index: only documents with paper-library metadata return "paper". */
  detectDocKind: (docId: string) => DocKind;
}

export function registerPaperUi(
  plugin: Plugin,
  actions: PaperUiActions,
): () => void {
  plugin.addCommand({
    langKey: "import-local-pdf",
    langText: "Paper·Import local PDF",
    hotkey: "⌥I",
    callback: () => { void run(actions.importPdf); },
  });
  plugin.addCommand({
    langKey: "export-library-citations",
    langText: "Paper·Export library citations",
    callback: () => { void run(() => actions.exportLibrary(currentDocumentId() ?? undefined)); },
  });
  plugin.addCommand({
    langKey: "edit-paper-metadata",
    langText: "Paper·Edit metadata",
    callback: () => { void withCurrentDoc(actions.editMetadata); },
  });
  plugin.addCommand({
    langKey: "refresh-paper-meta",
    langText: "Paper·Refresh metadata summary",
    hotkey: "⌥E",
    callback: () => { void withCurrentDoc(actions.repair); },
  });
  if (canUseNode()) plugin.addCommand({
    langKey: "translate-current-paper",
    langText: "Paper·Translate this document",
    hotkey: "⌥T",
    callback: () => { void withCurrentDoc(actions.translate); },
  });
  plugin.addCommand({
    langKey: "paper-manager-status",
    langText: "Paper·Environment check",
    callback: () => { void run(actions.selfCheck); },
  });

  plugin.addTopBar({
    icon: "iconFiles",
    title: "Paper Manager",
    position: "right",
    callback: (event) => openQuickMenu(event, actions),
  });

  const contentListener = (event: CustomEvent<any>) => {
    const docId = event.detail.protyle?.block?.rootID as string | undefined;
    if (docId) void addPaperItems(event.detail.menu, docId, actions);
  };
  const treeListener = (event: CustomEvent<any>) => {
    if (event.detail.type !== "doc" || event.detail.items?.length !== 1) return;
    const docId = event.detail.items[0]?.id as string | undefined;
    if (docId) void addPaperItems(event.detail.menu, docId, actions);
  };
  plugin.eventBus.on("open-menu-content", contentListener);
  plugin.eventBus.on("open-menu-breadcrumbmore", contentListener);
  plugin.eventBus.on("click-editortitleicon", contentListener);
  plugin.eventBus.on("open-menu-doctree", treeListener);
  return () => {
    plugin.eventBus.off("open-menu-content", contentListener);
    plugin.eventBus.off("open-menu-breadcrumbmore", contentListener);
    plugin.eventBus.off("click-editortitleicon", contentListener);
    plugin.eventBus.off("open-menu-doctree", treeListener);
  };
}

function openQuickMenu(event: MouseEvent, actions: PaperUiActions): void {
  const menu = new Menu("paper-manager-quick-menu");
  menu.addItem({ icon: "iconDownload", label: "Paper·Import local PDF", click: () => run(actions.importPdf) });
  menu.addItem({ icon: "iconUpload", label: "Paper·Export library citations", click: () => run(() => actions.exportLibrary(currentDocumentId() ?? undefined)) });
  menu.addSeparator();
  const status = actions.getStatus().connector;
  if (canUseNode()) menu.addItem({
    icon: status.state === "listening" ? "iconPause" : "iconPlay",
    label: status.state === "listening" ? "Paper·Stop Zotero intake" : "Paper·Start Zotero intake",
    click: () => run(actions.toggleConnector),
  });
  menu.addItem({ icon: "iconInfo", label: "Paper·Environment check", click: () => run(actions.selfCheck) });
  menu.addItem({ icon: "iconSettings", label: "Paper·Plugin settings", click: actions.openSettings });
  menu.open(topBarMenuPosition(event));
}

/**
 * Anchor a right-side top-bar menu to the button rather than the pointer.
 *
 * SiYuan positions a menu's left edge at `x` by default. A menu opened near
 * the right viewport edge can therefore be moved to an incorrect fallback
 * position. `isLeft` makes `x` the menu's right edge, while the button bounds
 * keep the placement stable regardless of where inside the icon was clicked.
 */
export function topBarMenuPosition(event: MouseEvent): {
  x: number;
  y: number;
  isLeft: true;
} {
  const anchor = event.currentTarget as Partial<HTMLElement> | null;
  const rect = anchor?.getBoundingClientRect?.();
  if (rect && Number.isFinite(rect.right) && Number.isFinite(rect.bottom)) {
    return { x: rect.right, y: rect.bottom, isLeft: true };
  }
  return { x: event.clientX, y: event.clientY, isLeft: true };
}

function addPaperItems(
  menu: { addItem: (item: any) => unknown; addSeparator?: () => unknown },
  docId: string,
  actions: PaperUiActions,
): void {
  try {
    const kind = actions.detectDocKind(docId);
    if (kind === "library") {
      menu.addSeparator?.();
      menu.addItem({ icon: "iconUpload", label: "Paper·Export library citations", click: () => run(() => actions.exportLibrary(docId)) });
      if (canUseNode()) menu.addItem({ icon: "iconLanguage", label: "Paper·Batch-translate untranslated papers", click: () => run(() => actions.translateLibrary(docId)) });
      return;
    }
    if (kind !== "paper") return;
    menu.addSeparator?.();
    menu.addItem({ icon: "iconEdit", label: "Paper·Edit metadata", click: () => run(() => actions.editMetadata(docId)) });
    if (canUseNode()) menu.addItem({ icon: "iconLanguage", label: "Paper·Translate this document", click: () => run(() => actions.translate(docId)) });
    menu.addItem({ icon: "iconRefresh", label: "Paper·Refresh metadata summary", click: () => run(() => actions.repair(docId)) });
  } catch (error) {
    console.debug("[paper-manager] paper detection in context menu failed", error);
  }
}

async function withCurrentDoc(action: (docId: string) => Promise<void>): Promise<void> {
  const docId = currentDocumentId();
  if (!docId) {
    showMessage("Please open a paper page first", 4000, "error");
    return;
  }
  await run(() => action(docId));
}

async function run(action: (() => Promise<void>) | Promise<void>): Promise<void> {
  try {
    await (typeof action === "function" ? action() : action);
  } catch (error) {
    showMessage(`Paper Manager action failed: ${errorMessage(error)}`, 6000, "error");
  }
}

