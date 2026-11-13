/* SPDX-License-Identifier: AGPL-3.0-or-later */
const Core = require('./core');
const Providers = require('./providers');

class ResearchService {
	constructor(Zotero) {
		this.Zotero = Zotero;
		this.providers = new Providers(Zotero);
		this.path = PathUtils.join(Zotero.Profile.dir, 'research-workspace.json');
		this.state = Core.migrateState({ version: 2, settings: { provider: 'codex' }, sessions: [] });
		this._writes = Promise.resolve();
	}

	async load() {
		if (await IOUtils.exists(this.path)) {
			let state = await IOUtils.readJSON(this.path);
			this.state = Core.migrateState(state);
			if (state.version === 1 && !await IOUtils.exists(this.path + '.v1.bak')) await IOUtils.copy(this.path, this.path + '.v1.bak');
		}
		return this.state;
	}

	save() {
		let snapshot = JSON.stringify(this.state);
		this._writes = this._writes.catch(() => {}).then(async () => {
			await IOUtils.writeUTF8(this.path, snapshot, { tmpPath: this.path + '.tmp' });
			await IOUtils.setPermissions(this.path, 0o600);
		});
		return this._writes;
	}

	newSession(provider = this.state.settings.provider) {
		let session = { id: Zotero.Utilities.randomString(16), provider, draft: '', title: 'New conversation', created: Date.now(), sources: [], messages: [] };
		this.state.sessions.unshift(session);
		this.state.activeSessions[provider] = session.id;
		return session;
	}

	activeSession(provider) {
		return this.state.sessions.find(s => s.provider === provider && s.id === this.state.activeSessions[provider])
			|| this.state.sessions.find(s => s.provider === provider) || this.newSession(provider);
	}

	async resolve(items) {
		let docs = [], seen = new Set();
		for (let item of items) {
			if (item.isAnnotation()) item = this.Zotero.Items.get(item.parentID);
			let attachment = item.isAttachment() ? item : item.isRegularItem() ? await item.getBestAttachment() : null;
			let parent = attachment?.parentItem || item;
			let id = attachment?.id || parent.id;
			if (seen.has(id)) continue;
			seen.add(id);
			docs.push({ itemID: attachment?.id || null, parentID: parent.id, libraryID: parent.libraryID,
				key: attachment?.key || parent.key, title: parent.getField('title') || attachment?.getField('title') || 'Untitled',
				abstract: parent.getField('abstractNote'), available: !!attachment?.isPDFAttachment() });
		}
		return docs;
	}

	async evidence(documents, question, signal, status) {
		let extracted = [], warnings = [];
		let module = require('resource://zotero/research-sdt/fulltext.js');
		for (let [index, doc] of documents.entries()) {
			if (signal.aborted) throw new Error('Stopped.');
			status(`Reading ${index + 1} of ${documents.length} · ${doc.title}`);
			try {
				if (!doc.available) throw new Error('no attached PDF');
				let reader = await this.Zotero.SDT.getReader(doc.itemID, { isPriority: true });
				if (!reader) throw new Error('PDF unavailable, encrypted, or extraction failed');
				let structure = await reader.materialize();
				let pages = structure.catalog.pages.map((page, index) => ({ index, label: /[\p{L}\p{N}]/u.test(page.label || '') ? page.label : String(index + 1),
					text: module.getFulltextFromStructuredText(structure, [index]) }));
				if (!pages.some(p => p.text.trim())) throw new Error('no searchable text; OCR is needed');
				extracted.push({ ...doc, pages, fileHash: await this.Zotero.Items.get(doc.itemID).attachmentHash });
			}
			catch (e) {
				warnings.push(`${doc.title}: ${e.message}`);
				// Abstract-only records are explicitly labeled and never get PDF page links.
				if (doc.abstract) extracted.push({ ...doc, itemID: null, pages: [{ text: doc.abstract, index: null, label: 'abstract only' }] });
			}
			await this.Zotero.Promise.delay(0);
		}
		let sources = Core.retrieve(extracted, question);
		if (!sources.length) throw new Error('No readable evidence. ' + warnings.join(' · '));
		return { sources, warnings };
	}

	async saveNote(message, session) {
		let parent = this.Zotero.Items.get(message.evidence?.[0]?.parentID || session.sources[0]?.parentID);
		if (!parent) throw new Error('The source item no longer exists.');
		if (!this.Zotero.Libraries.get(parent.libraryID).editable) throw new Error('This library is read-only.');
		let note = new this.Zotero.Item('note');
		note.libraryID = parent.libraryID;
		if (new Set((message.evidence || session.sources).map(s => s.parentID)).size === 1 && parent.isRegularItem()) note.parentID = parent.id;
		let text = Core.escapeHTML(message.text).replace(/\[S(\d+)\]/g, (token, n) => {
			let source = message.evidence?.find(s => s.id === `S${n}`);
			if (!source?.itemID) return token;
			let uri = source.libraryID === this.Zotero.Libraries.userLibraryID ? 'library' : `groups/${this.Zotero.Groups.getGroupIDFromLibraryID(source.libraryID)}`;
			return `<a href="zotero://open-pdf/${uri}/items/${source.key}?page=${source.pageIndex + 1}">${token}</a>`;
		});
		note.setNote(`<h1>${Core.escapeHTML(session.title)}</h1><p>Research assistant · ${Core.escapeHTML(message.provider || '')}</p><p>${text.replace(/\n/g, '<br>')}</p>`);
		await note.saveTx();
		return note;
	}

	async searchScope(scope, question, signal) {
		let scores = new Map();
		for (let term of Core.terms(question).slice(0, 8)) {
			if (signal.aborted) throw new Error('Stopped.');
			let search = new this.Zotero.Search();
			search.libraryID = scope.libraryID;
			if (scope.collectionID) search.addCondition('collectionID', 'is', scope.collectionID);
			search.addCondition('quicksearch-everything', 'contains', term);
			for (let id of await search.search()) {
				let item = await this.Zotero.Items.getAsync(id);
				if (item.isNote() || item.isAnnotation()) continue;
				id = item.parentID || item.id;
				scores.set(id, (scores.get(id) || 0) + 1);
			}
		}
		let ids = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id]) => id);
		if (!ids.length) throw new Error('No matching papers in this scope. Try a topic, author, or title, or select papers explicitly.');
		return this.resolve(await this.Zotero.Items.getAsync(ids));
	}

	async openSource(source) {
		let attachment = this.Zotero.Items.get(source.itemID);
		if (!attachment || attachment.deleted) throw new Error('This source was removed from the library.');
		if (source.fileHash && source.fileHash !== await attachment.attachmentHash) {
			throw new Error('This PDF has changed since the answer was generated. Ask again to refresh its evidence and page links.');
		}
		return this.Zotero.Reader.open(source.itemID, { pageIndex: source.pageIndex });
	}

	async discover(query) {
		if (!query.trim()) return [];
		let response = await this.Zotero.HTTP.request('GET', 'https://api.crossref.org/works?rows=8&query.bibliographic='
			+ encodeURIComponent(query.trim()), { responseType: 'json', timeout: 20000 });
		return (response.response?.message?.items || []).filter(item => item.DOI && item.title?.[0]);
	}
}
module.exports = ResearchService;
