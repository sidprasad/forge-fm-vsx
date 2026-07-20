#!/usr/bin/env node
/**
 * Vendor the Cope and Drag build into the extension at build time.
 *
 * The bundle is a build artifact, not source, so it is NOT committed (see .gitignore).
 * Instead the release tag is pinned in package.json's `copeAndDragVersion`, and this
 * script materializes `client/copeanddrag/` from the matching GitHub release asset.
 * That makes "ship a new Cope and Drag" a one-line, reviewable diff.
 *
 * Runs from both `postinstall` (local dev) and `vscode:prepublish` (packaging/CI), and
 * is a no-op when the pinned tag is already on disk.
 *
 * Failure is non-fatal by default: a developer without network still gets a working
 * checkout, because the extension degrades to Forge's bundled Cope and Drag at runtime.
 * Packaging sets CND_REQUIRED=1 so a publish can never silently ship without the bundle.
 *
 * Escape hatches:
 *   SKIP_CND_FETCH=1   skip entirely (offline dev; the extension falls back to Forge's
 *                      own bundled copy at runtime)
 *   --required         treat any failure as fatal (passed by vscode:prepublish)
 *   CND_REPO=owner/name  override the source repo
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { unzipSync } = require('fflate');

const REPO = process.env.CND_REPO || 'sidprasad/copeanddrag';
const ASSET = 'sterling-forge.zip';
const MAX_REDIRECTS = 5;

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'client', 'copeanddrag');
const STAMP = path.join(TARGET, '.fetched-tag');
// Files that must be present for the bundle to be usable. Guards against a truncated
// download or an upstream release whose asset layout changed.
const REQUIRED = ['index.html', 'main.bundle.js'];

function log(msg) {
	console.log(`[copeanddrag] ${msg}`);
}

function readPinnedTag() {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	const tag = pkg.copeAndDragVersion;
	if (!tag) {
		throw new Error('package.json is missing "copeAndDragVersion" (e.g. "v4.0.19")');
	}
	return tag;
}

/** True when `client/copeanddrag/` already holds a complete copy of `tag`. */
function alreadyFetched(tag) {
	try {
		if (fs.readFileSync(STAMP, 'utf8').trim() !== tag) {
			return false;
		}
	} catch {
		return false;
	}
	return REQUIRED.every((f) => fs.existsSync(path.join(TARGET, f)));
}

function download(url, redirectsLeft = MAX_REDIRECTS) {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'User-Agent': 'forge-fm-vsx' } }, (res) => {
			const { statusCode, headers } = res;
			// GitHub release downloads redirect to object storage.
			if (statusCode >= 300 && statusCode < 400 && headers.location) {
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
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		}).on('error', reject);
	});
}

/**
 * Extract into `dest`. Release assets have so far been flat (index.html at the archive
 * root), but older tooling produced a single `dist/`/`build/` wrapper — handle both by
 * locating whichever prefix contains index.html.
 */
function extract(zipBuffer, dest) {
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

async function main() {
	if (process.env.SKIP_CND_FETCH === '1') {
		log('SKIP_CND_FETCH=1 — skipping. The extension will fall back to Forge\'s bundled Cope and Drag.');
		return;
	}

	const tag = readPinnedTag();
	if (alreadyFetched(tag)) {
		log(`${tag} already present — nothing to do.`);
		return;
	}

	const url = `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`;
	log(`fetching ${tag} from ${url}`);
	const zip = await download(url);
	log(`downloaded ${(zip.length / 1e6).toFixed(1)} MB`);

	// Stage into a sibling temp dir, then swap. A killed run can never leave a partial
	// bundle behind that `alreadyFetched` would go on to accept.
	const staging = path.join(ROOT, 'client', `.copeanddrag-staging-${process.pid}`);
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	try {
		const written = extract(zip, staging);
		fs.writeFileSync(path.join(staging, '.fetched-tag'), tag);
		fs.rmSync(TARGET, { recursive: true, force: true });
		fs.renameSync(staging, TARGET);
		log(`installed ${written} files into client/copeanddrag (${tag})`);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

main().catch((err) => {
	if (process.argv.includes('--required')) {
		console.error(`[copeanddrag] FAILED: ${err.message}`);
		console.error('[copeanddrag] Refusing to package without the bundle.');
		process.exit(1);
	}
	// Non-fatal: don't break `npm install` over a network blip. The extension logs which
	// Cope and Drag it ended up using, and falls back to Forge's copy when ours is missing.
	console.warn(`[copeanddrag] WARNING: ${err.message}`);
	console.warn('[copeanddrag] Continuing without a vendored bundle; Forge\'s own copy will be used at runtime.');
});
