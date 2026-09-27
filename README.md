# siyuan-paper-manager

SiYuan desktop and mobile paper-management plugin: receives Zotero Connector items and attachments, manages multiple paper libraries with the native SiYuan database, and directly maintains metadata and citations inside database rows and paper pages.

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)
![SiYuan](https://img.shields.io/badge/SiYuan-%3E%3D3.8.1-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)

> A paper library is a real document, and the database is its content—no hidden black box. All data lives in your notebook, where it can be searched, sorted, and synced.

## Features

- 📚 **Native database paper library**: each paper library is a real SiYuan document containing a native database (table view); each paper is a child document of the library document, and database rows are kept in sync with paper pages.
- 🗂️ **Multiple libraries + project grouping**: create multiple libraries and choose a default library; fill or multi-select the “Project” field directly in the database without creating project groups in settings; new libraries include a default “Project” column.
- ✏️ **Database as the editing entry**: title, author, year, DOI, tags, abstract, and 18 metadata columns are ready to edit directly in the database; paper-page metadata summaries can be refreshed with one click.
- 🌐 **Zotero Connector intake**: listens on `127.0.0.1:23119`; when you click the Zotero Connector in the browser, a metadata details dialog appears first; confirm or edit it before the item is added; item, PDF, and webpage snapshots are stored with preserved links.
- 📄 **Local PDF import**: extracts embedded XMP/document properties from PDFs; if no valid title is found, it derives one from text size and position; combines DOI → Crossref → Citoid for stepwise identification; supports Chinese metadata recognition (CNKI) and multiple file-based extraction strategies.
- 🌍 **pdf2zh translation**: runs the local pdf2zh engine to generate monolingual or bilingual PDFs; progress is shown in the status bar; multiple papers can be queued and run in parallel according to settings (default 1, max 8); after retranslation, old versions can be cleaned up automatically.
- 🛠️ **pdf2zh deployment helper (experimental)**: the settings panel scans and manages the local pdf2zh installation; it can edit the managed config in either visual mode or JSON mode; secrets are reduced to the names of the SiYuan “Secrets and Variables” entries, not the raw values.
- 🔖 **Citation export**: GB/T 7714—2015 (sequential code / author-year), APA 7, IEEE, BibTeX, BibLaTeX, Typst Hayagriva, plus LaTeX `\cite` / `\parencite` / `\textcite` and Typst `@key[...]` references.

## Interface preview

| Library database | Paper page |
|---|---|
| ![Library database](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/library-database.png) | ![Paper page](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/paper-page.png) |

| Import local PDF | Citation export |
|---|---|
| ![Import local PDF](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/import-pdf.png) | ![Citation export](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/export-citations.png) |

| Top-bar quick menu | Plugin settings |
|---|---|
| ![Top-bar quick menu](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/quick-menu.png) | ![Plugin settings](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/settings.png) |

## Installation

### Marketplace install (recommended)

SiYuan Note → Settings → Marketplace → Plugins, search for “Paper Manager”, download, and enable it.

### Manual install

1. Download the latest `package.zip` from [Releases](https://github.com/fu1fan/siyuan-paper-manager/releases);
2. Extract it to `{workspace}/data/plugins/siyuan-paper-manager/`;
3. Restart SiYuan and enable it in Settings → Marketplace → Downloaded.

## v6.0.0 update (2026-09-14)

- **Batch translation**: queue and translate all untranslated papers in a library with one click; supports filtering by title, notes, author, abstract, and DOI, and shows progress and failure reasons for each paper.
- **Project-aware operations**: the document database now has a native “Project” field for organizing paper sets; library export and translation actions respect project membership.
- **Metadata pipeline upgrades**: new extraction and matching logic covers PDF metadata, DOI lookups, and Zotero recognition with better title and author handling.
- **Template-based paper pages**: new paper pages generate metadata summaries and note templates automatically, with better handling of abstract and translation state updates.
- **pdf2zh config management**: the settings page can now scan, install, repair, and edit the local pdf2zh deployment and its managed config file.

## Requirements

- SiYuan desktop or mobile environment with the plugin enabled.
- For Zotero Connector intake: a desktop client with Node support enabled.
- For pdf2zh translation: a local Python environment and the optional pdf2zh package.

## Development

```bash
pnpm install
pnpm build
```

See the `docs/` directory for architecture notes and implementation details.

## License

PolyForm Noncommercial 1.0.0.

## Repository

- Main project: https://github.com/fu1fan/siyuan-paper-manager
- English variant: https://github.com/alfredpatisenah/siyuan-paper-manager-en

