/* SPDX-License-Identifier: AGPL-3.0-or-later */
const Connection = require('./connection');

class Client {
	constructor(process, provider) {
		this.provider = provider;
		this.connection = new Connection(process, provider);
		this.turns = 0;
		this.models = [];
	}

	get closed() { return this.connection.closed; }
	close() { this.connection.close(); }

	async initialize(model) {
		if (this.provider === 'codex') {
			await this.connection.request('initialize', { clientInfo: { name: 'smithereens', title: 'Smithereens Research', version: '0.2.0' } });
			await this.connection.send({ method: 'initialized', params: {} });
			let account = await this.connection.request('account/read', {});
			if (account.account?.type !== 'chatgpt') throw new Error('Sign in with codex login to use your ChatGPT subscription.');
			let models = await this.connection.request('model/list', {});
			this.models = models.data.filter(m => !m.hidden).map(m => ({ value: m.model, label: m.displayName }));
			let thread = await this.connection.request('thread/start', { model: model || null, ephemeral: true,
				modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'never' });
			this.threadId = thread.thread.id;
		}
		else {
			let result = await this.connection.request('initialize', {});
			this.models = (result?.models || []).map(m => ({ value: m.value || m.id, label: m.displayName || m.display_name || m.value || m.id })).filter(m => m.value);
		}
	}

	async ask({ prompt, signal, onText = () => {}, onStatus = () => {} }) {
		if (signal.aborted) throw new Error('Stopped.');
		if (this.busy) throw new Error('This conversation is already responding.');
		this.busy = true;
		try {
			return await new Promise((resolve, reject) => {
				let text = '', usage, turnId, complete = false, items = new Map();
				let finish = error => {
					if (complete) return;
					complete = true;
					clearTimeout(timer);
					signal.removeEventListener('abort', abort);
					this.connection.listeners.delete(receive);
					if (error) { this.close(); reject(error); }
					else if (!text.trim()) { this.close(); reject(new Error('The provider completed without an answer.')); }
					else { this.turns++; resolve({ text: text.trim(), usage }); }
				};
				let abort = () => {
					let interrupt = this.provider === 'codex' && turnId
						? this.connection.request('turn/interrupt', { threadId: this.threadId, turnId }, 1000)
						: this.provider === 'claude' ? this.connection.request('interrupt', {}, 1000) : Promise.resolve();
					interrupt.catch(() => {}).finally(() => finish(new Error('Stopped.')));
				};
				let publish = () => { onStatus('responding'); onText(text); };
				let receive = event => {
					if (event.type === 'connection_closed') return finish(event.error);
					if (this.provider === 'codex') {
						let p = event.params || {};
						if (p.threadId && p.threadId !== this.threadId) return;
						if (event.method === 'turn/started') turnId = p.turn.id;
						if (p.turnId && turnId && p.turnId !== turnId) return;
						if (event.method === 'item/agentMessage/delta') {
							items.set(p.itemId, (items.get(p.itemId) || '') + p.delta);
							text = [...items.values()].join('\n\n'); publish();
						}
						if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
							items.set(p.item.id, p.item.text);
							text = [...items.values()].join('\n\n'); publish();
						}
						if (event.method === 'thread/tokenUsage/updated' && p.tokenUsage?.last) {
							let last = p.tokenUsage.last;
							usage = { input_tokens: last.inputTokens, output_tokens: last.outputTokens };
						}
						if (event.method === 'turn/completed') finish(signal.aborted || p.turn.status === 'interrupted'
							? new Error('Stopped.') : p.turn.status === 'failed' ? new Error(p.turn.error?.message || 'Codex could not complete this request.') : null);
					}
					else {
						if (event.parent_tool_use_id) return;
						if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') { text += event.event.delta.text; publish(); }
						if (event.type === 'result') {
							if (!text && event.result) { text = event.result; publish(); }
							usage = event.usage;
							finish(signal.aborted ? new Error('Stopped.') : event.is_error ? new Error(event.result || (event.errors || []).join('\n') || 'Claude could not complete this request.') : null);
						}
					}
				};
				let timer = setTimeout(() => finish(new Error('The request timed out. Try again.')), 240000);
				this.connection.listeners.add(receive);
				signal.addEventListener('abort', abort, { once: true });
				onStatus('working');
				let started = this.provider === 'codex'
					? this.connection.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt }] }).then(result => { turnId = result.turn.id; })
					: this.connection.send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
				started.catch(finish);
				if (signal.aborted) abort();
			});
		}
		finally { this.busy = false; }
	}
}

module.exports = Client;
