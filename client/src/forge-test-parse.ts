/**
 * Pure (vscode-free) parsing of Forge's run output into per-test outcomes.
 *
 * Kept separate from forge-tests.ts so it can be unit-tested in plain Node. Forge prints:
 *   stdout: "    Test passed: <name>"  /  "Test <name> failed."
 *   stderr: "[file:line:col (span N)] Failed test <name>. Expected X, got Y. Found instance ..."
 */

export interface TestOutcome {
	passed: boolean;
	message?: string;
	/** 0-based failure location, when reported on stderr. */
	line?: number;
	col?: number;
}

export function stripAnsi(text: string): string {
	// ESC (0x1b) + CSI color code. Built dynamically so no control character sits in the source
	// (keeps the file lint-clean under no-control-regex while still stripping real ANSI codes).
	return text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
}

export function parseTestResults(stdout: string, stderr: string): Map<string, TestOutcome> {
	const results = new Map<string, TestOutcome>();
	let m: RegExpExecArray | null;

	const passRe = /Test passed:\s*(\S+)/g;
	while ((m = passRe.exec(stdout)) !== null) {
		results.set(m[1], { passed: true });
	}

	const failRe = /Test (\S+) failed\b/g;
	while ((m = failRe.exec(stdout)) !== null) {
		results.set(m[1], { ...(results.get(m[1]) ?? {}), passed: false });
	}

	// Failure location + reason on stderr (same shape matched by ForgeRunner.matchForgeError).
	const stderrRe = /\[[^\]\n]*?\.frg:(\d+):(\d+) \(span \d+\)\]\s*Failed test (\S+)\.\s*([^\n]*)/g;
	while ((m = stderrRe.exec(stderr)) !== null) {
		const name = m[3];
		const reason = m[4].split('Found instance')[0].trim();
		results.set(name, {
			passed: false,
			line: Math.max(0, parseInt(m[1], 10) - 1),
			col: Math.max(0, parseInt(m[2], 10) - 1),
			message: reason || 'Test failed'
		});
	}

	return results;
}
