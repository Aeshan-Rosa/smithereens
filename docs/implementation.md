# Smithereens research workspace

A personal desktop research workspace based on **Zotero 10.0.9** (upstream commit `0f25aca5e5e087fa44404c134fd384e2aeca4eda`). It retains Zotero's library, paper imports, collections, tags, attachment storage, citations, notes, and original PDF/EPUB reader and annotations. The new assistant runs alongside them.

## Open the app

Open `dist/Smithereens.app` on this Mac. For the development library used in UI checks, run `scripts/run-dev.sh` from this checkout. The development library is stored under `.smithereens/profile`; a normal launch uses a separate Smithereens profile. Neither launch automatically discovers or migrates your existing Zotero database.

1. Save papers using Zotero's Add by Identifier, Add File, import, or browser Connector workflows. The Connector's existing local server is retained; run only one Zotero-compatible app at a time when saving from the browser.
2. Select papers and click **Selected** in the assistant, or open a PDF and click **Open PDF**.
3. Ask a question. Click a source chip to open that page in Zotero's reader. Hover a chip to inspect the supporting excerpt.
4. Use **Save as note** to add an answer to your library, with Zotero PDF links. Edit it using Zotero's native note editor.

The assistant can be hidden with its close button, the toolbar button, or **Cmd/Ctrl+Shift+A**. Its divider resizes the panel. Chat text is 16px; colors follow the system appearance. Item details remain available through Zotero's item-pane toggle.

## Existing subscriptions

Install and sign in to a recent Codex CLI (`codex login`) or Claude Code CLI (`claude auth login`). Choose the provider in assistant settings and click **Check connection**. A custom executable path and model name are optional. The implementation was verified with Codex CLI 0.162.1 and Claude Code CLI 2.1.319. Both providers passed a real subscription request comparing two synthetic papers with separate source citations. Claude requires an active first-party subscription login before questions can run; macOS Keychain access must be available to the process checking its status.

No API key is required. Provider children do not inherit API key overrides. Codex uses an ephemeral, read-only, isolated CLI request with user configuration, shell, plugins, hooks, and web search disabled. Claude uses safe mode with no tools or MCP servers. The app does not copy or display authentication tokens. Questions, bounded prior conversation, and selected excerpts go to the chosen provider; its subscription limits and data policies apply. Codex displays completed message events; Claude supports text deltas. Requests can be stopped and have a four-minute limit.

## Research features

- Up to 24 pinned papers in a conversation, with explicit add/remove controls.
- Collection or library retrieval using Zotero's indexed search; up to 24 matching papers are read per answer. This is a relevant-excerpt search, not an exhaustive review of the whole library.
- `@` followed by part of a title offers matching library papers to add.
- Summary, comparison, extraction table, claim check, screening, drafting, and bounded deep-review prompts. Deep review is one evidence-grounded response, not an autonomous web-research agent.
- Page-aware extraction through Zotero's SDT worker and its own text-range helpers. Round-robin retrieval balances evidence across papers within a 64,000-character excerpt budget.
- Clickable source references, excerpt previews, source warnings, abstract-only fallback, and detection of PDFs changed since an answer was generated.
- Local saved conversations, per-conversation research instructions, model selection, token counts, cancellation, and explicit connection errors.
- Crossref paper discovery and DOI import through Zotero's original translators, including duplicate detection. Search terms are sent to Crossref only when searching. [Crossref API documentation](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/).

The model is instructed to distinguish findings from interpretation and say when evidence is missing. A linked citation verifies its source and page locator, not the truth of the model's interpretation; read the original excerpt to verify claims.

Scanned PDFs without searchable text report that OCR is needed. Automatic OCR and visual interpretation of figures/equations are not implemented in this version. Reading and annotating those PDFs still uses the original Zotero viewer. Bibliographic records with no readable PDF can use their abstract, clearly labeled.

## Build and test

```sh
git submodule update --init --recursive --depth=1
git lfs pull
npm ci
app/scripts/fetch_xulrunner -p m
scripts/package-mac.sh
test/runtests.sh research reader
# Optional: compares synthetic papers using both subscriptions
SMITHEREENS_LIVE_TEST=all test/runtests.sh -f research
```

The macOS package is locally ad-hoc signed, not notarized for public distribution. Upstream application updates are disabled so they cannot replace this fork. Other platforms retain upstream build scripts but have not been packaged or verified here. The upstream dependency lockfile is preserved; npm reports inherited vulnerabilities that need a separate dependency audit before public distribution.

Main additions are `chrome/content/zotero/research/`, `researchPane.js`, and `chrome/skin/default/zotero/research.css`. `js-build/research.js` compiles the pinned upstream SDT text helpers; the reader itself is unchanged. Tests cover native UI mounting, PDF extraction and reader opening, retrieval budgeting, collection isolation, history persistence, notes, provider events, and cancellation. The optional live test checks subscription auth and a cited response.

## Upstream and license

This is a modified Zotero build, not an official Zotero release. Zotero and the incorporated code retain their notices and AGPL-3.0-or-later licensing; see `COPYING`. The repository includes the corresponding source. Zotero is a trademark of the Corporation for Digital Scholarship.

For background on the upstream source, see the [Zotero developer documentation](https://www.zotero.org/support/dev/source_code). Report Smithereens-specific issues in [the Smithereens repository](https://github.com/Aeshan-Rosa/smithereens/issues).
