import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, Diagnostic, DiagnosticSeverity, DiagnosticCollection, languages } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

import { Logger, LogLevel, Event } from "./logger";
import { ForgeRunner } from './forge-runner';
import { registerForgeChat } from './forge-chat-participant';
import { findFreePort, findSterlingPorts, waitForPort, openSterlingWebview, disposeSterlingWebview, markSterlingWebviewStale } from './sterling-webview';
import * as statusBar from './status-bar';
import { registerForgeTests } from './forge-tests';
import { CopeAndDragServer } from './copeanddrag';
import { ensureReleaseFetched } from './copeanddrag-fetch';

const os = require("os");
import { v4 as uuidv4 } from 'uuid';

let client: LanguageClient;
// Serves the release selected by `forge.copeAndDragVersion` over loopback.
// Created at activation; starts lazily on the first run that uses a release tag.
let cndServer: CopeAndDragServer | undefined;

const forgeOutput = vscode.window.createOutputChannel('Forge Output');

const forgeEvalDiagnostics = vscode.languages.createDiagnosticCollection('Forge Eval');

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function appendRunHeader(output: vscode.OutputChannel, filePath: string, runId: string): void {
	const timestamp = new Date().toLocaleTimeString();
	const fileName = path.basename(filePath);
	output.appendLine(`[forge run] ${timestamp} · ${fileName}`);
	output.appendLine('────────────────────────────────────────────────');
}

/**
 * Drive the `forge.isRunning` context key used to gate the editor-title toolbar
 * (Run shows when idle; Stop/Continue show only while a run is active).
 */
function setForgeRunning(running: boolean): void {
	vscode.commands.executeCommand('setContext', 'forge.isRunning', running);
}

/**
 * Drive the `forge.sterlingWaiting` context key — true while a run is paused waiting on the
 * Sterling visualizer, which is exactly when the "Stop Sterling & Continue" button applies.
 */
function setForgeSterlingWaiting(waiting: boolean): void {
	vscode.commands.executeCommand('setContext', 'forge.sterlingWaiting', waiting);
}


async function getUserId(context: vscode.ExtensionContext): Promise<string> {
	const UID_KEY = "FORGE_UID";

	// `secrets.get` resolves to the stored value, or `undefined` for a missing key — it does not
	// throw — so a first run is a falsy result, not an exception. (The previous code called
	// `.toString()` on the pending promise rather than its resolved value, so `uid` was always the
	// literal "[object Promise]": the same id for every user, and one that was never persisted.)
	let uid: string | undefined;
	try {
		uid = await context.secrets.get(UID_KEY);
	} catch {
		// Secret storage unavailable; fall through and mint a fresh id.
	}

	if (!uid) {
		uid = uuidv4();
		try {
			await context.secrets.store(UID_KEY, uid);
		} catch {
			// Best-effort persistence: a fresh id per session is acceptable if storage fails.
		}
	}

	forgeOutput.appendLine(`Your anonymous ID is ${uid}.`);
	return uid;
}




function subscribeToDocumentChanges(context: vscode.ExtensionContext, myDiagnostics: vscode.DiagnosticCollection): void {

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(e => myDiagnostics.delete(e.document.uri))
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => myDiagnostics.delete(doc.uri))
	);
}

// TODO: Want to make this an extension method on TextDocument, but cannot wrangle it.
function textDocumentToLog(d, focusedDoc) {
	const content = d.getText();
	const filePath = d.isUntitled ? "untitled" : d.fileName;
	const fileName = path.parse(filePath).base;
	const fileExtension = path.extname(fileName);

	// Don't log files if they do not have '.frg' extension.
	if (fileExtension !== '.frg') {
		return {};
	}

	return {
		focused: focusedDoc,
		filename: fileName,
		fileContent: content
	};
}



