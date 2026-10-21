const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const ts = require('typescript');

// Exercise the actual command, Test Explorer and runner together. Only the VS Code
// host and Racket process are replaced, so save and process races are deterministic.
function loadSource(name, mocks) {
    const root = process.env.FORGE_RUN_FLOW_SOURCE_ROOT || path.resolve(__dirname, '../../client/src');
    const filename = path.join(root, name + '.ts');
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText;
    const module = { exports: {} };
    const fallback = createRequire(path.resolve(__dirname, '../../client/src/extension.ts'));
    const factory = vm.runInThisContext(`(function(require, module, exports, __dirname, console) {${source}\n})`, { filename });
    factory(id => Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : fallback(id),
        module, module.exports, path.dirname(filename), { log() {}, error() {} });
    return module.exports;
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const disposable = () => ({ dispose() {} });
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function cancellationToken() {
    const listeners = new Set();
    return {
        isCancellationRequested: false,
        onCancellationRequested(fn) {
            listeners.add(fn);
            return { dispose: () => listeners.delete(fn) };
        },
        cancel() {
            this.isCancellationRequested = true;
            for (const fn of listeners) { fn(); }
        },
        get listenerCount() { return listeners.size; }
    };
}
function collection(parent) {
    const items = new Map();
    items.add = item => { item.parent = parent; items.set(item.id, item); };
    return items;
}

const harnesses = [];
async function harness() {
    const commands = new Map();
    const contexts = new Map();
    const documents = [];
    const children = [];
    const progress = [];
    const errors = [];
    const results = [];
    const output = { lines: [], appendLine(line) { this.lines.push(line); }, clear() { this.lines = []; }, show() {}, dispose() {} };
    const settings = { racketPath: '/fake/racket', minVersion: '3.3.0', openSterlingIn: 'browser', copeAndDragVersion: '', 'telemetry.enabled': false };
    const state = {};
    const status = {
        initStatusBar() {}, setStarting() {}, setEnvironmentReady() {}, setEnvironmentMissing() {},
        setRunning(file) { state.status = `running:${file}`; },
        setRunResult(outcome) { state.status = outcome; }
    };
    const uri = file => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
    const controller = {
        items: collection(),
        createTestItem(id, label, uri) {
            const item = { id, label, uri };
            item.children = collection(item);
            return item;
        },
        createRunProfile(_name, _kind, handler) { this.run = handler; },
        createTestRun() {
            const run = { events: [], end() { this.ended = true; }, appendOutput() {} };
            for (const outcome of ['enqueued', 'started', 'passed', 'failed', 'skipped', 'errored']) {
                run[outcome] = (item, message) => run.events.push({ outcome, item: item.id, message: message?.message });
            }
            results.push(run);
            return run;
        },
        dispose() {}
    };
    const vscode = {
        Uri: { file: uri, parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), authority: new URL(value).host, toString: () => value }) },
        EventEmitter: class { event = disposable; fire() {} },
        ProgressLocation: { Notification: 1 }, TestRunProfileKind: { Run: 1 },
        TestMessage: class { constructor(message) { this.message = message; } },
        window: {
            createOutputChannel: () => output,
            registerTerminalLinkProvider: disposable,
            showErrorMessage: async message => { errors.push(message); },
            showInformationMessage: async () => {},
            showWarningMessage: async () => {},
            withProgress: (_options, callback) => {
                const token = cancellationToken();
                progress.push(token);
                return callback({}, token);
            }
        },
        workspace: {
            textDocuments: documents,
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
            openTextDocument: async uri => {
                const doc = documents.find(doc => doc.uri.fsPath === uri.fsPath);
                assert.ok(doc, `Missing document ${uri.fsPath}`);
                return doc;
            },
            asRelativePath: uri => uri.fsPath,
            createFileSystemWatcher: disposable,
            onDidOpenTextDocument: disposable, onDidSaveTextDocument: disposable,
            onDidCloseTextDocument: disposable, onDidChangeTextDocument: disposable
        },
        commands: {
            registerCommand: (name, handler) => { commands.set(name, handler); return disposable(); },
            executeCommand: async (name, ...args) => {
                if (name === 'setContext') { contexts.set(args[0], args[1]); }
                else { return commands.get(name)?.(...args); }
            }
        },
        languages: {
            createDiagnosticCollection: () => new Map(),
            onDidChangeDiagnostics: disposable, registerCodeLensProvider: disposable
        },
        tests: { createTestController: () => controller }
    };
    const childProcess = {
        execSync: command => command.includes('--version') ? 'Welcome to Racket' : '5.0.0',
        spawn: (_program, args) => {
            const child = new EventEmitter();
            child.args = args;
            child.savedText = documents.find(doc => doc.uri.fsPath === args[0]).savedText;
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            child.stdin = { write: () => true };
            child.exitCode = null; child.signalCode = null;
            child.signals = [];
            child.kill = signal => { child.signals.push(signal); return true; };
            child.close = (code = 0) => { child.exitCode = code; child.emit('close', code); };
            children.push(child);
            return child;
        }
    };
    const runnerModule = loadSource('forge-runner', { vscode, child_process: childProcess, fs: { existsSync: () => true } });
    const runner = runnerModule.ForgeRunner.getInstance(output);
    const sterling = {
        markSterlingWebviewStale() {}, disposeSterlingWebview() {}, openSterlingWebview: async () => {},
        findSterlingPorts: async () => ({ staticPort: 1234, providerPort: 1235 }), waitForPort: async () => false
    };
    const shared = { vscode, './forge-runner': runnerModule, './status-bar': status, './sterling-webview': sterling };
    const tests = loadSource('forge-tests', { ...shared, './forge-test-parse': loadSource('forge-test-parse', {}) });
    const extension = loadSource('extension', {
        ...shared, './forge-tests': tests,
        'vscode-languageclient/node': {
            TransportKind: { ipc: 1 },
            LanguageClient: class {
                async start() {}
                async sendRequest() { return [{ name: 'sample', kind: 'test' }]; }
            }
        },
        './logger': { Logger: class { log_payload() {} }, LogLevel: {}, Event: {} },
        './forge-chat-participant': { registerForgeChat() {} },
        './copeanddrag': { CopeAndDragServer: class {} },
        './copeanddrag-fetch': {}
    });
    await extension.activate({
        subscriptions: [], asAbsolutePath: value => value,
        secrets: { get: async () => 'test-user' }
    });
    const h = {
        runner, children, output, contexts, state, errors, results, progress, settings, controller, sterling, vscode,
        run: () => commands.get('forge.runFile')(),
        stop: () => commands.get('forge.stopRun')(),
        document(file = '/models/model.frg', saveGate) {
            const doc = {
                uri: uri(file), fileName: file, isDirty: true, isUntitled: false,
                savedText: 'old model', text: 'new model', saveCalls: 0,
                getText() { return this.text; },
                async save() {
                    this.saveCalls++;
                    const saved = saveGate ? await saveGate.promise : true;
                    if (saved) { this.savedText = this.text; this.isDirty = false; }
                    return saved;
                }
            };
            documents.push(doc);
            vscode.window.activeTextEditor = { document: doc };
            return doc;
        }
    };
    harnesses.push(h);
    return h;
}

