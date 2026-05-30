import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { ForgeRunner } from './forge-runner';
import { parseTestResults, stripAnsi } from './forge-test-parse';

/**
 * Native Test Explorer for Forge — a *results view*, not a per-command runner.
 *
 * Forge runs the whole `.frg` file, and the Sterling visualizer is where you navigate between the
 * file's commands. So this never runs an individual test: running anything runs the *entire file*
 * (with Sterling disabled so it doesn't block) and reports which `test expect` / `example` cases
 * passed or failed. Test items carry no source range, so no per-test "run" gutter icons appear.
 *
 *   stdout: "    Test passed: <name>"  /  "Test <name> failed."
 *   stderr: "[file:line:col (span N)] Failed test <name>. Expected X, got Y. ..."
 * Forge stops on the first failing test (test_keep=first, not overridable from the CLI), so tests
 * after the first failure are reported as skipped — matching what Forge actually did.
 */

// Subset of the server's forge/runnables response we use here.
interface ForgeRunnable {
	name: string;
	kind: 'test' | 'example' | 'command';
	detail?: string;
}

export function registerForgeTests(
	context: vscode.ExtensionContext,
	client: LanguageClient,
	forgeRunner: ForgeRunner
): void {
	const controller = vscode.tests.createTestController('forgeTests', 'Forge Tests');
	context.subscriptions.push(controller);

	const isForge = (uri: vscode.Uri) => uri.fsPath.endsWith('.frg');

	async function getRunnables(uri: vscode.Uri): Promise<ForgeRunnable[]> {
		try {
			return await client.sendRequest<ForgeRunnable[]>('forge/runnables', { uri: uri.toString() });
		} catch {
			// Server not ready yet, or request failed — leave items as-is.
			return [];
		}
	}

	/**
	 * Rebuild the test items for a single Forge document. Items deliberately carry NO source range,
	 * so VS Code shows no per-test "run" gutter icons in the editor (tests aren't individually
	 * runnable; Forge runs the whole file).
	 */
	async function refreshFile(uri: vscode.Uri): Promise<void> {
		if (!isForge(uri)) {
			return;
		}
		const runnables = await getRunnables(uri);
		const tests = runnables.filter(r => r.kind === 'test' || r.kind === 'example');

		const fileId = uri.toString();
		if (tests.length === 0) {
			controller.items.delete(fileId);
			return;
		}

		let fileItem = controller.items.get(fileId);
		if (!fileItem) {
			fileItem = controller.createTestItem(fileId, vscode.workspace.asRelativePath(uri), uri);
			controller.items.add(fileItem);
		}

		const seen = new Set<string>();
		for (const t of tests) {
			seen.add(t.name);
			let child = fileItem.children.get(t.name);
			if (!child) {
				child = controller.createTestItem(t.name, t.name, uri);
				fileItem.children.add(child);
			}
			child.description = t.detail;
		}
		const stale: string[] = [];
		fileItem.children.forEach(c => { if (!seen.has(c.id)) { stale.push(c.id); } });
		stale.forEach(id => fileItem!.children.delete(id));
	}

	const runHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> => {
		const run = controller.createTestRun(request);
		token.onCancellationRequested(() => forgeRunner.kill(true));

		// Resolve the request to whole files: running anything (a file or one of its tests) runs the
		// entire file, since that is the only granularity Forge supports.
		const fileItems: vscode.TestItem[] = [];
		const addFile = (item: vscode.TestItem) => {
			const file = item.parent ?? item;
			if (!fileItems.includes(file)) {
				fileItems.push(file);
			}
		};
		if (request.include && request.include.length > 0) {
			request.include.forEach(addFile);
		} else {
			controller.items.forEach(addFile);
		}

		for (const fileItem of fileItems) {
			if (!fileItem.uri) {
				continue;
			}
			const tests: vscode.TestItem[] = [];
			fileItem.children.forEach(c => { if (!request.exclude?.includes(c)) { tests.push(c); } });
			if (tests.length === 0) {
				continue;
			}

			tests.forEach(t => run.enqueued(t));
			if (token.isCancellationRequested) {
				tests.forEach(t => run.skipped(t));
				continue;
			}
			tests.forEach(t => run.started(t));

			const uri = fileItem.uri;
			let stdout = '';
			let stderr = '';
			try {
				// Disable Sterling so a failing test does not block waiting for the visualizer.
				await forgeRunner.runFile(uri.fsPath, {
					extraArgs: ['-O', 'run_sterling', 'off'],
					onStdout: d => { stdout += d; },
					onStderr: d => { stderr += d; },
					onExit: () => { /* results parsed below */ }
				});
			} catch (err) {
				tests.forEach(t => run.errored(t, new vscode.TestMessage(`Could not run Forge: ${err}`)));
				continue;
			}

			stdout = stripAnsi(stdout);
			stderr = stripAnsi(stderr);
			run.appendOutput(stdout.replace(/\r?\n/g, '\r\n'), undefined, fileItem);

			const results = parseTestResults(stdout, stderr);
			const anyResults = results.size > 0;

			for (const t of tests) {
				const outcome = results.get(t.id);
				if (outcome) {
					if (outcome.passed) {
						run.passed(t);
					} else {
						const msg = new vscode.TestMessage(outcome.message || 'Test failed');
						if (outcome.line !== undefined) {
							msg.location = new vscode.Location(uri, new vscode.Position(outcome.line, outcome.col ?? 0));
						}
						run.failed(t, msg);
					}
				} else if (!anyResults && stderr.trim()) {
					// Nothing parsed and Forge wrote to stderr → likely a compile error, not a result.
					run.errored(t, new vscode.TestMessage(stderr.trim().slice(0, 1000)));
				} else {
					// Forge stopped before reaching this test (test_keep=first after a failure).
					run.skipped(t);
				}
			}
		}

		run.end();
	};

	controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, runHandler, true);

	// Populate when the Testing view is first opened.
	controller.resolveHandler = async (item) => {
		if (!item) {
			await Promise.all(vscode.workspace.textDocuments.map(doc => refreshFile(doc.uri)));
		}
	};

	// Keep test items in sync with the editor.
	let debounce: ReturnType<typeof setTimeout> | undefined;
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => refreshFile(doc.uri)),
		vscode.workspace.onDidSaveTextDocument(doc => refreshFile(doc.uri)),
		vscode.workspace.onDidCloseTextDocument(doc => controller.items.delete(doc.uri.toString())),
		vscode.workspace.onDidChangeTextDocument(e => {
			if (!isForge(e.document.uri)) {
				return;
			}
			if (debounce) { clearTimeout(debounce); }
			debounce = setTimeout(() => refreshFile(e.document.uri), 500);
		})
	);

	// Initial pass over already-open documents.
	void Promise.all(vscode.workspace.textDocuments.map(doc => refreshFile(doc.uri)));
}
