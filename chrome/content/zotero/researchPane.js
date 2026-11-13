/* SPDX-License-Identifier: AGPL-3.0-or-later */
var ResearchPane = new function () {
	let service, session, labels, root, messages, sources, composer, status, settings, history, mentions, projectInstructions;
	let tabs, modelInput, executableInput, draftTimer, markdown, mentionRequest = 0;
	let controllers = new Map(), statuses = new Map(), catalogs = new Map(), catalogRequests = new Map();
	let popovers = [], activePopover, popoverTrigger, modelButton, modelMenu, sourcePicker, quick, historyList, historySearch, conversationTitle;
	let busy = () => controllers.has(session?.id);
	let ready = false;
	let html = (tag, props = {}, ...children) => {
		let node = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
		for (let [key, value] of Object.entries(props)) {
			if (value === undefined) continue;
			if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
			else if (key === 'className') node.className = value;
			else node.setAttribute(key, value);
		}
		node.append(...children.filter(x => x !== undefined));
		return node;
	};
	let button = (label, action, props = {}) => html('button', { type: 'button', onclick: () => safely(action), ...props }, label);
	// Original line icons keep the extension-style controls crisp at small sizes.
	let icon = name => {
		let paths = {
			plus: 'M8 2v12M2 8h12', close: 'M4 4l8 8M12 4l-8 8',
			history: 'M2 7a6 6 0 1 1 1 5M2 2v5h5M8 4v4l3 2',
			settings: 'M3 4h10M3 8h10M3 12h10M6 2v4M10 6v4M6 10v4',
			send: 'M8 13V3M3 8l5-5 5 5', stop: 'M4 4h8v8H4z',
			chevron: 'M5 6l3 3 3-3', paper: 'M4 1h5l3 3v11H4zM9 1v4h3M6 8h4M6 11h4',
			copy: 'M6 5h7v9H6zM10 5V2H3v9h3', note: 'M3 2h10v9l-3 3H3zM10 14v-3h3M6 5h4M6 8h4',
			slash: 'M10 2L6 14', check: 'M3 8l3 3 7-7', down: 'M8 3v10M3 8l5 5 5-5'
		};
		let svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		for (let [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
		let path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path);
		return svg;
	};
	let iconButton = (name, label, action, props = {}) => button(icon(name), action, { className: 'research-icon-button', title: label, 'aria-label': label, ...props });
	let safely = async action => {
		try { await action(); }
		catch (error) { setStatus(error.message, true); Zotero.logError(error); }
	};
	let setStatus = (text, error = false) => {
		status.textContent = text;
		status.classList.toggle('error', error);
		status.hidden = !text || text === labels?.ready || text === labels?.responding;
	};

	this.init = async function () {
		if (ready) return;
		ready = true;
		root = document.getElementById('research-pane');
		let keys = ['title', 'new', 'history', 'settings', 'close', 'sources', 'selected', 'current', 'collection', 'library', 'send', 'stop', 'placeholder', 'empty', 'summary', 'compare', 'matrix', 'claims', 'screen', 'draft', 'deep', 'save-note', 'copy', 'check', 'provider', 'model', 'instructions', 'path', 'disclosure', 'ready', 'remove', 'clear', 'discover', 'tabs', 'actions', 'working', 'responding', 'connecting', 'models', 'default-model', 'context', 'send-hint', 'attach', 'search-history', 'no-history', 'commands', 'refresh-models', 'auto-context', 'claude-welcome', 'codex-welcome', 'welcome-detail', 'evidence', 'jump-latest', 'close-menu'];
		let values = await document.l10n.formatValues(keys.map(key => ({ id: `research-${key}` })));
		labels = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
		let Service = require('zotero/research/service');
		service = new Service(Zotero);
		status = html('div', { className: 'research-status', role: 'status', 'aria-live': 'polite' });
		try { await service.load(); }
		catch (e) { root.append(status); setStatus(e.message, true); return; }
		session = service.activeSession(service.state.settings.provider);
		markdown = require('resource://zotero/research-markdown.js')({ html: false, linkify: false, breaks: true });
		markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
		tabs = html('div', { className: 'research-tabs', role: 'tablist', 'aria-label': labels.tabs },
			...['claude', 'codex'].map(provider => button(provider === 'claude' ? 'Claude Code' : 'Codex', () => activate(service.activeSession(provider)),
				{ role: 'tab', id: `research-tab-${provider}`, 'aria-controls': 'research-conversation' })));
		let header = html('header', { className: 'research-header' }, tabs,
			iconButton('close', labels.close, () => this.toggle()));
		conversationTitle = button('', () => togglePopover(history, conversationTitle), { className: 'research-conversation-title', 'aria-label': labels.history, 'aria-haspopup': 'dialog' });
		let toolbar = html('div', { className: 'research-toolbar' }, conversationTitle, html('div', { className: 'research-actions' },
			iconButton('history', labels.history, () => togglePopover(history, document.getElementById('research-history-toggle')), { id: 'research-history-toggle', 'aria-haspopup': 'dialog' }),
			iconButton('settings', labels.settings, () => togglePopover(settings, document.getElementById('research-settings-toggle')), { id: 'research-settings-toggle', 'aria-haspopup': 'dialog' }),
			iconButton('plus', labels.new, () => activate(service.newSession(session.provider)))));
		tabs.addEventListener('keydown', event => {
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault(); safely(async () => { await activate(service.activeSession(session.provider === 'codex' ? 'claude' : 'codex')); document.getElementById(`research-tab-${session.provider}`).focus(); });
			}
		});
		historySearch = html('input', { type: 'search', placeholder: labels['search-history'], 'aria-label': labels['search-history'], oninput: () => renderHistory() });
		historyList = html('div', { className: 'research-history-list' });
		history = makePopover('research-history', labels.history, historySearch, historyList);
		settings = buildSettings();
		sources = html('div', { className: 'research-source-list', 'aria-label': labels.context });
		sourcePicker = makePopover('research-sources', labels.attach,
			html('div', { className: 'research-source-actions' },
				...['current', 'selected', 'collection', 'library'].map(scope => button(labels[scope], async () => { await addSources(scope); closePopover(); composer.focus(); }))), buildDiscovery());
		messages = html('div', { id: 'research-conversation', className: 'research-messages', role: 'tabpanel', 'aria-label': labels.title, tabindex: '0' });
		mentions = html('div', { className: 'research-mentions', hidden: 'hidden', 'aria-label': 'Matching papers' });
		composer = html('textarea', { rows: '2', placeholder: labels.placeholder, 'aria-label': labels.placeholder,
			onkeydown: event => {
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); safely(send); }
			} });
		let mentionTimer;
		composer.addEventListener('input', () => {
			session.draft = composer.value;
			resizeComposer();
			if (composer.value === '/') togglePopover(quick, document.getElementById('research-command-toggle'), false);
			else if (activePopover === quick) closePopover(false);
			clearTimeout(draftTimer);
			draftTimer = setTimeout(() => safely(() => service.save()), 250);
			clearTimeout(mentionTimer);
			let request = ++mentionRequest;
			let match = composer.value.match(/@([^@\n]{2,})$/);
			if (!match) { mentions.hidden = true; return; }
			mentionTimer = setTimeout(() => safely(async () => {
				let search = new Zotero.Search(); search.libraryID = ZoteroPane.getSelectedLibraryIDs()[0];
				search.addCondition('title', 'contains', match[1]);
				let items = await Zotero.Items.getAsync((await search.search()).slice(0, 6));
				if (request !== mentionRequest) return;
				mentions.replaceChildren(...items.filter(i => i.isRegularItem()).map(item => button(item.getField('title'), async () => {
					if (busy()) return;
					let current = session;
					await mergeSources(await service.resolve([item]), current);
					if (session !== current) return;
					composer.value = composer.value.replace(/@[^@\n]+$/, `“${item.getField('title')}” `);
					session.draft = composer.value; await service.save();
					mentions.hidden = true; resizeComposer(); composer.focus();
				})));
				mentions.hidden = !mentions.childElementCount;
			}), 180);
		});
		let templates = {
			summary: 'Summarize the research questions, methods, findings and limitations of each paper.',
			compare: 'Compare these papers: research question, approach, data, results, limitations, agreements and contradictions. Cite each row.',
			matrix: 'Create an evidence extraction table with one row per paper and columns for population/data, method, baseline, outcome, key numbers and limitations. Cite each populated cell. Mark missing data as not reported.',
			claims: 'Check this claim against the selected papers. Separate supporting, contradicting and missing evidence, with citations. Claim: ',
			screen: 'Screen each paper against these inclusion and exclusion criteria. Return include, exclude or uncertain, a reason, and evidence. Criteria: ',
			draft: 'Draft a concise literature synthesis using these papers. Organize by themes, distinguish evidence from interpretation, and cite every substantive claim. Topic: ',
			deep: 'Conduct a bounded evidence review of the provided excerpts: map the central claims, compare methods and results, identify contradictions and gaps, then synthesize with citations. List what cannot be assessed from these excerpts.'
		};
		quick = makePopover('research-quick', labels.commands, ...Object.entries(templates).map(([key, text]) => button(labels[key], () => {
			session.draft = text; composer.value = text; closePopover(); resizeComposer(); composer.focus(); safely(() => service.save());
		})));
		let sendButton = iconButton('send', labels.send, send, { className: 'research-icon-button research-primary', id: 'research-send' });
		let stopButton = iconButton('stop', labels.stop, () => controllers.get(session.id)?.abort(), { className: 'research-icon-button research-primary', id: 'research-stop', hidden: 'hidden' });
		modelButton = button('', async () => {
			togglePopover(modelMenu, modelButton);
			if (!modelMenu.hidden) await loadModels();
		}, { id: 'research-model-toggle', className: 'research-model-button', 'aria-label': labels.models, 'aria-haspopup': 'dialog' });
		modelMenu = makePopover('research-model-menu', labels.models);
		let composerBox = html('div', { className: 'research-composer' }, sources, composer,
			html('div', { className: 'research-compose-actions' },
				iconButton('plus', labels.attach, () => togglePopover(sourcePicker, document.getElementById('research-source-toggle')), { id: 'research-source-toggle', 'aria-haspopup': 'dialog' }),
				modelButton, html('span', { className: 'research-toolbar-spacer' }),
				iconButton('slash', labels.commands, () => togglePopover(quick, document.getElementById('research-command-toggle')), { id: 'research-command-toggle', 'aria-haspopup': 'dialog' }),
				stopButton, sendButton));
		root.append(header, toolbar, messages,
			html('footer', {}, status, mentions, composerBox),
			history, settings, sourcePicker, quick, modelMenu);
		root.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				if (activePopover || !mentions.hidden) { event.preventDefault(); closePopover(); mentions.hidden = true; composer.focus(); }
				else if (busy()) { event.preventDefault(); controllers.get(session.id)?.abort(); }
			}
			if (activePopover && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				let items = [...activePopover.querySelectorAll('button:not(:disabled), input, textarea')];
				let index = items.indexOf(document.activeElement);
				if (items.length) { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
			}
		});
		document.addEventListener('pointerdown', event => {
			if (activePopover && !activePopover.contains(event.target) && !popoverTrigger?.contains(event.target)) closePopover(false);
		});
		new ResizeObserver(() => resizeComposer()).observe(root);
		render();
		setStatus(labels.ready);
		if (!Zotero.Prefs.get('research.initialized')) {
			ZoteroPane.itemPane.collapsed = true;
			Zotero.Prefs.set('research.initialized', true);
		}
		window.addEventListener('keydown', event => {
			if ((Zotero.isMac ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
				event.preventDefault(); this.toggle();
			}
		});
		let onSelection = ({ reader, doc, params, append }) => {
			let control = doc.createElement('button');
			control.textContent = 'Ask assistant';
			control.addEventListener('click', () => safely(async () => {
				if (busy()) return;
				let current = session;
				this.show();
				let docs = await service.resolve([Zotero.Items.get(reader.itemID)]);
				await mergeSources(docs, current);
				if (session !== current) return;
				composer.value = `Explain this passage in context:\n\n${params.annotation.text}`;
				session.draft = composer.value; await service.save(); resizeComposer(); composer.focus();
			}));
			append(control);
		};
		Zotero.Reader.registerEventListener('renderTextSelectionPopup', onSelection);
		window.addEventListener('unload', () => {
			clearTimeout(draftTimer);
			for (let controller of controllers.values()) controller.abort();
			service.providers.dispose();
			service.save().catch(error => Zotero.logError(error));
			Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', onSelection);
		}, { once: true });
	};

	this.show = function () {
		document.getElementById('research-pane').hidden = false;
		document.getElementById('research-splitter').hidden = false;
	};
	this.toggle = function () {
		let pane = document.getElementById('research-pane');
		pane.hidden = !pane.hidden;
		document.getElementById('research-splitter').hidden = pane.hidden;
		if (!pane.hidden) composer?.focus();
	};

	async function activate(next) {
		mentionRequest++;
		session.draft = composer.value;
		session = next;
		service.state.settings.provider = session.provider;
		service.state.activeSessions[session.provider] = session.id;
		mentions.hidden = true; closePopover(false);
		root.dataset.provider = session.provider;
		render();
		await service.save();
		composer.focus();
	}

	function makePopover(className, title, ...children) {
		let pane = html('section', { className: `research-popover ${className}`, hidden: 'hidden', role: 'dialog', 'aria-label': title },
			html('div', { className: 'research-popover-heading' }, html('strong', {}, title), iconButton('close', labels['close-menu'], () => closePopover())), ...children);
		popovers.push(pane);
		return pane;
	}

	function closePopover(restoreFocus = true) {
		for (let pane of popovers) pane.hidden = true;
		popoverTrigger?.setAttribute('aria-expanded', 'false');
		if (restoreFocus) popoverTrigger?.focus();
		activePopover = null;
	}

	function togglePopover(pane, trigger, focus = true) {
		let open = pane.hidden;
		closePopover(false);
		if (!open) return;
		popoverTrigger = trigger; activePopover = pane; pane.hidden = false;
		trigger?.setAttribute('aria-expanded', 'true');
		if (pane === history) { historySearch.value = ''; renderHistory(); }
		if (focus) (pane.querySelector('input, textarea') || pane.querySelector('button'))?.focus();
	}

	function resizeComposer() {
		if (!composer || root.hidden) return;
		composer.style.height = 'auto';
		composer.style.height = Math.min(180, Math.max(54, composer.scrollHeight)) + 'px';
	}

	async function selectModel(value) {
		if (busy()) return;
		service.state.settings.models[session.provider] = value;
		modelInput.value = value; renderModels(); closePopover(); composer.focus();
		await service.save();
	}

	async function loadModels() {
		let provider = session.provider;
		if (catalogRequests.has(provider)) return catalogRequests.get(provider);
		let request = (async () => {
			try {
				let prefs = service.state.settings;
				let client = await service.providers.connect({ provider, model: prefs.models[provider], executable: prefs.executables[provider] });
				catalogs.set(provider, client.models);
			}
			catch (error) { if (session.provider === provider) setStatus(error.message, true); }
			finally { catalogRequests.delete(provider); if (session.provider === provider) renderModels(); }
		})();
		catalogRequests.set(provider, request); renderModels();
		return request;
	}

	function renderModels() {
		let selected = service.state.settings.models[session.provider] || '';
		let options = [{ value: '', label: labels['default-model'] }, ...(catalogs.get(session.provider) || [])];
		if (selected && !options.some(o => o.value === selected)) options.push({ value: selected, label: selected });
		modelButton.disabled = busy();
		modelButton.dataset.value = selected;
		let chosen = options.find(option => option.value === selected);
		modelButton.replaceChildren(html('span', {}, chosen.label), icon('chevron'));
		modelButton.title = chosen.label;
		let heading = modelMenu.firstElementChild;
		modelMenu.replaceChildren(heading, ...options.map(option => button(html('span', {}, option.label), () => selectModel(option.value),
			{ className: option.value === selected ? 'active' : '', 'data-value': option.value, 'aria-pressed': String(option.value === selected), disabled: busy() ? 'disabled' : undefined })),
			button(catalogRequests.has(session.provider) ? labels.connecting : labels['refresh-models'], loadModels, { className: 'research-menu-secondary' }));
	}

	function updateControls() {
		document.getElementById('research-send').disabled = busy();
		document.getElementById('research-stop').hidden = !busy();
		document.getElementById('research-send').hidden = busy();
		root.dataset.provider = session.provider;
		conversationTitle.replaceChildren(html('span', {}, session.messages.length ? session.title : labels.new), icon('chevron'));
		conversationTitle.title = session.title;
		composer.placeholder = busy() ? labels['working'] : labels.placeholder;
		for (let tab of tabs.children) {
			let provider = tab.id.replace('research-tab-', '');
			let selected = session.provider === provider;
			tab.setAttribute('aria-selected', String(selected));
			tab.setAttribute('tabindex', selected ? '0' : '-1');
			tab.classList.toggle('running', service.state.sessions.some(s => s.provider === provider && controllers.has(s.id)));
		}
		messages.setAttribute('aria-labelledby', `research-tab-${session.provider}`);
		let state = statuses.get(session.id);
		setStatus(state?.text || labels.ready, state?.error);
		renderModels();
	}

	function buildSettings() {
		modelInput = html('input', { placeholder: labels['default-model'], 'aria-label': labels.model });
		executableInput = html('input', { placeholder: 'Auto-detect', 'aria-label': labels.path });
		projectInstructions = html('textarea', { rows: '3', 'aria-label': labels.instructions });
		let persist = () => safely(async () => {
			if (busy()) return;
			service.state.settings.models[session.provider] = modelInput.value.trim();
			service.state.settings.executables[session.provider] = executableInput.value.trim();
			session.instructions = projectInstructions.value;
			renderModels(); await service.save();
		});
		for (let node of [modelInput, executableInput, projectInstructions]) node.addEventListener('change', persist);
		let check = button(labels.check, async () => {
			if (busy()) return;
			let current = session, prefs = service.state.settings;
			check.disabled = true;
			try {
				setStatus(labels.connecting);
				let result = await service.providers.status(current.provider, prefs.executables[current.provider]);
				if (result.connected) {
					let client = await service.providers.connect({ provider: current.provider, model: prefs.models[current.provider], executable: prefs.executables[current.provider] });
					catalogs.set(current.provider, client.models);
				}
				statuses.set(current.id, { text: result.connected ? `Connected · ${result.message}` : result.message, error: !result.connected });
				if (session === current) updateControls();
			}
			finally { check.disabled = false; }
		});
		return makePopover('research-settings', labels.settings,
			html('label', {}, labels.model, modelInput), html('label', {}, labels.path, executableInput),
			html('label', {}, labels.instructions, projectInstructions), check, html('p', { className: 'research-disclosure' }, labels.disclosure));
	}

	function buildDiscovery() {
		let input = html('input', { placeholder: 'Title, DOI, or research topic', 'aria-label': 'Find papers on Crossref' });
		let results = html('div', { className: 'research-discovery-results' });
		let search = button('Search Crossref', async () => {
			search.disabled = true;
			try {
				setStatus('Searching Crossref…');
				let works = await service.discover(input.value);
				results.replaceChildren(...works.map(work => {
					let save = button('Save to library', async () => {
						save.disabled = true;
						try {
							let search = new Zotero.Search(); search.libraryID = ZoteroPane.getSelectedLibraryIDs()[0];
							search.addCondition('DOI', 'is', work.DOI);
							let existing = await search.search();
							if (existing.length) { await ZoteroPane.selectItem(existing[0]); save.textContent = 'Already saved'; return; }
							let items = await Zotero_Lookup.addItemsFromIdentifier({ value: work.DOI }, false, () => {});
							if (!items?.length) throw new Error('The DOI could not be imported. Try Zotero’s Add by Identifier button.');
							save.textContent = 'Saved'; setStatus('Saved to the selected Zotero library and collection.');
						}
						catch (e) { save.disabled = false; throw e; }
					});
					return html('article', {}, html('strong', {}, work.title[0]),
						html('small', {}, `${work.author?.[0]?.family || ''} · ${work.published?.['date-parts']?.[0]?.[0] || ''} · ${work.DOI}`), save);
				}));
				setStatus(`${works.length} results · imports use the currently selected library and collection.`);
			}
			finally { search.disabled = false; }
		});
		input.addEventListener('keydown', e => { if (e.key === 'Enter') search.click(); });
		return html('details', { className: 'research-discovery' }, html('summary', {}, labels.discover),
			html('p', {}, 'Search public metadata. Your search terms are sent to Crossref.'), input, search, results);
	}

	function mergeSources(docs, current = session) {
		if (controllers.has(current.id)) return;
		if (current.sources.length + docs.filter(d => !current.sources.some(s => s.parentID === d.parentID)).length > 24) throw new Error('A conversation supports up to 24 pinned papers. Remove some sources first.');
		for (let doc of docs) {
			if (!current.sources.some(x => x.parentID === doc.parentID)) current.sources.push(doc);
		}
		if (session === current) renderSources();
		return service.save();
	}

	async function addSources(scope) {
		if (busy()) return;
		let current = session;
		let items;
		if (scope === 'current') {
			let reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
			if (!reader) throw new Error('Open a PDF tab first.');
			items = [Zotero.Items.get(reader.itemID)];
		}
		else if (scope === 'selected') items = ZoteroPane.getSelectedItems();
		else if (scope === 'collection') {
			let collection = ZoteroPane.getSelectedCollections()[0];
			if (!collection) throw new Error('Select a collection in the library first.');
			items = collection.getChildItems();
			if (items.length > 24) {
				session.scope = { libraryID: collection.libraryID, collectionID: collection.id, name: collection.name };
				renderSources(); await service.save(); setStatus('Collection search enabled. Ask a specific research question.'); return;
			}
		}
		else {
			let libraryID = ZoteroPane.getSelectedLibraryIDs()[0];
			session.scope = { libraryID, name: Zotero.Libraries.get(libraryID).name };
			renderSources(); await service.save(); setStatus('Library search enabled. Ask a specific research question.'); return;
		}
		if (!items.length) throw new Error('Select one or more papers in the library first.');
		if (items.length > 24) throw new Error('Choose up to 24 papers for one conversation. Select a smaller collection or a subset in the library.');
		let docs = await service.resolve(items);
		await mergeSources(docs, current);
		if (session === current) setStatus(`${current.sources.length} papers in this conversation`);
	}

	function renderSources() {
		sources.replaceChildren(...session.sources.map(source => html('div', { className: 'research-source' },
			button(source.title, () => source.itemID ? Zotero.Reader.open(source.itemID) : ZoteroPane.selectItem(source.parentID), { title: source.title }),
			button('×', async () => { if (busy()) return; session.sources = session.sources.filter(x => x !== source); renderSources(); await service.save(); }, { 'aria-label': `${labels.remove} ${source.title}` }))));
		if (session.scope) sources.prepend(html('div', { className: 'research-scope' },
			html('small', {}, `Search: ${session.scope.name} · up to 24 matching papers per answer`),
			button('×', async () => { if (busy()) return; delete session.scope; renderSources(); await service.save(); }, { 'aria-label': 'Remove search scope' })));
		if (!session.sources.length && !session.scope) sources.append(button(labels['auto-context'], () => togglePopover(sourcePicker, document.getElementById('research-source-toggle')), { className: 'research-auto-context', title: labels['welcome-detail'] }));
	}

	function renderHistory() {
		let query = historySearch.value.toLocaleLowerCase().trim();
		let saved = service.state.sessions.filter(saved => saved.provider === session.provider && (!query || saved.title.toLocaleLowerCase().includes(query)
			|| saved.messages.some(message => message.text.toLocaleLowerCase().includes(query))));
		historyList.replaceChildren(...saved.map(saved => button(html('span', {}, saved.title),
			() => activate(saved), { className: saved.id === session.id ? 'active' : '' })));
		if (!saved.length) historyList.append(html('p', { className: 'research-muted' }, labels['no-history']));
	}

	function render(preserveScroll = false) {
		let scroll = messages.scrollTop;
		let atBottom = messages.scrollHeight - scroll - messages.clientHeight < 90;
		renderSources(); renderHistory();
		projectInstructions.value = session.instructions || '';
		modelInput.value = service.state.settings.models[session.provider] || '';
		executableInput.value = service.state.settings.executables[session.provider] || '';
		for (let input of [projectInstructions, modelInput, executableInput]) input.disabled = busy();
		composer.value = session.draft || '';
		messages.replaceChildren();
		if (!session.messages.length) messages.append(html('div', { className: 'research-empty' },
			html('span', { className: 'research-provider-mark', 'aria-hidden': 'true' }, session.provider === 'claude' ? '✳' : '⌘'),
			html('h2', {}, labels[`${session.provider}-welcome`]), html('p', {}, labels['welcome-detail'])));
		for (let message of session.messages) renderMessage(message);
		messages.scrollTop = preserveScroll && !atBottom ? scroll : messages.scrollHeight;
		updateControls(); resizeComposer();
	}

	function inline(node, text, evidence) {
		for (let part of text.split(/(\[S\d+\]|\*\*[^*]+\*\*)/g)) {
			let source = evidence?.find(s => `[${s.id}]` === part);
			let pageLabel = source && /[\p{L}\p{N}]/u.test(source.pageLabel || '') ? source.pageLabel : (source?.pageIndex ?? 0) + 1;
			if (source) node.append(button(`${source.id} · ${pageLabel === 'abstract only' ? 'abstract' : 'p. ' + pageLabel}`, () => source.itemID
				? service.openSource(source) : ZoteroPane.selectItem(source.parentID),
				{ className: 'research-citation', title: `${source.title}\n\n${source.text}` }));
			else if (part.startsWith('**') && part.endsWith('**')) node.append(html('strong', {}, part.slice(2, -2)));
			else node.append(document.createTextNode(part));
		}
	}

	function renderAnswer(target, message) {
		target.replaceChildren();
		if (message.pending && !message.text) {
			target.append(html('p', { className: 'research-working' }, labels.working)); return;
		}
		// Markdown emits only its own markup; raw HTML and remote images are disabled.
		let parsed = new DOMParser().parseFromString(markdown.render(message.text), 'text/html');
		for (let node of [...parsed.body.childNodes]) target.append(document.importNode(node, true));
		for (let link of target.querySelectorAll('a')) {
			let href = link.getAttribute('href');
			link.removeAttribute('href');
			if (/^https?:\/\//i.test(href || '')) {
				link.setAttribute('role', 'link'); link.setAttribute('tabindex', '0');
				link.addEventListener('click', () => Zotero.launchURL(href));
				link.addEventListener('keydown', event => { if (event.key === 'Enter') Zotero.launchURL(href); });
			}
		}
		let walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT), texts = [], node;
		while ((node = walker.nextNode())) {
			if (!node.parentElement.closest('pre, code, a') && /\[S\d+\]/.test(node.textContent)) texts.push(node);
		}
		for (let text of texts) {
			let span = html('span'); inline(span, text.textContent, message.evidence); text.replaceWith(span);
		}
		for (let table of target.querySelectorAll('table')) {
			let wrapper = html('div', { className: 'research-table' }); table.replaceWith(wrapper); wrapper.append(table);
		}
	}

	function renderMessage(message) {
		let body = html('div', { className: 'research-answer' });
		renderAnswer(body, message);
		let article = html('article', { className: `research-message ${message.role}`, 'data-message-id': message.id || '' },
			html('small', { className: 'research-sr-only' }, message.role === 'user' ? 'You' : (message.provider || 'Assistant')), body);
		if (message.role === 'assistant' && !message.pending) {
			article.append(html('div', { className: 'research-message-actions' },
				iconButton('note', labels['save-note'], async () => { let note = await service.saveNote(message, session); setStatus('Saved to your Zotero library.'); await ZoteroPane.selectItem(note.id); }),
				iconButton('copy', labels.copy, () => { Zotero.Utilities.Internal.copyTextToClipboard(message.text); setStatus('Copied.'); })));
			if (message.error) article.append(html('p', { className: 'error' }, message.error));
			if (message.warnings?.length) article.append(html('details', {}, html('summary', {}, 'Source warnings'),
				...message.warnings.map(warning => html('p', { className: 'research-disclosure' }, warning))));
			if (message.evidence?.length) {
				let details = html('details', { className: 'research-evidence' }, html('summary', {}, `${labels.evidence} · ${new Set(message.evidence.map(s => s.parentID)).size}`));
				for (let source of message.evidence) details.append(html('p', { className: 'research-disclosure' }, `${source.id} · ${source.title} · ${source.pageLabel}`));
				if (message.usage) details.append(html('small', {}, `${message.usage.input_tokens || 0} input · ${message.usage.output_tokens || 0} output tokens`));
				article.querySelector('.research-message-actions').append(details);
			}
		}
		messages.append(article);
		return body;
	}

	async function send() {
		if (busy() || !composer.value.trim()) return;
		closePopover(false); mentions.hidden = true;
		let current = session, provider = current.provider, prefs = service.state.settings;
		let model = prefs.models[provider], executable = prefs.executables[provider];
		let question = composer.value.trim();
		let previous = current.messages.filter(m => !m.error && !m.pending);
		let selectedReader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
		let selectedItems = selectedReader ? [Zotero.Items.get(selectedReader.itemID)] : ZoteroPane.getSelectedItems();
		let controller = new AbortController();
		controllers.set(current.id, controller);
		let answer = { id: Zotero.Utilities.randomString(16), role: 'assistant', text: '', provider, pending: true, evidence: [] };
		if (!current.messages.length) current.title = question.slice(0, 60);
		current.messages.push({ role: 'user', text: question }, answer);
		current.draft = ''; composer.value = '';
		let report = (text, error = false) => {
			statuses.set(current.id, { text, error });
			if (session === current) setStatus(text, error);
		};
		report(labels.connecting); render();
		let paintTimer;
		try {
			await service.save();
			if (!current.sources.length && !current.scope) {
				if (!selectedItems.length) throw new Error('Select a paper in your library or open a PDF first.');
				if (selectedItems.length > 24) throw new Error('Select up to 24 papers for this conversation.');
				current.sources = await service.resolve(selectedItems);
				if (session === current) renderSources();
			}
			let documents = current.sources.slice();
			if (current.scope) {
				report('Searching your library…');
				let matches = await service.searchScope(current.scope, question, controller.signal);
				documents.push(...matches.filter(d => !documents.some(p => p.parentID === d.parentID)).slice(0, 24 - documents.length));
			}
			let { sources: evidence, warnings } = await service.evidence(documents, question, controller.signal, report);
			answer.evidence = evidence; answer.warnings = warnings;
			let contextKey = JSON.stringify([current.instructions || '', [...new Set(evidence.map(e => `${e.parentID}:${e.itemID}:${e.fileHash || ''}`))].sort()]);
			let result = await service.providers.ask({ provider, model, executable, conversationID: current.id, contextKey,
				signal: controller.signal,
				prompt: continued => require('zotero/research/core').prompt({ question, sources: evidence, history: continued ? [] : previous, instructions: current.instructions || '' }),
				onModels: models => { catalogs.set(provider, models); if (session === current) renderModels(); },
				onStatus: phase => report(phase === 'responding' ? labels.responding : labels.working),
				onText: text => {
					answer.text = text;
					if (paintTimer) return;
					paintTimer = setTimeout(() => {
						paintTimer = null;
						if (session !== current) return;
						let body = messages.querySelector(`[data-message-id="${answer.id}"] .research-answer`);
						if (!body) return;
						let atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
						renderAnswer(body, answer);
						if (atBottom) messages.scrollTop = messages.scrollHeight;
					}, 50);
				} });
			answer.text = result.text; answer.usage = result.usage;
			report('');
		}
		catch (error) { answer.error = error.message; report(error.message, true); }
		finally {
			clearTimeout(paintTimer); answer.pending = false; controllers.delete(current.id);
			if (session === current) render(true);
			else updateControls();
			await service.save();
		}
	}
};
