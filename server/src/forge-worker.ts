import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { CancellationToken } from 'vscode-languageserver/node';
import { discoverRacket } from './racket-path';

export type DiagSeverity = 'error' | 'warning';

export interface WorkerDiagnostic {
	line: number;     // 1-indexed
	column: number;   // 0-indexed
	position: number; // 1-indexed byte position
	span: number;     // >= 1
	severity: DiagSeverity;
	message: string;
}

type Pending = {
	resolve: (diags: WorkerDiagnostic[]) => void;
	reject: (err: Error) => void;
};

const WORKER_RKT = path.resolve(__dirname, '../src/forge_worker.rkt');

export class ForgeWorker {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private ready: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((err: Error) => void) | null = null;
	private stdoutBuf = '';
	private restartAttempts = 0;
	private disposed = false;
	private log: (msg: string) => void;

	constructor(private racketPath: string, log?: (msg: string) => void) {
		this.log = log ?? (() => { /* noop */ });
	}

	static async create(configuredRacketPath: string | undefined, log?: (msg: string) => void): Promise<ForgeWorker> {
		const racket = discoverRacket(configuredRacketPath);
		if (!racket) {
			throw new Error('Racket not found. Install Racket or set "forge.racketPath".');
		}
		const w = new ForgeWorker(racket, log);
		await w.start();
		return w;
	}

	private start(): Promise<void> {
		this.ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});

		this.proc = spawn(this.racketPath, [WORKER_RKT], {
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.proc.stdout.setEncoding('utf-8');
		this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		this.proc.stderr.setEncoding('utf-8');
		this.proc.stderr.on('data', (chunk: string) => this.log(`[forge_worker stderr] ${chunk.trimEnd()}`));

		this.proc.on('exit', (code, signal) => {
			this.log(`[forge_worker exit] code=${code} signal=${signal}`);
			this.handleExit();
		});
		this.proc.on('error', (err) => {
			this.log(`[forge_worker error] ${err.message}`);
			if (this.readyReject) this.readyReject(err);
		});

		// Readiness probe.
		this.send('(ping 0)');
		return this.ready;
	}

	private handleExit(): void {
		const pending = this.pending;
		this.pending = new Map();
		for (const { reject } of pending.values()) {
			reject(new Error('Forge worker exited'));
		}
		this.proc = null;

		if (this.disposed) return;
		if (this.restartAttempts >= 5) {
			this.log('[forge_worker] giving up after 5 restart attempts');
			return;
		}
		const delay = Math.min(4000, 250 * 2 ** this.restartAttempts);
		this.restartAttempts += 1;
		setTimeout(() => {
			if (this.disposed) return;
			this.log(`[forge_worker] restarting (attempt ${this.restartAttempts})`);
			this.start().catch((err) => this.log(`[forge_worker] restart failed: ${err.message}`));
		}, delay);
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl: number;
		while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
			const line = this.stdoutBuf.slice(0, nl).trim();
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (line.length === 0) continue;
			this.handleMessage(line);
		}
	}

	private handleMessage(line: string): void {
		const msg = parseSexp(line);
		if (!Array.isArray(msg) || msg.length === 0) {
			this.log(`[forge_worker] unparseable line: ${line}`);
			return;
		}
		const head = msg[0];
		if (head === 'pong') {
			if (this.readyResolve) {
				this.restartAttempts = 0;
				this.readyResolve();
				this.readyResolve = null;
				this.readyReject = null;
			}
			return;
		}
		if (head === 'ok') {
			const id = msg[1] as number;
			const p = this.pending.get(id);
			if (p) {
				this.pending.delete(id);
				p.resolve([]);
			}
			return;
		}
		if (head === 'error') {
			const id = msg[1] as number;
			const rawDiags = (msg[2] as unknown[]) ?? [];
			const diags: WorkerDiagnostic[] = [];
			for (const d of rawDiags) {
				if (!Array.isArray(d) || d.length < 6) continue;
				diags.push({
					line: Number(d[0]) || 1,
					column: Number(d[1]) || 0,
					position: Number(d[2]) || 1,
					span: Math.max(1, Number(d[3]) || 1),
					severity: (d[4] === 'warning' ? 'warning' : 'error'),
					message: String(d[5] ?? ''),
				});
			}
			const p = this.pending.get(id);
			if (p) {
				this.pending.delete(id);
				p.resolve(diags);
			}
			return;
		}
		this.log(`[forge_worker] unknown reply: ${line}`);
	}

	private send(line: string, payload?: Buffer): void {
		if (!this.proc) return;
		this.proc.stdin.write(line + '\n');
		if (payload) this.proc.stdin.write(payload);
	}

	async check(text: string, token?: CancellationToken): Promise<WorkerDiagnostic[]> {
		if (this.ready) await this.ready;
		if (!this.proc) return [];
		if (token?.isCancellationRequested) return [];

		const id = this.nextId++;
		const payload = Buffer.from(text, 'utf-8');
		const p = new Promise<WorkerDiagnostic[]>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});

		token?.onCancellationRequested(() => {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			this.send(`(cancel ${id})`);
			pending.resolve([]);
		});

		this.send(`(check ${id} ${payload.byteLength})`, payload);
		return p;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const p = this.proc;
		if (!p) return;
		try {
			p.stdin.write('(shutdown)\n');
			p.stdin.end();
		} catch {
			/* proc may already be dead */
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try { p.kill('SIGTERM'); } catch { /* ignore */ }
				const kt = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 1000);
				p.once('exit', () => { clearTimeout(kt); resolve(); });
			}, 2000);
			p.once('exit', () => { clearTimeout(timer); resolve(); });
		});
	}
}

// --- Minimal s-expression parser for worker replies ---
// Supports: numbers, symbols, strings (with \\ and \" escapes), nested lists.
// Good enough for the fixed reply shapes emitted by forge_worker.rkt.

function parseSexp(s: string): unknown {
	const p = { s, i: 0 };
	skipWs(p);
	const v = readValue(p);
	return v;
}

function skipWs(p: { s: string; i: number }): void {
	while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
}

function readValue(p: { s: string; i: number }): unknown {
	skipWs(p);
	if (p.i >= p.s.length) return null;
	const c = p.s[p.i];
	if (c === '(') return readList(p);
	if (c === '"') return readString(p);
	return readAtom(p);
}

function readList(p: { s: string; i: number }): unknown[] {
	p.i++; // consume '('
	const out: unknown[] = [];
	while (true) {
		skipWs(p);
		if (p.i >= p.s.length) break;
		if (p.s[p.i] === ')') { p.i++; break; }
		out.push(readValue(p));
	}
	return out;
}

function readString(p: { s: string; i: number }): string {
	p.i++; // opening "
	let out = '';
	while (p.i < p.s.length) {
		const c = p.s[p.i++];
		if (c === '"') return out;
		if (c === '\\' && p.i < p.s.length) {
			const n = p.s[p.i++];
			if (n === 'n') out += '\n';
			else if (n === 't') out += '\t';
			else if (n === 'r') out += '\r';
			else out += n;
		} else {
			out += c;
		}
	}
	return out;
}

function readAtom(p: { s: string; i: number }): string | number {
	let start = p.i;
	while (p.i < p.s.length && !/[\s()"]/.test(p.s[p.i])) p.i++;
	const tok = p.s.slice(start, p.i);
	if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
	return tok;
}
