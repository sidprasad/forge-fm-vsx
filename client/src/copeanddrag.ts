import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

/**
 * Extension-served Cope and Drag.
 *
 * The extension fetches the release selected by `forge.copeAndDragVersion` at runtime (see
 * copeanddrag-fetch.ts), including the manifest's default, serves it from the loopback server below,
 * and runs Forge with
 * `-O run_sterling serve` so Forge starts only the WebSocket data provider and no static server of
 * its own. The default release updates on the extension's cadence, independently of Forge's.
 * An explicit empty setting uses Forge's bundled copy (`-O run_sterling headless`) without a download.
 *
 * This works without any Forge change because the frontend derives its provider socket from the
 * query string alone — `ws://localhost:${location.search.slice(1)}` — so it does not care which
 * origin served it.
 *
 * Any failure of the selected release (no such release, offline, or a Forge too old for `serve` mode)
 * falls back to Forge's own copy.
 */

/** Version of a bundle on disk, read from the build's own version.json. For diagnostics. */
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
 * A loopback static file server for an extension-served Cope and Drag bundle.
 *
 * One server is shared by every run: only the provider port changes between runs, so there is no
 * reason to churn the static port too. The bundle it serves (`rootDir`) can change between runs when
 * the user re-pins `forge.copeAndDragVersion`, so the root is (re)set on each `ensureStarted` call.
 * It starts on first use and is disposed when the extension deactivates.
 */
export class CopeAndDragServer implements vscode.Disposable {
	private server: http.Server | undefined;
	private port: number | undefined;
	private starting: Promise<number> | undefined;
	private rootDir: string | undefined;

	constructor(private readonly output: vscode.OutputChannel) {}

	/**
	 * Start if needed, serving from `rootDir`, and return the listening port. Concurrent callers
	 * share one start. Re-pointing an already-running server at a different bundle just swaps the
	 * root — the port is stable, and each run's webview reloads, so no in-flight request straddles
	 * the swap.
	 */
	async ensureStarted(rootDir: string): Promise<number> {
		const changed = this.rootDir !== rootDir;
		this.rootDir = rootDir;
		if (this.port !== undefined) {
			if (changed) {
				this.logServing(this.port);
			}
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
				this.logServing(addr.port);
				resolve(addr.port);
			});
		});
	}

	/**
	 * Note which Cope and Drag ended up serving. Worth stating plainly: when a visualizer bug is
	 * reported, the first question is which Cope and Drag produced it — the extension's fetched copy
	 * or Forge's.
	 */
	private logServing(port: number): void {
		const version = (this.rootDir && getBundleVersion(this.rootDir)) ?? 'unknown version';
		this.output.appendLine(
			`✓ Cope and Drag ${version} (fetched by this extension), served on 127.0.0.1:${port}`
		);
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

		// Only reachable via ensureStarted, which sets rootDir before the server can accept a
		// request; guard anyway so a stray request can never join against an undefined root.
		const rootDir = this.rootDir;
		if (!rootDir) {
			res.writeHead(503).end();
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

		const filePath = path.join(rootDir, pathname);
		// Containment check: never serve outside the bundle, whatever the request path says.
		const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
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
