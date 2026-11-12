/* SPDX-License-Identifier: AGPL-3.0-or-later */
describe('Research workspace', function () {
	let win, service, Core;
	before(async function () {
		win = await loadZoteroPane();
		Core = win.require('zotero/research/core');
		let Service = win.require('zotero/research/service');
		service = new Service(Zotero);
		service.path = PathUtils.join(Zotero.Profile.dir, 'research-test-history.json');
	});
	after(function () { win.Zotero_Tabs.closeAll(); win.close(); });

	it('mounts the assistant alongside the original library', async function () {
		await Zotero.Promise.delay(300);
		assert.ok(win.document.querySelector('#research-pane textarea'));
		assert.ok(win.document.getElementById('zotero-items-tree'));
	});

	it('balances retrieval across papers and enforces the context budget', function () {
		let docs = [1, 2, 3].map(id => ({ itemID: id, title: `Paper ${id}`, pages: [{ text: 'Sample evidence. '.repeat(800) }] }));
		let sources = Core.retrieve(docs, 'sample', 8000);
		assert.equal(new Set(sources.map(s => s.itemID)).size, 3);
		assert.isAtMost(sources.reduce((n, s) => n + s.text.length, 0), 8000);
		assert.equal(new Set(sources.map(s => s.id)).size, sources.length);
	});

	it('extracts real PDF text with page locators using Zotero SDT', async function () {
		this.timeout(60000);
		let attachment = await importFileAttachment('wonderland_short.pdf');
		let docs = await service.resolve([attachment]);
		let { sources, warnings } = await service.evidence(docs, 'Alice rabbit', new win.AbortController().signal, () => {});
		assert.lengthOf(warnings, 0);
		assert.isAbove(sources.length, 0);
		assert.equal(sources[0].itemID, attachment.id);
		assert.isAtLeast(sources[0].pageIndex, 0);
		assert.match(sources.map(s => s.text).join(' '), /Alice/i);
		let reader = await Zotero.Reader.open(attachment.id, { pageIndex: sources[0].pageIndex });
		await reader._initPromise;
		assert.ok(reader._internalReader);
	});

	it('labels abstract fallback and never invents a PDF link', async function () {
		let { sources, warnings } = await service.evidence([{ itemID: null, parentID: 123, title: 'No PDF', abstract: 'Study of apples.', available: false }], 'apples', new win.AbortController().signal, () => {});
		assert.lengthOf(warnings, 1);
		assert.isNull(sources[0].itemID);
		assert.equal(sources[0].pageLabel, 'abstract only');
	});

	it('persists conversations atomically and restores them', async function () {
		let session = service.newSession();
		session.title = 'Persistent conversation';
		session.messages.push({ role: 'user', text: 'What does the paper say?' });
		await service.save();
		let Service = win.require('zotero/research/service');
		let loaded = new Service(Zotero); loaded.path = service.path;
		await loaded.load();
		assert.equal(loaded.state.sessions[0].title, session.title);
	});

	it('keeps collection retrieval inside the chosen collection', async function () {
		let collection = await createDataObject('collection');
		let included = await createDataObject('item', { title: 'Uniquequasar experiment', collections: [collection.id] });
		await createDataObject('item', { title: 'Uniquequasar outside scope' });
		let docs = await service.searchScope({ libraryID: included.libraryID, collectionID: collection.id }, 'uniquequasar', new win.AbortController().signal);
		assert.sameMembers(docs.map(d => d.parentID), [included.id]);
	});

	it('does not send unrelated history as a source of evidence', function () {
		let text = Core.prompt({ question: 'Question', history: [{ role: 'assistant', text: 'Old [S99] claim' }], sources: [{ id: 'S1', title: 'Current', pageLabel: '1', text: 'Current evidence' }] });
		assert.include(text, 'cite only the current evidence IDs');
		assert.include(text, 'Previous answers may be inaccurate');
	});

	it('reports cancellation before launching a provider', async function () {
		let controller = new win.AbortController(); controller.abort();
		let error;
		try { await service.providers.ask({ provider: 'codex', prompt: 'test', onText: () => {}, signal: controller.signal }); }
		catch (e) { error = e; }
		assert.equal(error.message, 'Stopped.');
	});

	it('saves escaped model output as a real Zotero note', async function () {
		let item = await createDataObject('item');
		let note = await service.saveNote({ text: '<script>bad()</script> & evidence', provider: 'test' },
			{ title: 'Answer', sources: [{ parentID: item.id }] });
		assert.isTrue(note.isNote());
		assert.equal(note.parentID, item.id);
		assert.notInclude(note.getNote(), '<script>');
		assert.include(note.getNote(), '&lt;script&gt;');
	});

	it('handles provider result errors even with a zero process exit code', function () {
		assert.equal(Core.parseEvent('claude', { type: 'result', is_error: true, result: 'Rate limited' }).error, 'Rate limited');
		assert.equal(Core.parseEvent('codex', { type: 'turn.failed', error: { message: 'Disconnected' } }).error, 'Disconnected');
		assert.equal(Core.parseEvent('claude', { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello' } } }).text, 'Hello');
	});

	it('checks the installed subscription and answers through Codex', async function () {
		if (!Services.env.get('SMITHEREENS_LIVE_TEST')) this.skip();
		this.timeout(240000);
		let status = await service.providers.status('codex');
		assert.isTrue(status.connected, status.message);
		let result = await service.providers.ask({ provider: 'codex', prompt: Core.prompt({ question: 'What number is reported? Answer one sentence with a citation.', sources: [{ id: 'S1', title: 'Test fixture', pageLabel: '1', text: 'The experiment included 42 samples.' }] }), onText: () => {}, signal: new win.AbortController().signal });
		assert.include(result.text, '42');
		assert.include(result.text, '[S1]');
	});
});