suite('Forge run flow', () => {
    teardown(() => {
        for (const h of harnesses.splice(0)) {
            h.runner.reset();
            h.children.forEach(child => child.close());
        }
    });

    test('Run waits for saving and executes the saved editor contents', async () => {
        const h = await harness();
        const save = deferred();
        h.document(undefined, save);
        const run = h.run();
        await tick();
        assert.equal(h.children.length, 0);
        save.resolve(true);
        await tick();
        assert.equal(h.children[0].savedText, 'new model');
        h.children[0].close();
        await run;
        assert.equal(h.state.status, 'ok');
    });

    for (const rejects of [false, true]) {
        test(`Run aborts when saving ${rejects ? 'rejects' : 'returns false'}`, async () => {
            const h = await harness();
            const save = deferred();
            h.document(undefined, save);
            const run = h.run();
            await tick();
            if (rejects) { save.reject(new Error('disk full')); } else { save.resolve(false); }
            await run;
            assert.equal(h.children.length, 0);
            assert.equal(h.errors.length, 1);
            assert.equal(h.state.status, 'errors');
            assert.equal(h.contexts.get('forge.isRunning'), false);
        });
    }

    test('Run does not save or execute a non-Forge file', async () => {
        const h = await harness();
        const doc = h.document('/models/notes.txt');
        await h.run();
        assert.equal(doc.saveCalls, 0);
        assert.equal(h.children.length, 0);
    });

    test('Stop while saving prevents a delayed process launch', async () => {
        const h = await harness();
        const save = deferred();
        h.document(undefined, save);
        const run = h.run();
        await tick();
        h.stop();
        save.resolve(true);
        await run;
        assert.equal(h.children.length, 0);
        assert.equal(h.state.status, 'stopped');
    });

    test('A slower earlier save cannot replace a newer run', async () => {
        const h = await harness();
        const save = deferred();
        h.document('/models/first.frg', save);
        const first = h.run();
        await tick();
        h.document('/models/second.frg');
        const second = h.run();
        await tick();
        save.resolve(true);
        await first;
        assert.equal(h.children.length, 1);
        assert.equal(h.children[0].args[0], '/models/second.frg');
        assert.equal(h.contexts.get('forge.isRunning'), true);
        assert.equal(h.state.status, 'running:second.frg');
        h.children[0].close();
        await second;
    });

    test('Old process output, completion and Cancel cannot affect the current run', async () => {
        const h = await harness();
        h.document('/models/first.frg');
        const first = h.run();
        await tick();
        h.document('/models/second.frg');
        const second = h.run();
        await tick();
        h.progress[0].cancel();
        h.children[0].stdout.emit('data', Buffer.from('obsolete output'));
        h.children[0].close(1);
        await first;
        assert.deepEqual(h.children[1].signals, []);
        assert.ok(!h.output.lines.includes('obsolete output'));
        assert.equal(h.contexts.get('forge.isRunning'), true);
        assert.equal(h.state.status, 'running:second.frg');
        h.children[1].close();
        await second;
        assert.equal(h.progress[0].listenerCount, 0);
    });

    test('Run retains output arriving after exit and before stream close', async () => {
        const h = await harness();
        h.document();
        const run = h.run();
        await tick();
        h.children[0].emit('exit', 0);
        assert.equal(h.contexts.get('forge.isRunning'), true);
        h.children[0].stdout.emit('data', Buffer.from('final output'));
        h.children[0].close();
        await run;
        assert.ok(h.output.lines.includes('final output'));
        assert.equal(h.runner.sendInput('\n'), false);
    });

    test('Run reports a nonzero exit even when stderr is empty', async () => {
        const h = await harness();
        h.document();
        const run = h.run();
        await tick();
        h.children[0].close(1);
        await run;
        assert.equal(h.state.status, 'errors');
        assert.ok(h.output.lines.some(line => line.includes('exited unsuccessfully')));
    });

    test('A spawn error followed by close cannot report successful completion', async () => {
        const h = await harness();
        h.document();
        const run = h.run();
        await tick();
        h.children[0].emit('error', new Error('spawn failed'));
        await run;
        h.children[0].close(-1);
        assert.equal(h.state.status, 'errors');
        assert.ok(!h.output.lines.includes('Finished running.'));
    });

    test('Edits made during Sterling preparation are saved before spawning', async () => {
        const h = await harness();
        const doc = h.document();
        const preparation = deferred();
        h.settings.openSterlingIn = 'webview';
        h.sterling.findSterlingPorts = () => preparation.promise;
        const run = h.run();
        await tick();
        assert.equal(doc.saveCalls, 1);
        doc.text = 'edited while preparing';
        doc.isDirty = true;
        preparation.resolve({ staticPort: 1234, providerPort: 1235 });
        await tick();
        assert.equal(doc.saveCalls, 2);
        assert.equal(h.children[0].savedText, 'edited while preparing');
        h.children[0].close();
        await run;
    });

    test('Stop during Sterling preparation prevents a delayed launch', async () => {
        const h = await harness();
        h.document();
        const preparation = deferred();
        h.settings.openSterlingIn = 'webview';
        h.sterling.findSterlingPorts = () => preparation.promise;
        const run = h.run();
        await tick();
        h.stop();
        preparation.resolve({ staticPort: 1234, providerPort: 1235 });
        await run;
        assert.equal(h.children.length, 0);
        assert.equal(h.state.status, 'stopped');
    });

    test('Run refuses to execute when saving leaves newer edits unsaved', async () => {
        const h = await harness();
        const doc = h.document();
        doc.save = async () => true; // A concurrent edit leaves the document dirty.
        await h.run();
        assert.equal(h.children.length, 0);
        assert.ok(h.errors[0].includes('changed while saving'));
    });

    test('A late readiness signal cannot restore Sterling controls after completion', async () => {
        const h = await harness();
        h.document();
        const ready = deferred();
        h.settings.openSterlingIn = 'webview';
        h.sterling.waitForPort = () => ready.promise;
        let opened = false;
        h.sterling.openSterlingWebview = async () => { opened = true; };
        const run = h.run();
        await tick();
        h.children[0].close();
        await run;
        ready.resolve(true);
        await tick();
        assert.equal(opened, false);
        assert.equal(h.contexts.get('forge.sterlingWaiting'), false);
    });

    test('Test Explorer saves before running and reports its result', async () => {
        const h = await harness();
        const save = deferred();
        h.document(undefined, save);
        await h.controller.resolveHandler();
        const token = cancellationToken();
        const run = h.controller.run({}, token);
        await tick();
        assert.equal(h.children.length, 0);
        save.resolve(true);
        await tick();
        assert.equal(h.children[0].savedText, 'new model');
        h.children[0].stdout.emit('data', Buffer.from('Test passed: sample'));
        h.children[0].close();
        await run;
        assert.ok(h.results[0].events.some(e => e.outcome === 'passed'));
        assert.equal(h.results[0].ended, true);
        assert.equal(token.listenerCount, 0);
    });

    test('Test Explorer reports save failure without launching Forge', async () => {
        const h = await harness();
        h.document(undefined, { promise: Promise.resolve(false) });
        await h.controller.resolveHandler();
        await h.controller.run({}, cancellationToken());
        assert.equal(h.children.length, 0);
        assert.ok(h.results[0].events.some(e => e.outcome === 'errored' && e.message.includes('Could not save')));
        assert.equal(h.results[0].ended, true);
    });

    test('Canceling Test Explorer during a save prevents execution', async () => {
        const h = await harness();
        const save = deferred();
        h.document(undefined, save);
        await h.controller.resolveHandler();
        const token = cancellationToken();
        const run = h.controller.run({}, token);
        await tick();
        token.cancel();
        save.resolve(true);
        await run;
        assert.equal(h.children.length, 0);
        assert.ok(h.results[0].events.some(e => e.outcome === 'skipped'));
        assert.equal(h.state.status, 'stopped');
        assert.equal(token.listenerCount, 0);
    });

    test('Test Explorer replacing Run keeps ownership when the old process closes', async () => {
        const h = await harness();
        h.document();
        const manual = h.run();
        await tick();
        await h.controller.resolveHandler();
        const tests = h.controller.run({}, cancellationToken());
        await tick();
        h.children[0].close();
        await manual;
        assert.equal(h.contexts.get('forge.isRunning'), true);
        assert.equal(h.state.status, 'running:tests');
        h.children[1].stdout.emit('data', Buffer.from('Test passed: sample'));
        h.children[1].close();
        await tests;
        assert.equal(h.contexts.get('forge.isRunning'), false);
    });

    test('Replacing a test batch stops remaining files and isolates its cancellation', async () => {
        const h = await harness();
        const save = deferred();
        h.document('/models/first.frg', save);
        h.document('/models/second.frg');
        await h.controller.resolveHandler();
        const token = cancellationToken();
        const tests = h.controller.run({}, token);
        await tick();
        h.document('/models/manual.frg');
        const manual = h.run();
        await tick();
        token.cancel();
        save.resolve(true);
        await tests;
        assert.equal(h.children.length, 1);
        assert.deepEqual(h.children[0].signals, []);
        assert.equal(h.contexts.get('forge.isRunning'), true);
        assert.equal(h.state.status, 'running:manual.frg');
        h.children[0].close();
        await manual;
    });

    test('A delayed Sterling panel cannot replace the newer run panel', async () => {
        const h = await harness();
        const forwarding = deferred();
        const panels = [];
        h.vscode.ViewColumn = { Beside: 2 };
        h.vscode.env = { asExternalUri: uri => uri.toString().includes('1234') ? forwarding.promise : Promise.resolve(uri) };
        h.vscode.window.createWebviewPanel = () => {
            const panel = { webview: {}, onDidDispose() {}, reveal() {} };
            panels.push(panel);
            return panel;
        };
        const sterling = loadSource('sterling-webview', { vscode: h.vscode });
        let firstCurrent = true;
        const first = sterling.openSterlingWebview('http://127.0.0.1:1234', h.runner, 'first', () => firstCurrent);
        firstCurrent = false;
        await sterling.openSterlingWebview('http://127.0.0.1:5678', h.runner, 'second', () => true);
        forwarding.resolve(h.vscode.Uri.parse('http://127.0.0.1:1234'));
        await first;
        assert.equal(panels.length, 1);
        assert.ok(panels[0].webview.html.includes('http://127.0.0.1:5678'));
    });

    test('Closing an old Sterling panel cannot send input to a newer run', async () => {
        const h = await harness();
        let disposePanel;
        let current = true;
        let inputs = 0;
        h.vscode.ViewColumn = { Beside: 2 };
        h.vscode.env = { asExternalUri: async uri => uri };
        h.vscode.window.createWebviewPanel = () => ({ webview: {}, onDidDispose: fn => { disposePanel = fn; } });
        const sterling = loadSource('sterling-webview', { vscode: h.vscode });
        await sterling.openSterlingWebview('http://127.0.0.1:1234', { sendInput: () => { inputs++; } }, 'first', () => current);
        current = false;
        disposePanel();
        assert.equal(inputs, 0);
    });
});