class ForgeErrorCodeLensProvider implements vscode.CodeLensProvider {
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	constructor(private diagnostics: vscode.DiagnosticCollection) {
		vscode.languages.onDidChangeDiagnostics((event) => {
			const hasForgeDiagnostics = event.uris.some((uri) => this.diagnostics.has(uri));
			if (hasForgeDiagnostics) {
				this._onDidChangeCodeLenses.fire();
			}
		});
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const documentDiagnostics = this.diagnostics.get(document.uri) || [];
		const errors = documentDiagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

		if (errors.length === 0) {
			return [];
		}

		const lenses: vscode.CodeLens[] = [];
		for (const err of errors) {
			lenses.push(new vscode.CodeLens(err.range, {
				title: 'Forge: Open Output',
				command: 'forge.showOutput'
			}));
			lenses.push(new vscode.CodeLens(err.range, {
				title: 'Forge: Rerun file',
				command: 'forge.runFile'
			}));
		}

		return lenses;
	}
}



export async function activate(context: ExtensionContext) {

	// Status bar reflects toolchain + run state alongside the output channel.
	statusBar.initStatusBar(context);
	statusBar.setStarting();

	// Initialize Forge runner
	const forgeRunner = ForgeRunner.getInstance(forgeOutput);
	setForgeRunning(false);

	try {
		await forgeRunner.initialize();

		const env = forgeRunner.getEnvironment();
		if (env) {
			statusBar.setEnvironmentReady(env);
		}

		// Check minimum version
		const currentSettings = vscode.workspace.getConfiguration('forge');
		const minSupportedVersion = String(currentSettings.get<string>('minVersion'));

		const meetsMinVersion = await forgeRunner.checkMinVersion(minSupportedVersion);
		if (!meetsMinVersion) {
			const choice = await vscode.window.showWarningMessage(
				`Forge version ${env?.forgeVersion} may not meet minimum requirement ${minSupportedVersion}`,
				'Open Settings', 'Forge Docs'
			);
			if (choice === 'Open Settings') {
				vscode.commands.executeCommand('workbench.action.openSettings', 'forge.minVersion');
			} else if (choice === 'Forge Docs') {
				vscode.commands.executeCommand('forge.openDocumentation');
			}
		}
	} catch (error) {
		forgeOutput.appendLine(`✗ Initialization error: ${error}`);
		statusBar.setEnvironmentMissing(String(error));
		const choice = await vscode.window.showErrorMessage(
			`Forge initialization failed: ${error}`,
			'Open Settings', 'Install Racket', 'Show Output'
		);
		if (choice === 'Open Settings') {
			vscode.commands.executeCommand('workbench.action.openSettings', 'forge.racketPath');
		} else if (choice === 'Install Racket') {
			vscode.env.openExternal(vscode.Uri.parse('https://racket-lang.org/'));
		} else if (choice === 'Show Output') {
			forgeOutput.show(true);
		}
	}

	// Fetch the configured Cope and Drag release (including the manifest's default) and serve
	// it from this loopback server, which starts lazily. An explicit empty setting uses Forge's copy.
	//
	// Placed after Forge initialization on purpose: the capability probe needs the resolved
	// Racket path, and starting it earlier would race `initialize()` into discovering the
	// toolchain twice.
	cndServer = new CopeAndDragServer(forgeOutput);
	context.subscriptions.push(cndServer);
	// Warm the ~2.5s Racket capability probe now, off the run path, so the first release-backed run
	// does not stall on it. Only matters when a release tag is selected; a later run just awaits
	// an already-settled promise.
	if (vscode.workspace.getConfiguration('forge').get<string>('copeAndDragVersion', '').trim() !== '') {
		void forgeRunner.supportsServeMode().catch(() => { /* probed again on first use */ });
	}

	// inspired by: https://github.com/GrandChris/TerminalRelativePath/blob/main/src/extension.ts
	vscode.window.registerTerminalLinkProvider({
		provideTerminalLinks: (context, token) => {

			const matcher = ForgeRunner.matchForgeError(context.line);
			if (!matcher) {
				return [];
			} else {
				const filename = matcher['fileName'];
				// verify that filename matches?
				const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
				const filePathFilename = filePath?.split(/[/\\]/).pop();
				// console.log(`${filePath}: active filename: ${filePathFilename}; filename: ${filename}`);
				if (filePathFilename !== filename) {
					// console.log("the line name is not the active filename");
					return [];
				}

				const line = matcher['linenum'];
				const col = matcher['colnum'];

				const tooltip = filePath + `:${line}:${col}`;
				return [
					{
						startIndex: matcher['index'],
						length: matcher['line'].length,
						tooltip: tooltip,
						filePath: filePath,
						line: line,
						column: col
					}
				];
			}
		},
		handleTerminalLink: (link: any) => {
			if (link.line !== undefined) {
				ForgeRunner.showFileWithOpts(link.filePath, link.line, link.column);
			} else {
				ForgeRunner.showFileWithOpts(link.filePath, null, null);
			}
		}
	});


	setForgeSterlingWaiting(false);

	const userid = await getUserId(context);
	const logger = new Logger(userid);


	const forgeDocs = vscode.commands.registerCommand('forge.openDocumentation', async () => {

		const DOCS_URL = 'https://csci1710.github.io/forge-documentation/home.html';
		vscode.env.openExternal(vscode.Uri.parse(DOCS_URL))
			.then((success) => {
				if (!success) {
					vscode.window.showErrorMessage(`Could not open Forge documentation from VS Code. It is available at ${DOCS_URL}`);
				}
			});
	});

	const showForgeOutput = vscode.commands.registerCommand('forge.showOutput', () => {
		forgeOutput.show(true);
	});

	const runFile = vscode.commands.registerCommand('forge.runFile', async () => {
		const isLoggingEnabled = vscode.workspace.getConfiguration('forge').get<boolean>('telemetry.enabled', true);
		const editor = vscode.window.activeTextEditor;

		if (!editor) {
			vscode.window.showErrorMessage(`No active text editor!`);
			return null;
		}

		const fileURI = editor?.document.uri;
		const filepath = fileURI?.fsPath;
		if (fileURI.scheme !== 'file' || !filepath.endsWith('.frg')) {
			vscode.window.showInformationMessage('Save and select a Forge (.frg) file before running it.');
			return;
		}
		const session = forgeRunner.beginRun();
		markSterlingWebviewStale();
		setForgeSterlingWaiting(false);
		const runId = uuidv4();

		const forgeSettings = vscode.workspace.getConfiguration('forge');
		const clearOutputBeforeRun = forgeSettings.get<boolean>('clearOutputBeforeRun', true);

		if (clearOutputBeforeRun) {
			forgeOutput.clear();
		}
		forgeOutput.show();
		appendRunHeader(forgeOutput, filepath, runId);

		let myStderr = '';
		let runFailed = false;
		// The progress notification is scoped to the *solve* phase, not the whole Forge process
		// lifetime (in Sterling modes the process lives on serving the visualizer while the user
		// views the instance). `endSolvePhase` dismisses the toast as soon as Sterling is serving,
		// or — for non-Sterling runs — when the process exits (the `finally` below).
		// Assigned synchronously by the Promise executor below, hence the definite-assignment `!`.
		let endSolvePhase!: () => void;
		const solvePhaseEnded = new Promise<void>((resolve) => { endSolvePhase = resolve; });
		forgeOutput.appendLine(`Running file "${filepath}" ...`);

		// If the user wants Sterling in a VS Code webview, pin the Sterling ports so we know
		// where the visualizer will live, and keep Forge from opening a browser window.
		//
		// Fetch and serve the configured Cope and Drag release, with Forge in `serve` mode (data
		// provider only). An empty setting or a failed release load uses Forge's copy in `headless` mode.
		const useWebview = forgeSettings.get<string>('openSterlingIn', 'webview') === 'webview';
		let sterlingUrl: string | undefined;
		let sterlingWebviewOpened = false;
		// Marks that *we* are serving the visualizer, which changes both the Forge args and
		// the stdout line that signals the visualizer is ready.
		let extensionServed = false;
		// The port whose "now listening" moment means the visualizer can load: in `serve`
		// mode Forge's data provider (our static server is already up); in `headless` mode
		// Forge's own static server (which it starts after the provider). Polled below as a
		// stdout-independent readiness signal.
		let readinessPort: number | undefined;
		// Flipped true when the Forge process is gone, so the readiness poll stops chasing it.
		let processExited = false;
		const prepare = async (): Promise<string[] | undefined> => {
			let extraArgs: string[] | undefined;
			if (useWebview) {
				let cndStaticPort: number | undefined;
				const desiredVersion = forgeSettings.get<string>('copeAndDragVersion', '').trim();
				// Serve our own Cope and Drag only when a release tag is selected AND the
				// installed Forge supports `serve` mode. Otherwise Forge serves its own copy (headless).
				if (desiredVersion !== '' && cndServer && await forgeRunner.supportsServeMode()) {
					if (!session.isCurrent || session.isCancelled) { return; }
					try {
						const bundleDir = await vscode.window.withProgress(
							{
								location: vscode.ProgressLocation.Notification,
								title: `Loading Cope and Drag ${desiredVersion}…`
							},
							() => ensureReleaseFetched(desiredVersion, context.globalStorageUri.fsPath, forgeOutput)
						);
						if (!session.isCurrent || session.isCancelled) { return; }
						cndStaticPort = await cndServer.ensureStarted(bundleDir);
					} catch (err) {
						if (!session.isCurrent || session.isCancelled) { return; }
						// Surface a failed release load and fall back to Forge's own copy.
						forgeOutput.appendLine(`! Could not use Cope and Drag ${desiredVersion} (${err}); using Forge's copy.`);
						void vscode.window.showWarningMessage(
							`Could not load Cope and Drag ${desiredVersion}; falling back to the version shipped with Forge.`
						);
						cndStaticPort = undefined;
					}
				}
				if (!session.isCurrent || session.isCancelled) { return; }

				if (cndStaticPort !== undefined) {
					const providerPort = await findFreePort();
					extraArgs = [
						'-O', 'run_sterling', 'serve',
						'-O', 'sterling_port', String(providerPort),
					];
					sterlingUrl = `http://127.0.0.1:${cndStaticPort}/?${providerPort}`;
					extensionServed = true;
					readinessPort = providerPort;
				} else {
					const { staticPort, providerPort } = await findSterlingPorts();
					extraArgs = [
						'-O', 'run_sterling', 'headless',
						'-O', 'sterling_static_port', String(staticPort),
						'-O', 'sterling_port', String(providerPort),
					];
					sterlingUrl = `http://127.0.0.1:${staticPort}/?${providerPort}`;
					readinessPort = staticPort;
				}
			}
			return extraArgs;
		};

		// Open the Sterling panel exactly once, from whichever readiness signal wins the race:
		// the Forge log line (fast path, below) or the port poll (robust path, further down).
		const openSterlingOnce = () => {
			if (!session.isCurrent || session.isCancelled || processExited || !useWebview || !sterlingUrl || sterlingWebviewOpened) {
				return;
			}
			sterlingWebviewOpened = true;
			setForgeSterlingWaiting(true);
			endSolvePhase();
			void openSterlingWebview(sterlingUrl, forgeRunner, runId, () => session.isCurrent && !session.isCancelled && !processExited);
		};

		const stdoutListener = (data: string) => {
			const lines = stripAnsi(data.toString()).split(/[\n]/);
			for (const line of lines) {
				// Fast path for opening the panel: the line Forge prints once the visualizer can
				// load. In `serve` mode that is the data provider ("provider at:"); in `headless`
				// mode Forge's own static server ("static server port=N"). This only races the
				// port poll below — if Forge ever rewords the line, the poll still opens the panel.
				const readyMarker = extensionServed ? 'provider at:' : 'static server port=';
				if (line.includes(readyMarker)) {
					openSterlingOnce();
				}
				if (line === 'Sterling running. Hit enter to stop service.') {
					setForgeSterlingWaiting(true);
					// Sterling is serving (browser mode reaches here without the line above); the
					// solve is over, so dismiss the toast and let the status bar + toolbar carry
					// the live-session state for as long as the user views the instance.
					endSolvePhase();
					forgeOutput.appendLine('Sterling running. Click "Stop Sterling & Continue" (or close the panel) to finish.');
				} else {
					forgeOutput.appendLine(line);
				}
			}
		};

		const stderrListener = (data: string) => {
			myStderr += data;
		};

		const exitListener = (code: number | null) => {
			processExited = true;
			runFailed = code !== 0 && !session.isCancelled;
			setForgeSterlingWaiting(false);
			// Forge's data provider dies with the process, so the visualization is no longer live
			// (in `headless` mode Forge's static server goes too; in `serve` mode ours stays up,
			// but a page with no provider is just as dead). Mark the webview stale so the user
			// sees a banner instead of a silently-broken iframe — but only if this run still owns
			// the panel. A newer run may have already taken it over (it picks a fresh provider
			// port), in which case this stale exit must leave the live panel alone.
			if (useWebview) {
				markSterlingWebviewStale(runId);
			}
			if (!session.isCancelled) {
				if (myStderr !== '') {
					forgeRunner.sendEvalErrors(myStderr, fileURI, forgeEvalDiagnostics);
				} else {
					ForgeRunner.showFileWithOpts(filepath, null, null);
					forgeOutput.appendLine(runFailed ? `Forge exited unsuccessfully (code ${code}).` : 'Finished running.');
				}
			} else {
				ForgeRunner.showFileWithOpts(filepath, null, null);
				forgeOutput.appendLine('Forge process terminated.');
			}

			// Log run result
			const payload = {
				"output-errors": myStderr,
				"runId": runId
			};
			logger.log_payload(payload, LogLevel.INFO, Event.FORGE_RUN_RESULT);
		};

		// Reflect run state in the toolbar (context key) and status bar.
		setForgeRunning(true);
		statusBar.setRunning(path.basename(filepath));

		// A cancelable progress notification covers the solve only (see `solvePhaseEnded`): its
		// Cancel button stops the run the same way the Stop button does, and it dismisses itself as
		// soon as Sterling is serving — handing the live session off to the status bar + the
		// "Stop Sterling & Continue" toolbar. Fire-and-forget: the run is awaited separately below
		// and lives until the process actually exits.
		void vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Forge: running ${path.basename(filepath)}`,
			cancellable: true
		}, async (_progress, token) => {
			const cancellation = token.onCancellationRequested(() => {
				session.cancel();
				endSolvePhase();
			});
			try {
				await solvePhaseEnded;
			} finally {
				cancellation.dispose();
			}
		});

		// Robust readiness: open the panel when the visualizer's server is actually listening,
		// independent of what Forge prints. This is what makes a reworded Forge log line
		// harmless — the port coming up still opens the panel. A slow solve just brings the port
		// up later; the poll waits it out rather than reporting a false failure.
		const onStart = () => {
			if (useWebview && readinessPort !== undefined) {
				void waitForPort(readinessPort, () => session.isCurrent && !session.isCancelled && !processExited).then((up) => {
					if (up) {
						openSterlingOnce();
					}
				});
			}
		};

		try {
			await forgeRunner.runFile(filepath, {
				onStdout: stdoutListener,
				onStderr: stderrListener,
				onExit: exitListener,
				prepare,
				onStart
			}, session);

			if (session.isCurrent && !session.isCancelled && isLoggingEnabled && editor) {
				const documentData = vscode.workspace.textDocuments.map((d) => {
					const focusedDoc = (d === editor.document);
					return textDocumentToLog(d, focusedDoc);
				}).filter((data) => Object.keys(data).length > 0);

				documentData['runId'] = runId;
				logger.log_payload(documentData, LogLevel.INFO, Event.FORGE_RUN);
			}
		} catch (error) {
			if (!session.isCurrent || session.isCancelled) { return; }
			runFailed = true;
			const log = textDocumentToLog(editor.document, true);
			log['error'] = `Could not run Forge process: ${error}`;
			log['runId'] = runId;

			logger.log_payload(log, LogLevel.ERROR, Event.FORGE_RUN);
			console.error("Could not run Forge process:", error);
			const choice = await vscode.window.showErrorMessage(
				`Could not run Forge process: ${error}`,
				'Show Output'
			);
			if (choice === 'Show Output') {
				forgeOutput.show(true);
			}
		} finally {
			// Whatever happened — Sterling served, clean exit, or error — ensure the solve-phase
			// toast is dismissed. It must never outlive the run.
			endSolvePhase();
			// If the process failed to spawn, `exit` never fired; stop the readiness poll here.
			processExited = true;

			// Run finished (normally, by error, or by Stop/Cancel): clear state, reflect outcome.
			if (session.isCurrent) {
				setForgeRunning(false);
				setForgeSterlingWaiting(false);
				if (session.isCancelled) {
					statusBar.setRunResult('stopped');
				} else if (runFailed || myStderr.trim() !== '') {
					statusBar.setRunResult('errors');
				} else {
					statusBar.setRunResult('ok');
				}
			}
		}
	});

	const stopRun = vscode.commands.registerCommand('forge.stopRun', () => {
		forgeRunner.kill();
	});

	const continueRun = vscode.commands.registerCommand('forge.continueRun', () => {
		if (!forgeRunner.sendInput('\n')) {
			vscode.window.showErrorMessage('No active Forge process to continue.');
		}
		setForgeSterlingWaiting(false);
	});


	const enableLogging = vscode.commands.registerCommand('forge.enableLogging', async () => {
		await vscode.workspace.getConfiguration('forge').update('telemetry.enabled', true, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage('Forge telemetry enabled.');
	});

	const disableLogging = vscode.commands.registerCommand('forge.disableLogging', async () => {
		await vscode.workspace.getConfiguration('forge').update('telemetry.enabled', false, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage('Forge telemetry disabled.');
	});

	// Quick chooser for the `forge.openSterlingIn` setting so the visualizer target can be switched
	// from a keybinding / the Command Palette without digging through Settings. Writes the user-level
	// (Global) setting; a workspace override, if any, still wins for that workspace.
	const chooseSterlingTarget = vscode.commands.registerCommand('forge.chooseSterlingTarget', async () => {
		const config = vscode.workspace.getConfiguration('forge');
		const current = config.get<string>('openSterlingIn', 'webview');
		const items: (vscode.QuickPickItem & { value: 'webview' | 'browser' })[] = [
			{
				value: 'webview',
				label: '$(window) VS Code panel',
				description: current === 'webview' ? '$(check) current' : undefined,
				detail: "Show Cope and Drag in a VS Code webview, using the copy bundled with this extension. No browser window opens."
			},
			{
				value: 'browser',
				label: '$(globe) System web browser',
				description: current === 'browser' ? '$(check) current' : undefined,
				detail: "Open Sterling in your system's default web browser, using the Cope and Drag bundled with Forge."
			}
		];
		const pick = await vscode.window.showQuickPick(items, {
			title: 'Where should Sterling open?',
			placeHolder: 'Choose where the Sterling visualizer opens when a run produces an instance'
		});
		if (!pick || pick.value === current) {
			return;
		}
		await config.update('openSterlingIn', pick.value, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Sterling will now open in ${pick.value === 'webview' ? 'a VS Code panel' : 'your web browser'}.`
		);
	});

	// Jump straight to this extension's settings (Settings UI filtered to the Forge contributions).
	const openSettings = vscode.commands.registerCommand('forge.openSettings', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', '@ext:SiddharthaPrasad.forge-fm');
	});


	context.subscriptions.push(runFile, stopRun, continueRun, enableLogging, disableLogging, chooseSterlingTarget,
		openSettings, forgeEvalDiagnostics, forgeOutput, forgeDocs, showForgeOutput);

	// Register @forge chat participant (requires GitHub Copilot)
	registerForgeChat(context);

	const codeLensProvider = new ForgeErrorCodeLensProvider(forgeEvalDiagnostics);
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'forge', scheme: 'file' }, codeLensProvider)
	);

	subscribeToDocumentChanges(context, forgeEvalDiagnostics);

	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);
	// The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'forge' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'forgeLanguageServer',
		'Forge Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server. Guard so that a language-server
	// failure does not also disable run/Sterling/status features.
	try {
		await client.start();
		console.log('Client and Server launched');

		// Native Test Explorer (results view), backed by the server's forge/runnables request.
		registerForgeTests(context, client, forgeRunner);
	} catch (err) {
		console.error('Forge language server failed to start:', err);
	}
}

export function deactivate(): Thenable<void> | undefined {
	const forgeRunner = ForgeRunner.getInstance(forgeOutput);
	forgeRunner.kill();
	// Close the Sterling panel outright on shutdown (no token: unconditional).
	disposeSterlingWebview();

	if (!client) {
		return undefined;
	}

	return client.stop();
}
