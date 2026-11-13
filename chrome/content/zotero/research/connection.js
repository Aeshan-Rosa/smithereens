/* SPDX-License-Identifier: AGPL-3.0-or-later */
// JSONL transport shared by Codex App Server and Claude's streaming CLI.
// No provider SDK or VS Code extension UI is copied into the application.
class Connection {
	constructor(process, protocol) {
		this.process = process;
		this.protocol = protocol;
		this.pending = new Map();
		this.listeners = new Set();
		this.closed = false;
		this.sequence = 0;
		this.errors = '';
		this.writes = Promise.resolve();
		this.readErrors();
		this.readMessages();
	}

	async readErrors() {
		try {
			let part;
			while ((part = await this.process.stderr.readString())) this.errors = (this.errors + part).slice(-4000);
		}
		catch (_) {}
	}

	async readMessages() {
		try {
			let buffer = '', part;
			while ((part = await this.process.stdout.readString())) {
				buffer += part;
				let lines = buffer.split('\n');
				buffer = lines.pop();
				for (let line of lines) this.receive(line);
				if (buffer.length > 8 * 1024 * 1024) throw new Error('Provider sent an oversized message.');
			}
			if (buffer.trim()) this.receive(buffer);
			await this.process.wait();
			this.close(new Error(this.errors.trim().slice(-1400) || 'The provider connection closed. Try again.'));
		}
		catch (error) { this.close(error); }
	}

	receive(line) {
		if (!line.trim()) return;
		let event;
		try { event = JSON.parse(line); }
		catch (_) { return; }
		let response = this.protocol === 'claude' && event.type === 'control_response' ? event.response : event;
		let id = this.protocol === 'claude' ? response?.request_id : response.id;
		if (id !== undefined && this.pending.has(id) && (this.protocol === 'claude' || !event.method)) {
			let pending = this.pending.get(id);
			this.pending.delete(id);
			clearTimeout(pending.timer);
			let error = this.protocol === 'claude' ? response.subtype === 'error' && response.error : response.error?.message;
			if (error) pending.reject(new Error(error));
			else pending.resolve(this.protocol === 'claude' ? response.response : response.result);
			return;
		}
		// Research requests never grant coding, filesystem, or external tool access.
		if (event.method && event.id !== undefined) {
			this.send({ id: event.id, error: { code: -32601, message: 'This research client does not provide tools or approvals.' } }).catch(() => {});
			return;
		}
		if (event.type === 'control_request') {
			this.send({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id,
				error: 'Tools and permission requests are disabled in the research assistant.' } }).catch(() => {});
			return;
		}
		for (let listener of this.listeners) listener(event);
	}

	send(event) {
		if (this.closed) return Promise.reject(new Error('The provider is disconnected.'));
		this.writes = this.writes.then(() => this.process.stdin.write(JSON.stringify(event) + '\n'));
		return this.writes;
	}

	request(method, params = {}, timeout = 30000) {
		if (this.closed) return Promise.reject(new Error('The provider is disconnected.'));
		let id = String(++this.sequence);
		return new Promise((resolve, reject) => {
			let timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The provider did not respond to ${method}. Try reconnecting.`));
			}, timeout);
			this.pending.set(id, { resolve, reject, timer });
			let event = this.protocol === 'claude'
				? { type: 'control_request', request_id: id, request: { subtype: method, ...params } }
				: { id, method, params };
			this.send(event).catch(error => {
				clearTimeout(timer); this.pending.delete(id); reject(error);
			});
		});
	}

	close(error = new Error('Disconnected.')) {
		if (this.closed) return;
		this.closed = true;
		for (let pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
		try { this.process.kill(); }
		catch (_) {}
		for (let listener of this.listeners) listener({ type: 'connection_closed', error });
		this.listeners.clear();
	}
}

module.exports = Connection;
