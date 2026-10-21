const assert = require('assert').strict;
const { fork } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMessageConnection, IPCMessageReader, IPCMessageWriter } = require('vscode-jsonrpc/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

suite('Language server over IPC', function () {
    this.timeout(10000);
    let directory, child, connection, capabilities, document;
    const request = (method, offset) => connection.sendRequest(`textDocument/${method}`, {
        textDocument: { uri: document.uri }, position: document.positionAt(offset)
    });

    suiteSetup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lsp-'));
        child = fork(path.resolve(__dirname, '../../server/out/server.js'), ['--node-ipc'], {
            execArgv: ['--require', path.join(__dirname, 'fixtures/without-racket.cjs')], silent: true
        });
        connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
        connection.listen();
        ({ capabilities } = await connection.sendRequest('initialize', {
            processId: process.pid, rootUri: pathToFileURL(directory).href, capabilities: {}
        }));
        await connection.sendNotification('initialized', {});
    });

    suiteTeardown(async () => {
        connection?.dispose();
        if (child && child.exitCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill();
            await exited;
        }
        if (directory) { await fs.rm(directory, { recursive: true, force: true }); }
    });

    setup(async () => {
        document = TextDocument.create(pathToFileURL(path.join(directory, 'model.frg')).href, 'forge', 1,
            '#lang forge/froglet\nsig Node { next: lone Node }\npred related[a, b: Node] { a = b }\npred use[current: Node] { related[current, current] }\nrun { some Node }');
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
            uri: document.uri, languageId: 'forge', version: 1, text: document.getText()
        } });
    });
    teardown(async () => {
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri: document.uri } });
    });

    test('advertises field completion and signature-help triggers', () => {
        assert.ok(capabilities.completionProvider.triggerCharacters.includes('.'));
        assert.ok(capabilities.signatureHelpProvider.triggerCharacters.includes('['));
        assert.ok(capabilities.signatureHelpProvider.triggerCharacters.includes(','));
        assert.equal(capabilities.definitionProvider, true);
    });

    test('completes actual model names, fields and scoped parameters', async () => {
        const text = document.getText();
        const items = await request('completion', text.indexOf('related[current') + 8);
        for (const name of ['Node', 'next', 'related', 'current']) { assert.ok(items.some(item => item.label === name), name); }
        assert.ok(!items.some(item => item.label === 'always'));
        assert.ok(!items.some(item => item.label === 'a'));
        assert.match(items.find(item => item.label === 'related').detail, /pred related/);
        assert.ok(items.some(item => item.insertTextFormat === 2));
    });

    test('returns signatures, definitions and hover through registered handlers', async () => {
        const text = document.getText();
        const call = text.indexOf('related[current');
        const help = await request('signatureHelp', text.indexOf(', current') + 2);
        assert.equal(help.activeParameter, 1);
        assert.equal(help.signatures[0].label, 'pred related[a: Node, b: Node]');
        assert.equal((await request('definition', call))[0].range.start.line, 2);
        assert.match((await request('hover', call)).contents.value, /pred related/);
        assert.equal((await request('definition', text.indexOf('current, current')))[0].range.start.line, 3);
    });

    test('incremental edits invalidate cached symbols and dialect immediately', async () => {
        await request('completion', document.getText().length);
        const changes = [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: '#lang forge/temporal\n' }];
        TextDocument.update(document, changes, 2);
        await connection.sendNotification('textDocument/didChange', { textDocument: { uri: document.uri, version: 2 }, contentChanges: changes });
        const items = await request('completion', document.getText().length);
        assert.ok(items.some(item => item.label === 'always'));
        assert.ok(items.some(item => item.label === 'Node'));

        const insertion = [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: 'sig Added {}\n' }];
        TextDocument.update(document, insertion, 3);
        await connection.sendNotification('textDocument/didChange', { textDocument: { uri: document.uri, version: 3 }, contentChanges: insertion });
        assert.ok((await request('completion', document.getText().length)).some(item => item.label === 'Added'));
    });

    test('navigates unopened imports and reads unsaved imported declarations', async () => {
        const importedUri = pathToFileURL(path.join(directory, 'shared.frg')).href;
        await fs.writeFile(path.join(directory, 'shared.frg'), 'sig Shared {}\npred ready[n: Shared] {}');
        const text = '#lang forge\nopen "shared.frg"\nrun { ready[Shared] }';
        TextDocument.update(document, [{ text }], 2);
        await connection.sendNotification('textDocument/didChange', { textDocument: { uri: document.uri, version: 2 }, contentChanges: [{ text }] });
        const destination = await request('definition', text.indexOf('ready'));
        assert.equal(destination[0].uri, importedUri);
        assert.equal(destination[0].range.start.line, 1);
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
            uri: importedUri, languageId: 'forge', version: 1, text: 'sig Unsaved {}'
        } });
        try {
            const items = await request('completion', text.length);
            assert.ok(items.some(item => item.label === 'Unsaved'));
            assert.ok(!items.some(item => item.label === 'Shared'));
        } finally {
            await connection.sendNotification('textDocument/didClose', { textDocument: { uri: importedUri } });
        }
    });

    test('preserves outline and runnable discovery', async () => {
        const symbols = await connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri: document.uri } });
        assert.ok(symbols.some(symbol => symbol.name === 'Node'));
        assert.ok(symbols.some(symbol => symbol.name === 'next'));
        const runnables = await connection.sendRequest('forge/runnables', { uri: document.uri });
        assert.equal(runnables.length, 1);
        assert.equal(runnables[0].kind, 'command');
    });
});
