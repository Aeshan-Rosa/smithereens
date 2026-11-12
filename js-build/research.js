// Bundle the exact upstream SDT text/range helpers alongside its pack reader.
// The document-worker read bundle deliberately does not export full-text helpers.
const fs = require('fs/promises');
const path = require('path');
const babel = require('@babel/core');

module.exports = async function () {
	const started = Date.now();
	const source = path.resolve(__dirname, '../document-worker/structured-document-text/src');
	const target = path.resolve(__dirname, '../build/resource/research-sdt');
	const seen = new Set();
	async function compile(relative) {
		if (seen.has(relative)) return;
		seen.add(relative);
		const input = await fs.readFile(path.join(source, relative), 'utf8');
		for (const match of input.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
			if (!match[1].startsWith('.')) throw new Error('Unexpected external SDT dependency');
			await compile(path.normalize(path.join(path.dirname(relative), match[1])));
		}
		const { code } = await babel.transformAsync(input, { babelrc: false, configFile: false,
			plugins: ['transform-es2015-modules-commonjs'] });
		const output = path.join(target, relative);
		await fs.mkdir(path.dirname(output), { recursive: true });
		let previous = await fs.readFile(output, 'utf8').catch(() => '');
		if (previous !== code) await fs.writeFile(output, code);
	}
	await compile('fulltext.js');
	return { action: 'research-sdt', count: seen.size, totalCount: seen.size, processingTime: Date.now() - started };
};
