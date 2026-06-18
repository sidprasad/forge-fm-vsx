import * as vscode from 'vscode';
import * as net from 'net';
import { ForgeRunner } from './forge-runner';

/**
 * Sterling-in-a-webview support.
 *
 * Instead of letting Forge open the system browser, we run Forge in headless mode on
 * ports we pick ourselves (via `-O sterling_static_port` / `-O sterling_port`), then
 * embed the localhost Sterling page in a VS Code webview panel via an <iframe>.
 *
 * This requires no changes to Forge: it relies only on Forge's existing command-line
 * option overrides (`-O <name> <value>`) and headless `run_sterling` mode.
 */

let sterlingPanel: vscode.WebviewPanel | undefined;
// Guards against the panel's onDidDispose handler stopping Forge when the panel is being
// disposed *because* Forge already exited.
let disposingFromExit = false;
// Identifies the Forge run that currently owns the panel. Each run picks fresh ports, so when
// a new run takes over the panel the previous run's (possibly delayed) exit must NOT tear down
// the live panel — it would leave the new run staring at a closed webview. Guard dispose by token.
let activeRunToken: string | undefined;

/**
 * Find a free TCP port by binding to port 0 on loopback and reading the assigned port.
 * There is a small TOCTOU window between closing the listener and Forge binding the port;
 * acceptable here since the ports are ephemeral and local-only.
 */
export function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const { port } = addr;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error('Could not determine a free port')));
			}
		});
	});
}

/**
 * Find two distinct free ports (static-file server + WebSocket provider).
 */
export async function findSterlingPorts(): Promise<{ staticPort: number; providerPort: number }> {
	const staticPort = await findFreePort();
	let providerPort = await findFreePort();
	while (providerPort === staticPort) {
		providerPort = await findFreePort();
	}
	return { staticPort, providerPort };
}

/**
 * Open (or refresh) the Sterling webview panel pointed at the given localhost URL.
 * Closing the panel stops the active Forge run, which tears down the Sterling servers.
 *
 * `runToken` identifies the run that owns the panel from this point on, so a later run's
 * teardown can tell whether it still owns the panel before disposing it.
 */
export async function openSterlingWebview(rawUrl: string, forgeRunner: ForgeRunner, runToken: string): Promise<void> {
	// This run now owns the panel. A previous run's pending exit will see a mismatched token
	// and leave the panel alone.
	activeRunToken = runToken;

	// asExternalUri preserves the path + `?<provider-port>` query and, under Remote/Codespaces,
	// would forward the static port. (Remote support is out of scope for now; locally this is
	// a no-op that returns the same 127.0.0.1 URL.)
	const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(rawUrl));
	const html = getSterlingHtml(externalUri);

	if (sterlingPanel) {
		sterlingPanel.webview.html = html;
		sterlingPanel.reveal(vscode.ViewColumn.Beside, true);
		return;
	}

	sterlingPanel = vscode.window.createWebviewPanel(
		'forgeSterling',
		'Cope and Drag',
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true }
	);
	sterlingPanel.webview.html = html;

	sterlingPanel.onDidDispose(() => {
		sterlingPanel = undefined;
		activeRunToken = undefined;
		if (!disposingFromExit) {
			// User closed the panel: stop the Forge run the same way the "Continue" button does.
			forgeRunner.sendInput('\n');
		}
	});
}

/**
 * Mark the Sterling panel stale (e.g. when the owning Forge run exits, so its servers are gone
 * and the embedded visualization is no longer live). Keeps the panel open and overlays a banner
 * rather than abruptly closing it. Does not stop Forge.
 *
 * Pass the exiting run's `runToken`: if a newer run has already taken over the panel, the tokens
 * won't match and the live panel is left untouched. A subsequent run refreshes the panel HTML,
 * which clears the overlay automatically.
 */
export function markSterlingWebviewStale(runToken?: string): void {
	if (runToken !== undefined && runToken !== activeRunToken) {
		// A newer run owns the panel now; this exit is stale. Leave the panel alone.
		return;
	}
	void sterlingPanel?.webview.postMessage({ type: 'sterling-stale' });
}

/**
 * Dispose the Sterling panel (e.g. when the Forge process exits, so the user isn't left
 * staring at a dead iframe). Does not stop Forge.
 *
 * Pass the exiting run's `runToken`: if a newer run has already taken over the panel, the
 * tokens won't match and the live panel is left untouched. Called without a token, it disposes
 * unconditionally (used on extension shutdown).
 */
export function disposeSterlingWebview(runToken?: string): void {
	if (runToken !== undefined && runToken !== activeRunToken) {
		// A newer run owns the panel now; this exit is stale. Leave the panel alone.
		return;
	}
	if (sterlingPanel) {
		disposingFromExit = true;
		try {
			sterlingPanel.dispose();
		} finally {
			sterlingPanel = undefined;
			disposingFromExit = false;
		}
	}
	activeRunToken = undefined;
}

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function getSterlingHtml(uri: vscode.Uri): string {
	const src = uri.toString(true); // skipEncoding so the `?<provider-port>` query is preserved
	const frameOrigin = `${uri.scheme}://${uri.authority}`;
	const nonce = getNonce();
	// The outer document runs one tiny nonce'd script that toggles a "stale" overlay when the
	// owning Forge run exits. The iframe is served by Forge's own static server (no CSP of its
	// own), so Sterling's scripts, the d3 CDN load, and the ws:// connection all happen inside
	// the iframe and are not restricted by this CSP.
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; frame-src ${frameOrigin} https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	html, body { margin: 0; padding: 0; height: 100%; width: 100%; }
	iframe { display: block; margin: 0; padding: 0; height: 100%; width: 100%; border: 0; }
	#stale-overlay {
		display: none;
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		font-family: var(--vscode-font-family, sans-serif);
		font-size: 13px;
		align-items: flex-start;
		justify-content: center;
		z-index: 10;
	}
	body.stale #stale-overlay { display: flex; }
	#stale-banner {
		margin-top: 0;
		width: 100%;
		box-sizing: border-box;
		padding: 10px 16px;
		text-align: center;
		background: var(--vscode-statusBarItem-warningBackground, #b8860b);
		color: var(--vscode-statusBarItem-warningForeground, #fff);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
	}
</style>
</head>
<body>
<iframe src="${src}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
<div id="stale-overlay" role="status">
	<div id="stale-banner">This Sterling session has ended — its servers are no longer running. Run the file again to launch a fresh visualization.</div>
</div>
<script nonce="${nonce}">
	window.addEventListener('message', function (event) {
		if (event.data && event.data.type === 'sterling-stale') {
			document.body.classList.add('stale');
		}
	});
</script>
</body>
</html>`;
}
