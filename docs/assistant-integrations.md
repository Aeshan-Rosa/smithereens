# Assistant integration notes

The November 2026 update replaces one-process-per-question requests with retained provider connections and separate Claude Code/Codex conversations. Smithereens keeps Zotero's native library and reader. Its sidebar is an original research client; it does not embed or redistribute the proprietary VS Code extensions.

## What the VS Code integrations do

Inspection of the locally installed extensions confirmed a retained webview connected to a provider backend. Keeping the view and process alive preserves conversation state when the panel is hidden or another view is selected. The useful behavior to reproduce is streamed events, persistent conversations, context attachment, model selection, cancellation, and independent history.

- **Codex:** [App Server](https://learn.chatgpt.com/docs/app-server) is the backend used by rich clients, including the VS Code extension. Smithereens starts `codex app-server --listen stdio://`, initializes JSON-RPC, checks for a ChatGPT account, loads the model catalog, starts an ephemeral thread, and submits turns. Agent-message deltas update the answer; turn completion finalizes it; `turn/interrupt` stops it.
- **Claude Code:** the [VS Code integration](https://code.claude.com/docs/en/vs-code) pairs a sidebar with Claude Code. Smithereens uses the local CLI's [programmatic streaming mode](https://code.claude.com/docs/en/headless), with stream-json input/output, partial messages, and control requests for initialization/model discovery and interruption. Standard safe mode preserves subscription authentication, including macOS Keychain access.

Verified against Codex CLI **0.162.1** and Claude Code CLI **2.1.319**. Provider protocols may change; authentication or initialization failures are displayed rather than silently falling back to API billing.

## Implementation

| Component | Responsibility |
| --- | --- |
| `research/connection.js` | JSONL framing, request IDs, control responses, bounded diagnostics, shutdown, and denial of unsupported tool/approval requests. |
| `research/clients.js` | Provider initialization, model catalogs, text deltas, completion, usage, interruption, and turn lifecycle. |
| `research/providers.js` | CLI discovery, subscription checks, controlled process environment, connection cache, and reconnection after context changes. |
| `research/service.js` | Local history, active sessions, migration backup, source extraction, notes, and PDF navigation. |
| `researchPane.js` | Separate tabs/drafts, per-provider history and model menus, background responses, safe Markdown, and citations. |

A conversation owns its response, cancellation controller, and status. Switching tabs does not reassign an in-flight request. UI updates are batched and preserve the reader's scroll position when they have scrolled away from the bottom. The composer remains available for drafting the next question.

Current evidence is supplied for every turn. After a restart or context change, the app replays at most eight recent messages, each capped at 8,000 characters. Excerpts retain the existing 64,000-character limit and 24-paper cap. The provider is instructed to cite the current turn's evidence IDs; saved answers retain their own excerpt maps.

Provider coding tools are intentionally outside this research feature. Filesystem, shell, MCP, plugin, and browsing features are disabled by the launch configuration. The panel supports paper questions and research outputs, rather than a general coding agent or autonomous web researcher.

## Verification

- 14 standalone tests cover evidence retrieval, migration, JSONL framing, completion without duplication, rejected tool requests, cancellation, and shutdown.
- 25 native checks cover the sidebar, tab isolation, background streaming, safe Markdown/citations, visible model selection, searchable history, command menus, keyboard dismissal, persistence, notes, collection filtering, and Zotero's original reader.
- Live subscription checks for both providers require multiple streamed updates, cited comparisons of two synthetic papers, populated model menus, and a follow-up answered from the retained conversation.

## Extension UI reference pass

The sidebar layout was compared with the installed Claude Code 2.1.220 and Codex 26.727.40816 UI assets and the vendors' [Claude Code screenshots](https://code.claude.com/docs/en/vs-code) and [Codex IDE reference](https://learn.chatgpt.com/docs/codex/ide). The temporary VS Code host initially failed to render its extension webviews reliably, so the implementation used the official visual references and installed styles. During final verification, the actual Claude Code webview loaded and its toolbar, session list, and composer were inspected directly. The live Codex panel remained blank; its visual reference was the official IDE page and installed UI assets.

The implementation is original HTML/CSS in Zotero's native Gecko window. It recreates compact headers, prompt cards, inline attachment chips, a growing composer, icon controls, model menus, searchable history, and provider-specific colors. It does not load either vendor's proprietary webview bundle. Coding-specific controls, cloud sessions, agent tool cards, and their complete settings surfaces are not reproduced. All controls shown here operate on Smithereens paper conversations.
