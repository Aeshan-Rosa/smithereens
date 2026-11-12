/* SPDX-License-Identifier: AGPL-3.0-or-later */
var ResearchPane = new function () {
	let service, session, controller, labels, root, messages, sources, composer, status, settings, history, mentions, projectInstructions;
	let ready = false;
	let html = (tag, props = {}, ...children) => {
		let node = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
		for (let [key, value] of Object.entries(props)) {
			if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
			else if (key === 'className') node.className = value;
			else node.setAttribute(key, value);
		}
		node.append(...children.filter(x => x !== undefined));
		return node;
	};
	let button = (label, action, props = {}) => html('button', { type: 'button', onclick: () => safely(action), ...props }, label);
	let safely = async action => {
		try { await action(); }
		catch (error) { setStatus(error.message, true); Zotero.logError(error); }
	};
	let setStatus = (text, error = false) => {
		status.textContent = text;
		status.classList.toggle('error', error);
	};

	this.init = async function () {
		if (ready) return;
		ready = true;
		root = document.getElementById('research-pane');
		let keys = ['title', 'new', 'history', 'settings', 'close', 'sources', 'selected', 'current', 'collection', 'library', 'send', 'stop', 'placeholder', 'empty', 'summary', 'compare', 'matrix', 'claims', 'screen', 'draft', 'deep', 'save-note', 'copy', 'check', 'provider', 'model', 'instructions', 'path', 'disclosure', 'ready', 'remove', 'clear', 'discover'];
		let values = await document.l10n.formatValues(keys.map(key => ({ id: `research-${key}` })));
		labels = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
		let Service = require('zotero/research/service');
		service = new Service(Zotero);
		status = html('div', { className: 'research-status', role: 'status', 'aria-live': 'polite' });
		try { await service.load(); }
		catch (e) { root.append(status); setStatus(e.message, true); return; }
		session = service.state.sessions[0] || service.newSession();
		let header = html('header', {}, html('div', { className: 'research-brand' },
			html('img', { src: 'chrome://zotero/skin/smithereens-icon.png', alt: '', width: '30', height: '30' }),
			html('strong', {}, 'Smithereens')), html('div', { className: 'research-actions' },
			button('+', () => { if (controller) return; session = service.newSession(); render(); return service.save(); }, { title: labels.new, 'aria-label': labels.new }),
			button('◷', () => { history.hidden = !history.hidden; renderHistory(); }, { title: labels.history, 'aria-label': labels.history }),
			button('⚙', () => { settings.hidden = !settings.hidden; }, { title: labels.settings, 'aria-label': labels.settings }),
			button('×', () => this.toggle(), { title: labels.close, 'aria-label': labels.close })));
		history = html('div', { className: 'research-history', hidden: 'hidden' });
		settings = buildSettings();
		sources = html('div', { className: 'research-source-list' });
		let sourcePicker = html('details', { open: 'open', className: 'research-sources' },
			html('summary', {}, labels.sources),
			html('div', { className: 'research-source-actions' },
				...['selected', 'current', 'collection', 'library'].map(scope => button(labels[scope], () => addSources(scope)))), sources);
		messages = html('div', { className: 'research-messages', 'aria-label': labels.title });
		mentions = html('div', { className: 'research-mentions', hidden: 'hidden', 'aria-label': 'Matching papers' });
		composer = html('textarea', { rows: '3', placeholder: labels.placeholder, 'aria-label': labels.placeholder,
			onkeydown: event => {
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); safely(send); }
			} });
		let mentionTimer, mentionRequest = 0;
		composer.addEventListener('input', () => {
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
					if (controller) return;
					await mergeSources(await service.resolve([item]));
					composer.value = composer.value.replace(/@[^@\n]+$/, `“${item.getField('title')}” `);
					mentions.hidden = true; composer.focus();
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
		let quick = html('div', { className: 'research-quick' }, ...Object.entries(templates).map(([key, text]) => button(labels[key], () => { composer.value = text; composer.focus(); })));
		let sendButton = button(labels.send, send, { className: 'research-primary', id: 'research-send' });
		let stopButton = button(labels.stop, () => controller?.abort(), { id: 'research-stop', hidden: 'hidden' });
		root.append(header, history, settings, buildDiscovery(), sourcePicker, messages, quick,
			html('footer', {}, mentions, composer, html('div', { className: 'research-compose-actions' },
				html('small', { id: 'research-provider-label' }, service.state.settings.provider), stopButton, sendButton), status));
		render();
		setStatus(session.sources.length ? `${session.sources.length} papers ready.` : labels.ready);
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
				if (controller) return;
				this.show();
				let docs = await service.resolve([Zotero.Items.get(reader.itemID)]);
				mergeSources(docs);
				composer.value = `Explain this passage in context:\n\n${params.annotation.text}`;
				composer.focus();
			}));
			append(control);
		};
		Zotero.Reader.registerEventListener('renderTextSelectionPopup', onSelection);
		window.addEventListener('unload', () => {
			controller?.abort();
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

	function buildSettings() {
		let prefs = service.state.settings;
		let provider = html('select', { 'aria-label': labels.provider },
			html('option', { value: 'codex' }, 'Codex · ChatGPT'), html('option', { value: 'claude' }, 'Claude Code'));
		provider.value = prefs.provider;
		let model = html('input', { placeholder: 'Provider default', 'aria-label': labels.model });
		model.value = prefs.model;
		let executable = html('input', { placeholder: 'Auto-detect', 'aria-label': labels.path });
		executable.value = prefs.executables[prefs.provider] || '';
		let instructions = html('textarea', { rows: '3', 'aria-label': labels.instructions });
		projectInstructions = instructions;
		instructions.value = session.instructions || '';
		let persist = () => safely(async () => {
			prefs.model = model.value.trim(); session.instructions = instructions.value;
			prefs.executables[prefs.provider] = executable.value.trim();
			await service.save();
		});
		provider.addEventListener('change', () => {
			if (controller) { provider.value = prefs.provider; return; }
			prefs.provider = provider.value; prefs.model = ''; model.value = '';
			executable.value = prefs.executables[prefs.provider] || '';
			document.getElementById('research-provider-label').textContent = prefs.provider;
			persist();
		});
		for (let node of [model, instructions, executable]) node.addEventListener('change', persist);
		return html('section', { className: 'research-settings', hidden: 'hidden' },
			html('label', {}, labels.provider, provider), html('label', {}, labels.model, model),
			html('label', {}, labels.path, executable), html('label', {}, labels.instructions, instructions),
			button(labels.check, async () => {
				setStatus('Checking sign-in…');
				let result = await service.providers.status(prefs.provider, executable.value.trim());
				setStatus(result.connected ? `Connected · ${result.message}` : result.message || `Sign in with ${prefs.provider} in Terminal.`, !result.connected);
			}), html('p', { className: 'research-disclosure' }, labels.disclosure));
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

	function mergeSources(docs) {
		if (session.sources.length + docs.filter(d => !session.sources.some(s => s.parentID === d.parentID)).length > 24) throw new Error('A conversation supports up to 24 pinned papers. Remove some sources first.');
		for (let doc of docs) {
			if (!session.sources.some(x => x.parentID === doc.parentID)) session.sources.push(doc);
		}
		renderSources();
		return service.save();
	}

	async function addSources(scope) {
		if (controller) return;
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
		if (session.sources.length + docs.filter(d => !session.sources.some(s => s.parentID === d.parentID)).length > 24) throw new Error('A conversation supports up to 24 papers. Remove some sources first.');
		await mergeSources(docs);
		setStatus(`${session.sources.length} papers in this conversation`);
	}

	function renderSources() {
		sources.replaceChildren(...session.sources.map(source => html('div', { className: 'research-source' },
			button(source.title, () => source.itemID ? Zotero.Reader.open(source.itemID) : ZoteroPane.selectItem(source.parentID), { title: source.title }),
			button('×', async () => { if (controller) return; session.sources = session.sources.filter(x => x !== source); renderSources(); await service.save(); }, { 'aria-label': `${labels.remove} ${source.title}` }))));
		if (session.scope) sources.prepend(html('div', { className: 'research-scope' },
			html('small', {}, `Search: ${session.scope.name} · up to 24 matching papers per answer`),
			button('×', async () => { if (controller) return; delete session.scope; renderSources(); await service.save(); }, { 'aria-label': 'Remove search scope' })));
		if (!session.sources.length && !session.scope) sources.append(html('p', {}, 'Select papers in your library, then choose “Selected”.'));
	}

	function renderHistory() {
		history.replaceChildren(...service.state.sessions.map(saved => button(saved.title, () => {
			if (controller) return; session = saved; history.hidden = true; render();
		}, { className: saved.id === session.id ? 'active' : '' })));
	}

	function render() {
		renderSources(); renderHistory();
		if (projectInstructions) projectInstructions.value = session.instructions || '';
		messages.replaceChildren();
		if (!session.messages.length) messages.append(html('div', { className: 'research-empty' }, html('h2', {}, 'Read. Ask. Understand.'), html('p', {}, labels.empty)));
		for (let message of session.messages) renderMessage(message);
		messages.scrollTop = messages.scrollHeight;
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
		let lines = message.text.split('\n'), table;
		for (let line of lines) {
			if (/^\s*\|.*\|\s*$/.test(line)) {
				if (/^\s*\|[\s:|\-]+\|\s*$/.test(line)) continue;
				if (!table) { table = html('table'); target.append(html('div', { className: 'research-table' }, table)); }
				let row = html('tr');
				for (let cell of line.trim().slice(1, -1).split('|')) { let td = html('td'); inline(td, cell.trim(), message.evidence); row.append(td); }
				table.append(row);
			}
			else {
				table = null;
				let element = html(/^#{1,4}\s/.test(line) ? 'h3' : 'p');
				inline(element, line.replace(/^#{1,4}\s/, ''), message.evidence);
				target.append(element);
			}
		}
	}

	function renderMessage(message) {
		let body = html('div', { className: 'research-answer' });
		renderAnswer(body, message);
		let article = html('article', { className: `research-message ${message.role}` },
			html('small', {}, message.role === 'user' ? 'You' : (message.provider || 'Assistant')), body);
		if (message.role === 'assistant' && !message.pending) {
			article.append(html('div', { className: 'research-message-actions' },
				button(labels['save-note'], async () => { let note = await service.saveNote(message, session); setStatus('Saved to your Zotero library.'); await ZoteroPane.selectItem(note.id); }),
				button(labels.copy, () => { Zotero.Utilities.Internal.copyTextToClipboard(message.text); setStatus('Copied.'); })));
			if (message.error) article.append(html('p', { className: 'error' }, message.error));
			if (message.warnings?.length) article.append(html('details', {}, html('summary', {}, 'Source warnings'),
				...message.warnings.map(warning => html('p', { className: 'research-disclosure' }, warning))));
			if (message.evidence?.length) {
				let details = html('details', {}, html('summary', {}, `${new Set(message.evidence.map(s => s.parentID)).size} papers · ${message.evidence.length} excerpts used`));
				for (let source of message.evidence) details.append(html('p', { className: 'research-disclosure' }, `${source.id} · ${source.title} · ${source.pageLabel}`));
				article.append(details);
			}
			if (message.usage) article.append(html('small', {}, `${message.usage.input_tokens || 0} input · ${message.usage.output_tokens || 0} output tokens`));
		}
		messages.append(article);
		return body;
	}

	async function send() {
		if (controller || !composer.value.trim()) return;
		if (!session.sources.length && !session.scope) await addSources(Zotero.Reader.getByTabID(Zotero_Tabs.selectedID) ? 'current' : 'selected');
		if (!session.sources.length && !session.scope) throw new Error('Add papers to the conversation first.');
		let question = composer.value.trim();
		let prefs = { ...service.state.settings };
		let previous = session.messages.filter(m => !m.error && !m.pending);
		controller = new AbortController();
		document.getElementById('research-send').disabled = true;
		document.getElementById('research-stop').hidden = false;
		let answer = { role: 'assistant', text: '', provider: prefs.provider, pending: true, evidence: [] };
		if (!session.messages.length) session.title = question.slice(0, 60);
		session.messages.push({ role: 'user', text: question }, answer);
		composer.value = '';
		render();
		let body = messages.lastElementChild.querySelector('.research-answer');
		try {
			let documents = session.sources.slice();
			if (session.scope) {
				setStatus('Searching your library…');
				let matches = await service.searchScope(session.scope, question, controller.signal);
				documents.push(...matches.filter(d => !documents.some(p => p.parentID === d.parentID)).slice(0, 24 - documents.length));
			}
			let { sources: evidence, warnings } = await service.evidence(documents, question, controller.signal, setStatus);
			answer.evidence = evidence;
			answer.warnings = warnings;
			setStatus(`${prefs.provider === 'codex' ? 'Codex is working' : 'Claude is responding'} · ${evidence.length} excerpts${warnings.length ? ` · ${warnings.length} source warnings` : ''}`);
			let lastPaint = 0;
			let result = await service.providers.ask({ provider: prefs.provider, model: prefs.model,
				executable: prefs.executables[prefs.provider], signal: controller.signal,
				prompt: require('zotero/research/core').prompt({ question, sources: evidence, history: previous, instructions: session.instructions || '' }),
				onText: text => {
					answer.text = text;
					if (Date.now() - lastPaint < 70) return;
					let atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
					renderAnswer(body, answer); lastPaint = Date.now();
					if (atBottom) messages.scrollTop = messages.scrollHeight;
				} });
			answer.text = result.text; answer.usage = result.usage;
			setStatus(warnings.length ? warnings.join(' · ') : 'Answer complete · check citations against the original papers.');
		}
		catch (e) { answer.error = e.message; setStatus(e.message, true); }
		finally {
			answer.pending = false; controller = null;
			document.getElementById('research-send').disabled = false;
			document.getElementById('research-stop').hidden = true;
			render(); await service.save(); composer.focus();
		}
	}
};
