const assert = require('assert').strict;
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { ForgeLanguageFeatures } = require('../../server/out/language-features');

function marked(text) {
    const offset = text.indexOf('¦');
    assert.ok(offset >= 0);
    const source = text.replace('¦', '');
    return { source, position: TextDocument.create('file:///model.frg', 'forge', 1, source).positionAt(offset) };
}

suite('Model-aware language features', () => {
    let directory, features, open;
    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-language-'));
        open = new Map();
        features = new ForgeLanguageFeatures(uri => open.get(uri));
    });
    teardown(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    function document(text, name = 'model.frg') {
        const { source, position } = marked(text);
        const uri = pathToFileURL(path.join(directory, name)).href;
        open.set(uri, TextDocument.create(uri, 'forge', (open.get(uri)?.version ?? 0) + 1, source));
        return { uri, position, source };
    }
    const labels = items => items.map(item => item.label);
    const complete = d => features.completion(d.uri, d.position);

    test('completes model declarations with their kinds, types and documentation', async () => {
        const d = document('#lang forge\n/** A person. */\nsig Person { friends: set Person }\npred knows[p, q: Person] { p in q.friends }\nfun friendsOf[p: Person]: set Person { p.friends }\nrun { ¦ }');
        const items = await complete(d);
        for (const name of ['Person', 'friends', 'knows', 'friendsOf', 'Int']) { assert.ok(labels(items).includes(name), name); }
        assert.match(items.find(i => i.label === 'Person').documentation.value, /A person/);
        assert.match(items.find(i => i.label === 'knows').detail, /p.*q.*Person/);
        assert.ok(!labels(items).includes('p'));
    });

    test('parameters and quantified variables are scoped and shadow correctly', async () => {
        const d = document('#lang forge\nsig Node {}\npred first[elsewhere: Node] {}\npred second[x: Node] {\n some x, y: Node | { x = ¦ }\n}');
        const items = await complete(d);
        assert.equal(labels(items).filter(n => n === 'x').length, 1);
        assert.ok(labels(items).includes('y'));
        assert.ok(!labels(items).includes('elsewhere'));
        const definitions = await features.definition(d.uri, d.position);
        assert.equal(definitions, null); // The cursor is on whitespace, not a name.
        const atX = document(d.source.replace('x = ', '¦x = '));
        const target = await features.definition(atX.uri, atX.position);
        assert.equal(target[0].range.start.line, 4);
    });

    test('quantified names do not escape their block or appear in their own domain', async () => {
        let d = document('sig Node {}\npred p { some local: Node | { local = local }\n ¦ }');
        assert.ok(!labels(await complete(d)).includes('local'));
        d = document('sig Node {}\npred p { all fresh: ¦Node | fresh = fresh }');
        assert.ok(!labels(await complete(d)).includes('fresh'));
    });

    test('let bindings and comprehension variables are visible only in their body', async () => {
        let d = document('sig Node {}\npred p { let chosen = Node | { some ¦ } }');
        assert.ok(labels(await complete(d)).includes('chosen'));
        d = document('sig Node {}\npred p { some { n: Node | n = ¦ } }');
        assert.ok(labels(await complete(d)).includes('n'));
        d = document('sig Node {}\npred p { let chosen = Node | { some chosen }\n ¦ }');
        assert.ok(!labels(await complete(d)).includes('chosen'));
    });

    test('let initializers do not see sibling bindings', async () => {
        const d = document('sig Node {}\npred p { let first = Node, second = ¦Node | first = second }');
        assert.ok(!labels(await complete(d)).includes('first'));
    });

    test('completed bodies do not leak parameters at end of file', async () => {
        const d = document('sig Node {}\npred p[n: Node] {}¦');
        assert.ok(!labels(await complete(d)).includes('n'));
    });

    test('go-to-definition and hover distinguish parameters, locals and member fields', async () => {
        let d = document('sig Node { next: lone Node }\npred p[next: Node] { some ¦next }');
        assert.equal((await features.definition(d.uri, d.position))[0].range.start.line, 1);
        assert.match((await features.hover(d.uri, d.position)).contents.value, /parameter next: Node/);
        d = document('sig Node { next: lone Node }\npred p[next: Node] { some next.¦next }');
        assert.equal((await features.definition(d.uri, d.position))[0].range.start.line, 0);
        assert.match((await features.hover(d.uri, d.position)).contents.value, /field in Node/);
        d = document('sig Node {}\npred p { let chosen = Node | some ¦chosen }');
        assert.equal((await features.definition(d.uri, d.position))[0].range.start.character, 13);
    });

    test('completion edits replace the whole identifier and preserve UTF-16 and CRLF positions', async () => {
        const d = document('// 🐸\r\nsig Node {}\r\npred p[current: Node] { some cur¦rent }');
        const item = (await complete(d)).find(item => item.label === 'current');
        const updated = TextDocument.applyEdits(open.get(d.uri), [item.textEdit]);
        assert.equal(updated, d.source);
        assert.equal(item.textEdit.range.start.line, 2);
    });

    test('signature help ignores comments and declaration parameter lists', async () => {
        let d = document('sig Node {}\npred pair[a, b: Node] {}\nrun { pair[Node, /* comma , bracket ] */ ¦] }');
        assert.equal((await features.signatureHelp(d.uri, d.position)).activeParameter, 1);
        d = document('sig Node {}\npred pair[a: Node, ¦b: Node] {}');
        assert.equal(await features.signatureHelp(d.uri, d.position), null);
    });

    test('editing the language header updates suggestions immediately', async () => {
        let d = document('#lang forge/temporal\nsig Node {}\nrun { ¦ }');
        assert.ok(labels(await complete(d)).includes('always'));
        d = document('#lang forge/froglet\nsig Node {}\nrun { ¦ }');
        assert.ok(!labels(await complete(d)).includes('always'));
    });

    test('completion survives partially written calls and missing closing braces', async () => {
        const d = document('sig Node {}\npred related[a, b: Node] { a = b }\npred editing[current: Node] { related[cu¦');
        assert.ok(labels(await complete(d)).includes('current'));
        const signature = await features.signatureHelp(d.uri, d.position);
        assert.equal(signature.signatures[0].parameters.length, 2);
        assert.equal(signature.activeParameter, 0);
    });

    test('keeps existing names while declarations are typed one character at a time', async () => {
        const source = 'sig Node {}\npred related[a, b: Node] { some x: Node | let y = x | y = a }\nfun choose[n: Node]: lone Node { { x: Node | x = n } }';
        for (let end = 'sig Node {}'.length; end <= source.length; end++) {
            const d = document(source.slice(0, end) + '¦');
            assert.ok(labels(await complete(d)).includes('Node'), `Lost Node after ${JSON.stringify(source.slice(0, end))}`);
        }
    });

    test('parameters remain visible after a closed inner block in an unfinished predicate', async () => {
        const d = document('sig Node {}\npred editing[current: Node] { { some current }¦');
        assert.ok(labels(await complete(d)).includes('current'));
    });

    test('signature help stays visible while typing a member expression argument', async () => {
        const d = document('sig Node { next: lone Node }\npred pair[a, b: Node] {}\nrun { pair[Node.next¦, Node] }');
        assert.equal((await features.signatureHelp(d.uri, d.position)).activeParameter, 0);
    });

    test('signature help counts arguments without counting nested commas', async () => {
        const d = document('sig Node {}\npred pair[a, b: Node] { a = b }\nfun pick[a, b: Node]: Node { a }\nrun { pair[pick[Node, Node], ¦] }');
        const help = await features.signatureHelp(d.uri, d.position);
        assert.equal(help.activeParameter, 1);
        assert.match(help.signatures[0].label, /pair/);
        assert.deepEqual(help.signatures[0].parameters.map(p => p.label), ['a: Node', 'b: Node']);
    });

    test('signature help selects the innermost call and stops after its closing bracket', async () => {
        let d = document('sig Node {}\npred pair[a, b: Node] {}\nfun pick[a: Node]: Node { a }\nrun { pair[pick[¦], Node] }');
        assert.equal((await features.signatureHelp(d.uri, d.position)).signatures[0].label, 'fun pick[a: Node]: Node');
        d = document('sig Node {}\npred pair[a, b: Node] {}\nrun { pair[Node, Node] ¦ }');
        assert.equal(await features.signatureHelp(d.uri, d.position), null);
    });

    test('member completion offers fields instead of keywords', async () => {
        const d = document('sig Node { next: lone Node }\npred p[n: Node] { some n.¦ }');
        assert.ok(labels(await complete(d)).includes('next'));
        assert.ok(!labels(await complete(d)).includes('sig'));
    });

    for (const [lang, temporal, relational] of [['forge/froglet', false, false], ['forge', false, true], ['forge/temporal', true, true]]) {
        test(`filters keywords for #lang ${lang}`, async () => {
            const items = labels(await complete(document(`#lang ${lang}\nsig Node {}\nrun { ¦ }`)));
            assert.equal(items.includes('always'), temporal);
            assert.equal(items.includes('var'), temporal);
            assert.equal(items.includes('set'), relational);
            for (const label of ['Node', 'func', 'pfunc', 'Int']) { assert.ok(items.includes(label), label); }
        });
    }

    test('unknown or unfinished dialects keep model completion available', async () => {
        assert.ok(labels(await complete(document('#lang forge/\nsig Node {}\nrun { ¦ }'))).includes('Node'));
    });

    for (const fragment of ['// ¦', '-- ¦', '/* multiline\n ¦ */', '/* unfinished ¦', '"escaped \\" text ¦"']) {
        test(`suppresses completion and signature help inside ${JSON.stringify(fragment)}`, async () => {
            const d = document(`sig Node {}\npred p[n: Node] {}\nrun { p[Node] }\n${fragment}`);
            assert.deepEqual(await complete(d), []);
            assert.equal(await features.signatureHelp(d.uri, d.position), null);
        });
    }

    test('loads unopened relative imports for completion, hover and definition', async () => {
        await fs.writeFile(path.join(directory, 'shared.frg'), '#lang forge\n/** Shared node. */\nsig Node {}\npred ready[n: Node] {}');
        const d = document('#lang forge\nopen "shared.frg"\nrun { ¦ready[Node] }');
        assert.ok(labels(await complete(d)).includes('Node'));
        const definitions = await features.definition(d.uri, d.position);
        assert.equal(definitions[0].uri, pathToFileURL(path.join(directory, 'shared.frg')).href);
        assert.equal(definitions[0].range.start.line, 3);
        assert.match((await features.hover(d.uri, d.position)).contents.value, /ready/);
        const call = document('#lang forge\nopen "shared.frg"\nrun { ready[¦] }');
        assert.equal((await features.signatureHelp(call.uri, call.position)).signatures[0].parameters[0].label, 'n: Node');
    });

    test('import navigation uses open unsaved content and notices disk edits and deletion', async () => {
        const filename = path.join(directory, 'shared.frg');
        await fs.writeFile(filename, 'sig Saved {}');
        const d = document('open "shared.frg"\nrun { ¦ }');
        assert.ok(labels(await complete(d)).includes('Saved'));
        const edited = document('sig Unsaved {}\n¦', 'shared.frg');
        assert.ok(labels(await complete(d)).includes('Unsaved'));
        assert.ok(!labels(await complete(d)).includes('Saved'));
        open.delete(edited.uri);
        await fs.writeFile(filename, 'sig ChangedOnDisk {}');
        assert.ok(labels(await complete(d)).includes('ChangedOnDisk'));
        await fs.unlink(filename);
        assert.ok(!labels(await complete(d)).includes('ChangedOnDisk'));
    });

    test('imports expose declarations without leaking private locals or transitive imports', async () => {
        await fs.writeFile(path.join(directory, 'leaf.frg'), 'sig Leaf {}');
        await fs.writeFile(path.join(directory, 'shared.frg'), 'open "leaf.frg"\nsig Shared {}\npred p[privateParameter: Shared] { some local: Shared | local = local }');
        const items = labels(await complete(document('open "shared.frg"\nrun { ¦ }')));
        assert.ok(items.includes('Shared'));
        for (const name of ['privateParameter', 'local', 'Leaf']) { assert.ok(!items.includes(name), name); }
    });

    test('aliased file imports follow Forge prefix-in naming', async () => {
        await fs.writeFile(path.join(directory, 'shared.frg'), 'sig Node {}\npred ready[n: Node] {}');
        const d = document('open "shared.frg" as other\nrun { ¦otherready[otherNode] }');
        const items = labels(await complete(d));
        assert.ok(items.includes('otherNode'));
        assert.ok(!items.includes('Node'));
        assert.equal((await features.definition(d.uri, d.position))[0].range.start.line, 1);
    });

    test('go-to-definition opens the file named by an import', async () => {
        await fs.writeFile(path.join(directory, 'shared.frg'), 'sig Node {}');
        const d = document('open "sha¦red.frg"\nrun {}');
        assert.equal((await features.definition(d.uri, d.position))[0].uri, pathToFileURL(path.join(directory, 'shared.frg')).href);
    });

    test('missing imports and cycles do not disable local completion', async () => {
        await fs.writeFile(path.join(directory, 'shared.frg'), 'open "model.frg"\nsig Shared {}');
        const d = document('open "missing.frg"\nopen "shared.frg"\nsig Local {}\nrun { ¦ }');
        const items = labels(await complete(d));
        assert.ok(items.includes('Local'));
        assert.ok(items.includes('Shared'));
    });
});
