/* SPDX-License-Identifier: AGPL-3.0-or-later */
const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
const { parseEvent } = require('./core');

class Providers {
	constructor(Zotero) {
		this.Zotero = Zotero;
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

	async status(provider, custom) {
		let process = await this.spawn(provider, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], custom);
		let [stdout, stderr, result] = await Promise.all([this.readAll(process.stdout), this.readAll(process.stderr), process.wait()]);
		if (provider === 'codex') {
			return { connected: result.exitCode === 0 && /ChatGPT/i.test(stdout + stderr),
				message: (stdout + stderr).trim() };
		}
		let auth;
		try { auth = JSON.parse(stdout); }
		catch (_) { return { connected: false, message: stderr || stdout }; }
		return { connected: !!auth.loggedIn && !!auth.subscriptionType && auth.apiProvider === 'firstParty',
			message: auth.loggedIn ? `Signed in (${auth.subscriptionType || auth.authMethod})` : 'Run claude auth login in Terminal, then check again.' };
	}

	async readAll(pipe) {
		let text = '', part;
		while ((part = await pipe.readString())) text += part;
		return text;
	}

	async ask({ provider, model, executable, prompt, onText, signal }) {
		let args = provider === 'codex' ? [
			'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
			'--sandbox', 'read-only', '--json', '--color', 'never',
			'-c', 'web_search="disabled"', '-c', 'features.shell_tool=false',
			'-c', 'features.apply_patch_freeform=false', '-c', 'features.multi_agent=false',
			'-c', 'features.plugins=false', '-c', 'features.memories=false',
			'-c', 'features.skill_search=false', '-c', 'features.view_image=false',
			'-c', 'features.hooks=false', '-c', 'features.unified_exec=false',
			'-c', 'features.code_mode_host=false', '-c', 'features.remote_plugin=false',
			'-c', 'features.skip_host_skill_discovery=true',
			'-c', 'project_doc_max_bytes=0', '-c', 'model_provider="openai"',
			'-c', 'forced_login_method="chatgpt"'
		] : ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
			'--no-session-persistence', '--no-chrome', '--disable-slash-commands',
			'--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
		if (model) args.push('--model', model);
		if (provider === 'codex') args.push('-');
		if (signal.aborted) throw new Error('Stopped.');
		let auth = await this.status(provider, executable);
		if (!auth.connected) throw new Error(provider === 'codex'
			? 'Sign in to your ChatGPT subscription with codex login, then try again.'
			: 'Sign in to your Claude subscription with claude auth login, then try again.');
		if (signal.aborted) throw new Error('Stopped.');
		let process = await this.spawn(provider, args, executable);
		let aborted = () => process.kill();
		signal.addEventListener('abort', aborted, { once: true });
		let timer = setTimeout(() => process.kill(), 240000);
		let errors = this.readAll(process.stderr);
		let answer = '', buffer = '', done = false, usage, failure;
		try {
			if (signal.aborted) process.kill();
			await process.stdin.write(prompt);
			await process.stdin.close();
			let consume = line => {
				if (!line.trim()) return;
				let event;
				try { event = JSON.parse(line); }
				catch (_) { return; }
				let result = parseEvent(provider, event);
				if (result.error) failure = result.error;
				if (result.text) { answer += result.text; onText(answer); }
				if (result.done) {
					done = true;
					usage = result.usage;
					if (!answer && result.fallback) { answer = result.fallback; onText(answer); }
				}
			};
			let part;
			while ((part = await process.stdout.readString())) {
				buffer += part;
				let lines = buffer.split('\n');
				buffer = lines.pop();
				lines.forEach(consume);
			}
			consume(buffer);
			let { exitCode } = await process.wait();
			let stderr = await errors;
			if (signal.aborted) throw new Error('Stopped.');
			if (failure) throw new Error(failure);
			if (exitCode || !done || !answer.trim()) throw new Error(stderr.slice(-1400) || 'The connection closed before an answer completed. Try again.');
			return { text: answer.trim(), usage };
		}
		finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', aborted);
			process.kill();
			await errors.catch(() => {});
		}
	}
}
module.exports = Providers;
