/* SPDX-License-Identifier: AGPL-3.0-or-later */
const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
const Client = require('./clients');

class Providers {
	constructor(Zotero) {
		this.Zotero = Zotero;
		this.clients = new Map();
		this.initializing = new Set();
		this.disposed = false;
	}

	async executable(provider, custom) {
		let home = Services.dirsvc.get('Home', Ci.nsIFile).path;
		let candidates = custom ? [custom] : [
			PathUtils.join(home, '.local', 'bin', provider),
			`/opt/homebrew/bin/${provider}`, `/usr/local/bin/${provider}`
		];
		for (let path of candidates) {
			if (await IOUtils.exists(path)) return path;
		}
		if (custom) throw new Error(`The configured ${provider} executable does not exist.`);
		try { return await Subprocess.pathSearch(provider); }
		catch (_) { throw new Error(`${provider} was not found. Install its CLI, sign in, or set its executable path in Settings.`); }
	}

	async spawn(provider, args, custom) {
		let cwd = PathUtils.join(this.Zotero.Profile.dir, 'research-runtime');
		await IOUtils.makeDirectory(cwd, { ignoreExisting: true });
		let environment = Subprocess.getEnvironment();
		// Subscription mode never silently falls back to a paid API key.
		for (let key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL',
			'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete environment[key];
		environment.PATH = `/opt/homebrew/bin:/usr/local/bin:${environment.PATH || '/usr/bin:/bin'}`;
		return Subprocess.call({ command: await this.executable(provider, custom), arguments: args,
			workdir: cwd, environment, environmentAppend: false, stderr: 'pipe' });
	}

	async status(provider, custom, signal) {
		if (signal?.aborted) throw new Error('Stopped.');
		let process = await this.spawn(provider, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], custom);
		let expired = false;
		let stop = () => process.kill();
		let timer = setTimeout(() => { expired = true; stop(); }, 15000);
		signal?.addEventListener('abort', stop, { once: true });
		if (signal?.aborted) stop();
		try {
			let [stdout, stderr, result] = await Promise.all([this.readAll(process.stdout), this.readAll(process.stderr), process.wait()]);
			if (signal?.aborted) throw new Error('Stopped.');
			if (expired) throw new Error('Sign-in check timed out. Try again.');
			if (provider === 'codex') return { connected: result.exitCode === 0 && /ChatGPT/i.test(stdout + stderr), message: (stdout + stderr).trim() };
			let auth;
			try { auth = JSON.parse(stdout); }
			catch (_) { return { connected: false, message: stderr || stdout }; }
			return { connected: !!auth.loggedIn && !!auth.subscriptionType && auth.apiProvider === 'firstParty',
				message: auth.loggedIn ? `Signed in (${auth.subscriptionType || auth.authMethod})` : 'Run claude auth login in Terminal, then check again.' };
		}
		finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
	}

	async readAll(pipe) {
		let text = '', part;
		while ((part = await pipe.readString())) text = (text + part).slice(-16000);
		return text;
	}

	arguments(provider, model) {
		if (provider === 'claude') {
			let args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
				'--no-session-persistence', '--no-chrome', '--disable-slash-commands',
				'--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
			if (model) args.push('--model', model);
			return args;
		}
		let args = ['app-server', '--listen', 'stdio://'];
		let config = { web_search: 'disabled', model_provider: 'openai', project_doc_max_bytes: 0,
			mcp_servers: {}, developer_instructions: '', notify: [], 'skills.config': [] };
		for (let feature of ['shell_tool', 'apply_patch_freeform', 'multi_agent', 'plugins', 'memories', 'skill_search',
			'view_image', 'hooks', 'unified_exec', 'code_mode_host', 'remote_plugin']) config[`features.${feature}`] = false;
		config['features.skip_host_skill_discovery'] = true;
		for (let [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
		return args;
	}

	async connect({ provider, model = '', executable, conversationID = 'connection-check', contextKey = '', signal }) {
		if (this.disposed) throw new Error('The research workspace has closed.');
		if (!['codex', 'claude'].includes(provider)) throw new Error('Choose Codex or Claude.');
		if (signal?.aborted) throw new Error('Stopped.');
		let key = `${provider}:${conversationID}`;
		let signature = JSON.stringify([model, executable || '', contextKey]);
		let existing = this.clients.get(key);
		if (existing && !existing.client.closed && existing.signature === signature) return existing.client;
		existing?.client.close();
		this.clients.delete(key);
		if (provider === 'claude') {
			let auth = await this.status(provider, executable, signal);
			if (!auth.connected) throw new Error('Sign in to your Claude subscription with claude auth login, then try again.');
		}
		let process = await this.spawn(provider, this.arguments(provider, model), executable);
		let client = new Client(process, provider);
		this.initializing.add(client);
		let abort = () => client.connection.close(new Error('Stopped.'));
		signal?.addEventListener('abort', abort, { once: true });
		try {
			if (signal?.aborted || this.disposed) abort();
			await client.initialize(model);
			if (signal?.aborted) throw new Error('Stopped.');
			this.clients.set(key, { client, signature });
			// Keep a small number of warm conversations; never evict a running turn.
			for (let [oldKey, entry] of this.clients) {
				if (this.clients.size <= 4) break;
				if (oldKey !== key && !entry.client.busy) { entry.client.close(); this.clients.delete(oldKey); }
			}
			return client;
		}
		catch (error) { client.close(); throw error; }
		finally { this.initializing.delete(client); signal?.removeEventListener('abort', abort); }
	}

	async ask(options) {
		let client = await this.connect(options);
		options.onModels?.(client.models);
		let prompt = typeof options.prompt === 'function' ? options.prompt(client.turns > 0) : options.prompt;
		return client.ask({ ...options, prompt });
	}

	dispose() {
		this.disposed = true;
		for (let client of this.initializing) client.close();
		this.initializing.clear();
		for (let { client } of this.clients.values()) client.close();
		this.clients.clear();
	}
}
module.exports = Providers;
