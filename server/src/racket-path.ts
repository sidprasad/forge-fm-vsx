import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const COMMON_PATHS = [
	'/usr/local/bin/racket',
	'/usr/bin/racket',
	'/opt/homebrew/bin/racket',
	path.join(process.env.HOME || '', '.local/bin/racket'),
	'C:\\Program Files\\Racket\\racket.exe',
	'C:\\Program Files (x86)\\Racket\\racket.exe',
];

function isValidRacket(candidate: string): boolean {
	try {
		if (!candidate || !fs.existsSync(candidate)) return false;
		const out = execSync(`"${candidate}" --version`, { encoding: 'utf-8', timeout: 5000 });
		return out.toLowerCase().includes('racket');
	} catch {
		return false;
	}
}

export function discoverRacket(configuredPath?: string): string | null {
	if (configuredPath && isValidRacket(configuredPath)) return configuredPath;

	try {
		const which = process.platform === 'win32' ? 'where racket' : 'which racket';
		const p = execSync(which, { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
		if (p && isValidRacket(p)) return p;
	} catch {
		/* fall through */
	}

	for (const p of COMMON_PATHS) {
		if (isValidRacket(p)) return p;
	}
	return null;
}
