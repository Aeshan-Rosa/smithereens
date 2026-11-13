const { test } = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../chrome/content/zotero/research/clients');
const Connection = require('../chrome/content/zotero/research/connection');
const Core = require('../chrome/content/zotero/research/core');

function pipe() {
	let queue = [], waiter;
	return {
		readString: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiter = resolve; }),
		push(value) { if (waiter) { let resolve = waiter; waiter = null; resolve(value); } else queue.push(value); }
	};
}
function fakeProcess() {
	let stdout = pipe(), stderr = pipe(), writes = [];
	return { stdout, stderr, writes, stdin: { write: async line => writes.push(JSON.parse(line)) },
		wait: async () => ({ exitCode: 0 }), kill() { stdout.push(''); stderr.push(''); },
		emit(event) { stdout.push(JSON.stringify(event) + '\n'); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('history migration retains messages, assigns provider tabs, and recovers interrupted turns', () => {
	const old = { version: 1, settings: { provider: 'claude', model: 'sonnet' }, sessions: [
		{ id: 'a', messages: [{ role: 'assistant', provider: 'codex', text: 'Saved answer' }] },
		{ id: 'b', messages: [{ role: 'assistant', provider: 'claude', text: 'Partial', pending: true }] }
	] };
	const state = Core.migrateState(old);
	assert.equal(old.version, 1);
	assert.equal(state.version, 2);
	assert.equal(state.sessions[0].provider, 'codex');
	assert.equal(state.sessions[0].messages[0].text, 'Saved answer');
	assert.equal(state.settings.models.claude, 'sonnet');
	assert.equal(state.settings.models.codex, '');
	assert.equal(state.sessions[1].messages[0].pending, false);
	assert.match(state.sessions[1].messages[0].error, /Interrupted/);
	assert.throws(() => Core.migrateState({ version: 99, sessions: [] }), /not been overwritten/);
});

test('JSONL transport accepts split frames and resolves out-of-order request IDs', async () => {
	const process = fakeProcess(), connection = new Connection(process, 'codex');
	const first = connection.request('one'), second = connection.request('two');
	await tick();
	process.stdout.push('{"id":"2","result":2}\n{"id":"1",');
	process.stdout.push('"result":1}\n');
	assert.deepEqual(await Promise.all([first, second]), [1, 2]);
	assert.equal(connection.pending.size, 0);
	connection.close();
});

test('a closed connection rejects outstanding requests and denies server tools', async () => {
	const process = fakeProcess(), connection = new Connection(process, 'codex');
	process.emit({ id: 'server', method: 'item/commandExecution/requestApproval' });
	await tick();
	assert.equal(process.writes[0].error.code, -32601);
	const pending = connection.request('waiting');
	connection.close(new Error('Connection lost'));
	await assert.rejects(pending, /Connection lost/);
	assert.equal(connection.pending.size, 0);
});

for (const provider of ['codex', 'claude']) {
	test(`${provider} streams, completes without duplicated text, and retains its process for follow-ups`, async () => {
		const process = fakeProcess(), client = new Client(process, provider);
		client.threadId = 'thread';
		const updates = [];
		for (let turn = 1; turn <= 2; turn++) {
			const answer = client.ask({ prompt: 'Question', signal: new AbortController().signal, onText: t => updates.push(t) });
			await tick();
			if (provider === 'codex') {
				const request = process.writes.at(-1);
				process.emit({ id: request.id, result: { turn: { id: `t${turn}` } } });
				process.emit({ method: 'item/agentMessage/delta', params: { threadId: 'wrong-thread', itemId: 'bad', delta: 'Crossed context' } });
				process.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: `t${turn}`, itemId: 'i', delta: 'Hello' } });
				process.emit({ method: 'item/completed', params: { threadId: 'thread', item: { id: 'i', type: 'agentMessage', text: 'Hello world' } } });
				process.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: `t${turn}`, status: 'completed' } } });
			}
			else {
				process.emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello' } } });
				process.emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: ' world' } } });
				process.emit({ type: 'result', result: 'Hello world' });
			}
			assert.equal((await answer).text, 'Hello world');
			assert.equal(client.turns, turn);
			assert.equal(client.closed, false);
		}
		assert.ok(updates.includes('Hello'));
		client.close();
	});

	test(`${provider} sends a real interrupt and closes the stopped conversation`, async () => {
		const process = fakeProcess(), client = new Client(process, provider), controller = new AbortController();
		client.threadId = 'thread';
		const answer = client.ask({ prompt: 'Question', signal: controller.signal });
		const rejected = assert.rejects(answer, /Stopped/);
		await tick();
		if (provider === 'codex') process.emit({ id: process.writes.at(-1).id, result: { turn: { id: 'turn' } } });
		await tick();
		controller.abort();
		await tick();
		const request = process.writes.at(-1);
		if (provider === 'codex') {
			assert.equal(request.method, 'turn/interrupt');
			process.emit({ id: request.id, result: {} });
		}
		else {
			assert.equal(request.request.subtype, 'interrupt');
			process.emit({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success', response: {} } });
		}
		await rejected;
		assert.equal(client.busy, false);
		assert.equal(client.closed, true);
	});
}
