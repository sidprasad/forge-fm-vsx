import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

/**
 * Extension-owned Cope and Drag.
 *
 * Forge bundles its own copy of the Cope and Drag build and serves it from Racket. That
 * ties the visualizer's release cadence to Forge's: shipping a CnD fix means cutting a
 * Forge release *and* getting every user to `raco pkg update forge`.
 *
 * Instead we vendor the build ourselves (see scripts/fetch-copeanddrag.js), serve it from
 * here, and run Forge with `-O run_sterling serve` so it starts only the WebSocket data
 * provider and no static server of its own. CnD then ships on the extension's cadence,
 * which VS Code auto-updates.
 *
 * This works without any Forge change because the frontend derives its provider socket
 * from the query string alone — `ws://localhost:${location.search.slice(1)}` — so it does
 * not care which origin served it.
 *
 * When the bundle is absent or the installed Forge predates `serve` mode, callers fall
 * back to Forge's own copy (`-O run_sterling headless`), which is the extension's
 * long-standing behaviour.
 */

/** Path of the vendored bundle inside the extension, or undefined if it was not vendored. */
export function getBundlePath(context: vscode.ExtensionContext): string | undefined {
	const dir = context.asAbsolutePath(path.join('client', 'copeanddrag'));
	return fs.existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

/** Version of the vendored bundle, read from the build's own version.json. For diagnostics. */
export function getBundleVersion(bundlePath: string): string | undefined {
	try {
		const raw = fs.readFileSync(path.join(bundlePath, 'version.json'), 'utf8');
		const parsed = JSON.parse(raw);
		return typeof parsed.version === 'string' ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.webapp': 'application/x-web-app-manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf'
};

/**
 * A loopback static file server for the vendored bundle.
 *
 * One server is shared by every run: only the provider port changes between runs, so
 * there is no reason to churn the static port too. It starts on first use and is disposed
 * when the extension deactivates.
 */
export class CopeAndDragServer implements vscode.Disposable {
	private server: http.Server | undefined;
	private port: number | undefined;
	private starting: Promise<number> | undefined;

	constructor(private readonly rootDir: string, private readonly output: vscode.OutputChannel) {}

	/** Start if needed and return the listening port. Concurrent callers share one start. */
	async ensureStarted(): Promise<number> {
		if (this.port !== undefined) {
			return this.port;
		}
		if (!this.starting) {
			this.starting = this.start().finally(() => { this.starting = undefined; });
		}
		return this.starting;
	}

	private start(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const server = http.createServer((req, res) => this.handle(req, res));
			server.on('error', reject);
			// Port 0 lets the OS assign a free port, so there is no bind race to lose.
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address();
				if (!addr || typeof addr !== 'object') {
					server.close();
					reject(new Error('Could not determine the Cope and Drag server port'));
					return;
				}
				this.server = server;
				this.port = addr.port;
				const version = getBundleVersion(this.rootDir) ?? 'unknown version';
				// Worth stating plainly: when a visualizer bug is reported, the first question is
				// which Cope and Drag produced it — the extension's copy or Forge's.
				this.output.appendLine(
					`✓ Cope and Drag ${version} (bundled with this extension), served on 127.0.0.1:${addr.port}`
				);
				resolve(addr.port);
			});
		});
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		// This runs on the extension host. An exception escaping a request listener is an
		// uncaught exception, which takes the host down — so nothing in here may throw,
		// however malformed the request. (A bare `GET /%00` used to do exactly that: the
		// null byte survives decoding and fs.stat rejects it *synchronously*.)
		try {
			this.serve(req, res);
		} catch {
			try {
				res.writeHead(400).end();
			} catch {
				res.destroy();
			}
		}
	}

	private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405).end();
			return;
		}

		// The URL carries the provider port as its query (`/?54321`); only the path selects a file.
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
		} catch {
			res.writeHead(400).end();
			return;
		}
		// Null bytes never appear in a legitimate asset path and are rejected by the fs layer.
		if (pathname.includes('\0')) {
			res.writeHead(400).end();
			return;
		}
		if (pathname.endsWith('/')) {
			pathname += 'index.html';
		}

		const filePath = path.join(this.rootDir, pathname);
		// Containment check: never serve outside the bundle, whatever the request path says.
		const rootWithSep = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
		if (!filePath.startsWith(rootWithSep)) {
			res.writeHead(403).end();
			return;
		}

		fs.stat(filePath, (err, stat) => {
			if (err || !stat.isFile()) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, {
				'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
				'Content-Length': stat.size,
				// The bundle is immutable for the lifetime of an extension version, but the
				// webview should still re-read it after an update, so revalidate rather than cache.
				'Cache-Control': 'no-cache'
			});
			if (req.method === 'HEAD') {
				res.end();
				return;
			}
			const stream = fs.createReadStream(filePath);
			stream.on('error', () => res.destroy());
			stream.pipe(res);
		});
	}

	dispose(): void {
		this.server?.close();
		this.server = undefined;
		this.port = undefined;
	}
}
