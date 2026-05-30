import * as vscode from 'vscode';
import { ForgeEnvironment } from './forge-runner';

/**
 * A single status-bar item that reflects the Forge toolchain state and the most recent run.
 *
 * This sits *alongside* the "Forge Output" channel (it does not replace it): clicking the item
 * reveals the output. It carries a "base" state (the discovered environment, shown when idle) and
 * a transient run state (spinner while running, then the run outcome).
 */

let statusItem: vscode.StatusBarItem | undefined;

// The idle/base presentation, restored implicitly by the next environment update. Run outcomes
// overwrite the text until the following run starts.
let baseText = '$(beaker) Forge';
let baseTooltip = 'Forge';

export function initStatusBar(context: vscode.ExtensionContext): void {
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	// Clicking the item reveals the Forge Output channel.
	statusItem.command = 'forge.showOutput';
	context.subscriptions.push(statusItem);
	statusItem.show();
}

/** Shown while we discover Racket/Forge at activation. */
export function setStarting(): void {
	if (!statusItem) {
		return;
	}
	statusItem.text = '$(sync~spin) Forge: starting…';
	statusItem.tooltip = 'Discovering Racket and Forge…';
	statusItem.backgroundColor = undefined;
	statusItem.show();
}

/** Reflect a healthy, discovered environment (called after a successful initialize). */
export function setEnvironmentReady(env: ForgeEnvironment): void {
	const v = env.forgeVersion;
	const hasVersion = v && v !== 'installed' && v !== 'unknown';
	baseText = hasVersion ? `$(check) Forge ${v}` : '$(check) Forge';
	baseTooltip = `${hasVersion ? `Forge ${v}` : 'Forge ready'}\nRacket: ${env.racketPath}\nClick to show Forge output`;
	showBase();
}

/** Reflect a missing/broken environment so it is not buried in a one-shot toast. */
export function setEnvironmentMissing(message: string): void {
	baseText = '$(error) Forge: not found';
	baseTooltip = `${message}\nClick to show Forge output`;
	showBase(new vscode.ThemeColor('statusBarItem.errorBackground'));
}

function showBase(background?: vscode.ThemeColor): void {
	if (!statusItem) {
		return;
	}
	statusItem.text = baseText;
	statusItem.tooltip = baseTooltip;
	statusItem.backgroundColor = background;
	statusItem.show();
}

/** Spinner shown for the duration of a run. */
export function setRunning(fileName: string): void {
	if (!statusItem) {
		return;
	}
	statusItem.text = `$(sync~spin) Forge: running ${fileName}…`;
	statusItem.tooltip = 'Forge run in progress — click to show output';
	statusItem.backgroundColor = undefined;
	statusItem.show();
}

/** Outcome of a finished run; persists until the next run starts. */
export function setRunResult(outcome: 'ok' | 'errors' | 'stopped'): void {
	if (!statusItem) {
		return;
	}
	switch (outcome) {
		case 'errors':
			statusItem.text = '$(error) Forge: errors';
			statusItem.tooltip = 'Forge run reported errors — click to show output';
			statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			break;
		case 'stopped':
			statusItem.text = '$(circle-slash) Forge: stopped';
			statusItem.tooltip = 'Forge run was stopped — click to show output';
			statusItem.backgroundColor = undefined;
			break;
		default:
			statusItem.text = '$(pass) Forge: done';
			statusItem.tooltip = 'Forge run finished — click to show output';
			statusItem.backgroundColor = undefined;
	}
	statusItem.show();
}
