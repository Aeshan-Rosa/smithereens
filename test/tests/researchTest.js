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
	after(function () { service.providers.dispose(); win.Zotero_Tabs.closeAll(); win.close(); });

	it('mounts the assistant alongside the original library', async function () {
		await Zotero.Promise.delay(300);
		assert.ok(win.document.querySelector('#research-pane textarea'));
		assert.ok(win.document.getElementById('zotero-items-tree'));
	});

	it('keeps drafts and model choices separate between provider tabs', async function () {
		let doc = win.document, input = doc.querySelector('#research-pane footer textarea');
		let select = provider => doc.getElementById(`research-tab-${provider}`).click();
		let draft = text => { input.value = text; input.dispatchEvent(new win.Event('input')); };
		select('codex'); draft('Codex draft');
		select('claude'); draft('Claude draft');
		select('codex');
		assert.equal(input.value, 'Codex draft');
		assert.equal(doc.getElementById('research-tab-codex').getAttribute('aria-selected'), 'true');
		select('claude');
		assert.equal(input.value, 'Claude draft');
		draft('');
		select('codex'); draft('');
		await Zotero.Promise.delay(300);
		let saved = await IOUtils.readJSON(PathUtils.join(Zotero.Profile.dir, 'research-workspace.json'));
		assert.ok(saved.activeSessions.claude);
		assert.notEqual(saved.activeSessions.claude, saved.activeSessions.codex);
	});

	it('isolates a background response and renders safe Markdown with source links', async function () {
		this.timeout(10000);
		let doc = win.document, pane = doc.getElementById('research-pane');
		let Service = win.require('zotero/research/service'), Providers = win.require('zotero/research/providers');
		let item = await createDataObject('item', { title: 'Sidebar context test' });
		await win.ZoteroPane.selectItem(item.id);
		let resolveAnswer, received;
		let answer = new Promise(resolve => { resolveAnswer = resolve; });
		let text = '## Findings\n\n- **Evidence** [S1]\n\n| Paper | Count |\n| --- | --- |\n| Test | 42 |\n\n`code`\n\n<script>bad()</script>\n\n![remote](https://example.com/tracker.png)';
		let evidence = [{ id: 'S1', parentID: item.id, itemID: null, title: 'Test', pageLabel: 'abstract only', text: '42 samples.' }];
		let sandbox = sinon.createSandbox();
		sandbox.stub(Service.prototype, 'evidence').resolves({ sources: evidence, warnings: [] });
		sandbox.stub(Providers.prototype, 'connect').resolves({ models: [{ value: 'test-model', label: 'Test model' }] });
		sandbox.stub(Providers.prototype, 'ask').callsFake(options => { received = options; return answer; });
		try {
			doc.getElementById('research-tab-codex').click();
			pane.querySelector('button[title="New conversation"]').click();
			let input = pane.querySelector('footer textarea');
			input.value = 'Only in Codex'; input.dispatchEvent(new win.Event('input'));
			doc.getElementById('research-send').click();
			for (let i = 0; i < 50 && !received; i++) await Zotero.Promise.delay(50);
			assert.ok(received, 'Provider receives the question');
			assert.isTrue(doc.getElementById('research-send').disabled);
			doc.getElementById('research-tab-claude').click();
			input.value = 'Keep this Claude draft'; input.dispatchEvent(new win.Event('input'));
			received.onModels([{ value: 'test-model', label: 'Test model' }]);
			received.onText(text);
			await Zotero.Promise.delay(80);
			assert.notInclude(doc.getElementById('research-conversation').textContent, 'Only in Codex');
			assert.isFalse(doc.getElementById('research-send').disabled);
			resolveAnswer({ text });
			await Zotero.Promise.delay(100);
			assert.equal(input.value, 'Keep this Claude draft');
			doc.getElementById('research-tab-codex').click();
			let body = pane.querySelector('.assistant .research-answer');
			assert.ok(body.querySelector('ul li strong'));
			assert.ok(body.querySelector('table th'));
			assert.ok(body.querySelector('code'));
			assert.ok(body.querySelector('.research-citation'));
			assert.isNull(body.querySelector('script, img'));
			assert.include(body.textContent, '<script>bad()</script>');
			assert.isFalse(doc.getElementById('research-send').disabled);
			doc.getElementById('research-model-toggle').click();
			await Zotero.Promise.delay(30);
			pane.querySelector('.research-model-menu button[data-value="test-model"]').click();
			assert.include(doc.getElementById('research-model-toggle').textContent, 'Test model');
			doc.getElementById('research-tab-claude').click();
			assert.equal(doc.getElementById('research-model-toggle').dataset.value, '');
			doc.getElementById('research-tab-codex').click();
			assert.equal(doc.getElementById('research-model-toggle').dataset.value, 'test-model');
		}
		finally { resolveAnswer({ text }); await Zotero.Promise.delay(100); sandbox.restore(); }
	});

	it('filters provider history and dismisses menus without losing the draft', async function () {
		let doc = win.document, pane = doc.getElementById('research-pane');
		let input = pane.querySelector('footer textarea');
		doc.getElementById('research-tab-codex').click();
		input.value = 'Preserve this draft'; input.dispatchEvent(new win.Event('input'));
		doc.getElementById('research-history-toggle').click();
		let search = pane.querySelector('.research-history input');
		search.value = 'Only in Codex'; search.dispatchEvent(new win.Event('input'));
		assert.equal(pane.querySelectorAll('.research-history-list button').length, 1);
		assert.include(pane.querySelector('.research-history-list').textContent, 'Only in Codex');
		search.value = 'no-such-conversation-123'; search.dispatchEvent(new win.Event('input'));
		assert.equal(pane.querySelectorAll('.research-history-list button').length, 0);
		search.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.isTrue(pane.querySelector('.research-history').hidden);
		assert.equal(input.value, 'Preserve this draft');
		assert.equal(doc.activeElement, input);
		input.value = '/'; input.dispatchEvent(new win.Event('input'));
		assert.isFalse(pane.querySelector('.research-quick').hidden);
		let compare = [...pane.querySelectorAll('.research-quick > button')].find(button => button.textContent === 'Compare');
		compare.click();
		assert.match(input.value, /^Compare these papers:/);
		assert.isTrue(pane.querySelector('.research-quick').hidden);
		input.value = 'Line of text\n'.repeat(30); input.dispatchEvent(new win.Event('input'));
		assert.isAtMost(parseFloat(input.style.height), 180);
		input.value = ''; input.dispatchEvent(new win.Event('input'));
	});

	it('selects models from the visible menu and isolates a late provider catalog', async function () {
		let doc = win.document, pane = doc.getElementById('research-pane');
		let Providers = win.require('zotero/research/providers');
		let resolveCatalog;
		let pending = new Promise(resolve => { resolveCatalog = resolve; });
		let sandbox = sinon.createSandbox();
		sandbox.stub(Providers.prototype, 'connect').returns(pending);
		try {
			doc.getElementById('research-tab-codex').click();
			doc.getElementById('research-model-toggle').click();
			assert.isFalse(pane.querySelector('.research-model-menu').hidden);
			doc.getElementById('research-tab-claude').click();
			resolveCatalog({ models: [{ value: 'menu-model', label: 'Menu test model' }] });
			await Zotero.Promise.delay(50);
			assert.notInclude(doc.getElementById('research-model-toggle').textContent, 'Menu test model');
			assert.isTrue(pane.querySelector('.research-model-menu').hidden);
			doc.getElementById('research-tab-codex').click();
			doc.getElementById('research-model-toggle').click();
			await Zotero.Promise.delay(30);
			let choice = [...pane.querySelectorAll('.research-model-menu > button')].find(button => button.textContent === 'Menu test model');
			assert.ok(choice); choice.click();
			assert.include(doc.getElementById('research-model-toggle').textContent, 'Menu test model');
			assert.equal(doc.getElementById('research-model-toggle').dataset.value, 'menu-model');
			assert.isTrue(pane.querySelector('.research-model-menu').hidden);
		}
		finally { resolveCatalog({ models: [] }); sandbox.restore(); }
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

	for (let provider of ['codex', 'claude']) {
		it(`compares two papers with citations through the ${provider} subscription`, async function () {
			let enabled = Services.env.get('SMITHEREENS_LIVE_TEST');
			if (enabled !== 'all' && enabled !== provider && !(enabled === '1' && provider === 'codex')) this.skip();
			this.timeout(240000);
			let status = await service.providers.status(provider);
			assert.isTrue(status.connected, status.message);
			let updates = [];
			let conversationID = `live-${provider}`;
			let result = await service.providers.ask({ provider, conversationID, prompt: Core.prompt({
				question: 'Compare the sample counts in Paper A and Paper B. State each count and cite its source separately. Use two short sentences.',
				sources: [
					{ id: 'S1', title: 'Paper A', pageLabel: '1', text: 'The experiment included 42 samples.' },
					{ id: 'S2', title: 'Paper B', pageLabel: '2', text: 'The experiment included 17 samples.' }
				]
			}), onText: text => updates.push(text), signal: new win.AbortController().signal });
			assert.include(result.text, '42');
			assert.include(result.text, '17');
			assert.include(result.text, '[S1]');
			assert.include(result.text, '[S2]');
			assert.isAbove(updates.length, 1, 'Answer must stream before completion');
			assert.equal(updates.at(-1).trim(), result.text);
			let client = await service.providers.connect({ provider, conversationID });
			assert.isAbove(client.models.length, 0, 'Provider must supply its model menu');
			assert.equal(client.turns, 1);
			let followup = await service.providers.ask({ provider, conversationID,
				prompt: 'What was the count in Paper B we just discussed? Reply briefly with its source citation.',
				onText: () => {}, signal: new win.AbortController().signal });
			assert.include(followup.text, '17');
			assert.include(followup.text, '[S2]');
			assert.equal(client.turns, 2, 'Follow-up must reuse the live conversation');
		});
	}
});
