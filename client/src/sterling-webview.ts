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
 */
export async function openSterlingWebview(rawUrl: string, forgeRunner: ForgeRunner): Promise<void> {
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
		'Sterling',
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true }
	);
	sterlingPanel.webview.html = html;

	sterlingPanel.onDidDispose(() => {
		sterlingPanel = undefined;
		if (!disposingFromExit) {
			// User closed the panel: stop the Forge run the same way the "Continue" button does.
			forgeRunner.sendInput('\n');
		}
	});
}

/**
 * Dispose the Sterling panel (e.g. when the Forge process exits, so the user isn't left
 * staring at a dead iframe). Does not stop Forge.
 */
export function disposeSterlingWebview(): void {
	if (sterlingPanel) {
		disposingFromExit = true;
		try {
			sterlingPanel.dispose();
		} finally {
			sterlingPanel = undefined;
			disposingFromExit = false;
		}
	}
}

function getSterlingHtml(uri: vscode.Uri): string {
	const src = uri.toString(true); // skipEncoding so the `?<provider-port>` query is preserved
	const frameOrigin = `${uri.scheme}://${uri.authority}`;
	// The outer document runs no scripts; it only needs frame-src to embed the iframe.
	// The iframe is served by Forge's own static server (no CSP of its own), so Sterling's
	// scripts, the d3 CDN load, and the ws:// connection all happen inside the iframe and are
	// not restricted by this CSP.
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; frame-src ${frameOrigin} https:; style-src 'unsafe-inline';" />
<style>
	html, body, iframe { margin: 0; padding: 0; height: 100%; width: 100%; border: 0; }
</style>
</head>
<body>
<iframe src="${src}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
</body>
</html>`;
}
