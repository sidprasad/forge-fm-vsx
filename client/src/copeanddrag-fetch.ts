import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { unzipSync } from 'fflate';
import type * as vscode from 'vscode';

/**
 * Fetch a Cope and Drag release into a local cache at runtime.
 *
 * The extension no longer vendors a Cope and Drag build at package time. Instead, when
 * `forge.copeAndDragVersion` selects a release (including the default), this module materializes its
 * `sterling-forge.zip` GitHub asset into the extension's global storage, from where
 * `CopeAndDragServer` serves it. An explicit empty setting uses Forge's own bundled copy.
 *
 * This is the same hardened download/extract that `scripts/fetch-copeanddrag.js` used to run at
 * build time; it now runs on demand and caches per tag, so a pinned version is fetched once and is
 * an instant no-op thereafter.
 */

const REPO = 'sidprasad/copeanddrag';
const ASSET = 'sterling-forge.zip';
const MAX_REDIRECTS = 5;
// Files that must be present for a bundle to be usable. Guards against a truncated download or an
// upstream release whose asset layout changed.
const REQUIRED = ['index.html', 'main.bundle.js'];

// A Cope and Drag release tag. Unlike the old build-time pin (which came from package.json and was
// trusted), this value now comes from user settings, so validate it before it reaches a download
// URL or a filesystem path: no separators, no scheme smuggling, no `..` traversal into the cache.
const TAG_RE = /^v?[0-9A-Za-z][0-9A-Za-z.\-]*$/;

export function isValidTag(tag: string): boolean {
	return TAG_RE.test(tag) && !tag.includes('..');
}

function download(url: string, redirectsLeft = MAX_REDIRECTS): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'User-Agent': 'forge-fm-vsx' } }, (res) => {
			const { statusCode, headers } = res;
			// GitHub release downloads redirect to object storage.
			if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
				res.resume();
				if (redirectsLeft === 0) {
					reject(new Error('Too many redirects'));
					return;
				}
				const next = new URL(headers.location, url);
				if (next.protocol !== 'https:') {
					reject(new Error(`Refusing to follow non-HTTPS redirect to ${next.protocol}//`));
					return;
				}
				resolve(download(next.toString(), redirectsLeft - 1));
				return;
			}
			if (statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${statusCode} fetching ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c as Buffer));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		}).on('error', reject);
	});
}

/**
 * Extract into `dest`. Release assets have so far been flat (index.html at the archive root), but
 * older tooling produced a single `dist/`/`build/` wrapper — handle both by locating whichever
 * prefix contains index.html.
 */
function extract(zipBuffer: Buffer, dest: string): number {
	const entries = unzipSync(new Uint8Array(zipBuffer));
	const names = Object.keys(entries);

	const indexEntry = names
		.filter((n) => n === 'index.html' || n.endsWith('/index.html'))
		.sort((a, b) => a.length - b.length)[0];
	if (!indexEntry) {
		throw new Error('Archive contains no index.html — unexpected asset layout');
	}
	const prefix = indexEntry.slice(0, indexEntry.length - 'index.html'.length);

	let written = 0;
	for (const name of names) {
		if (name.endsWith('/') || !name.startsWith(prefix)) {
			continue; // directory entry, or outside the bundle root
		}
		const rel = name.slice(prefix.length);
		const outPath = path.join(dest, rel);
		// Zip-slip guard: never let an archive entry escape `dest`.
		const rootWithSep = dest.endsWith(path.sep) ? dest : dest + path.sep;
		if (!outPath.startsWith(rootWithSep)) {
			throw new Error(`Archive entry escapes the target directory: ${name}`);
		}
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, Buffer.from(entries[name]));
		written++;
	}

	const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dest, f)));
	if (missing.length > 0) {
		throw new Error(`Extracted bundle is missing: ${missing.join(', ')}`);
	}
	return written;
}

/** True when `dir` already holds a complete copy of `tag`. */
function isComplete(dir: string, tag: string): boolean {
	try {
		if (fs.readFileSync(path.join(dir, '.fetched-tag'), 'utf8').trim() !== tag) {
			return false;
		}
	} catch {
		return false;
	}
	return REQUIRED.every((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Ensure release `tag` is available on disk and return the directory that holds it.
 *
 * A complete cached copy is an instant no-op; otherwise the release asset is downloaded and
 * extracted. Staging into a sibling dir and renaming into place means a killed fetch can never
 * leave a partial bundle that a later run would go on to accept.
 *
 * Throws on an invalid tag, a failed download, or a malformed archive — callers fall back to
 * Forge's own Cope and Drag.
 */
export async function ensureReleaseFetched(
	tag: string,
	cacheRootDir: string,
	output: vscode.OutputChannel
): Promise<string> {
	if (!isValidTag(tag)) {
		throw new Error(`Invalid Cope and Drag version "${tag}" (expected a release tag like "v4.1.0")`);
	}

	const target = path.join(cacheRootDir, 'copeanddrag', tag);
	if (isComplete(target, tag)) {
		return target;
	}

	const url = `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`;
	output.appendLine(`[copeanddrag] fetching ${tag} from ${url}`);
	const zip = await download(url);
	output.appendLine(`[copeanddrag] downloaded ${(zip.length / 1e6).toFixed(1)} MB`);

	const staging = `${target}.staging-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	try {
		const written = extract(zip, staging);
		fs.writeFileSync(path.join(staging, '.fetched-tag'), tag);
		fs.rmSync(target, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.renameSync(staging, target);
		output.appendLine(`[copeanddrag] installed ${written} files for ${tag}`);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
	return target;
}
