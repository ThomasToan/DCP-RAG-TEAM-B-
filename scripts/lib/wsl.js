import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Project root as a Windows path, without a trailing slash (a trailing backslash would break wsl.exe's quoting). */
export const PROJECT_DIR = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '');

/** True when WSL2 Ubuntu answers. Tests that need PyMuPDF skip themselves otherwise. */
export function hasWsl() {
	try {
		return spawnSync('wsl', ['-d', 'Ubuntu', '--', 'true'], { timeout: 30_000 }).status === 0;
	} catch {
		return false;
	}
}

/**
 * Run `python <args>` in the WSL venv (~/dcp-venv). Paths in `args` must be relative to the project root and
 * contain no spaces: the project path itself has a space, so we set the directory with --cd instead.
 * @param {string[]} args
 * @returns {Promise<string>} trimmed stdout
 */
export function runPy(args) {
	return new Promise((resolve, reject) => {
		const p = spawn('wsl', ['-d', 'Ubuntu', '--cd', PROJECT_DIR, '--', 'bash', 'scripts/py.sh', ...args], { windowsHide: true });
		let out = '';
		let err = '';
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', reject);
		p.on('close', (code) =>
			code === 0 ? resolve(out.trim()) : reject(new Error(`python exited ${code}: ${(err || out).slice(-500)}`))
		);
	});
}
