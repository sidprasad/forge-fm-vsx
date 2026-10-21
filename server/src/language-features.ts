import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
    CompletionItem, CompletionItemKind, Hover, Location, MarkupContent, MarkupKind,
    Position, Range, SignatureHelp, TextEdit
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { staticCompletions } from './completion-data';
import { ForgeModel, ForgeSymbol, ForgeSymbolExtractor, SymbolKind } from './symbols';
import { sourceContext, wordAt } from './source-context';

interface Model extends ForgeModel {
    document: TextDocument;
    context: ReturnType<typeof sourceContext>;
    diskStamp?: string;
}

interface VisibleSymbol {
    symbol: ForgeSymbol;
    name: string;
    uri: string;
    priority: number;
}

function compare(a: Position, b: Position): number {
    return a.line - b.line || a.character - b.character;
}

function contains(range: Range, position: Position): boolean {
    return compare(position, range.start) >= 0 && compare(position, range.end) < 0;
}

function isGlobal(symbol: ForgeSymbol): boolean {
    return [SymbolKind.Sig, SymbolKind.Field, SymbolKind.Predicate, SymbolKind.Function].includes(symbol.kind);
}

function documentation(entry: VisibleSymbol): MarkupContent {
    const declaration = entry.symbol.detail ?? `${entry.symbol.kind} ${entry.name}`;
    return {
        kind: MarkupKind.Markdown,
        value: `**${entry.symbol.kind}** \`${entry.name}\`\n\n\`\`\`forge\n${declaration}\n\`\`\`` +
            (entry.symbol.documentation ? `\n\n${entry.symbol.documentation}` : '') +
            (entry.priority === 2 ? `\n\nImported from ${path.basename(fileURLToPath(entry.uri))}` : '')
    };
}

/** Syntax-based editor assistance; Racket remains responsible for type checking. */
export class ForgeLanguageFeatures {
    private readonly models = new Map<string, Model>();

    constructor(private readonly getOpenDocument: (uri: string) => TextDocument | undefined) { }

    private async model(uri: string): Promise<Model | undefined> {
        const cached = this.models.get(uri);
        let document = this.getOpenDocument(uri);
        let diskStamp: string | undefined;
        if (!document) {
            try {
                const filename = fileURLToPath(uri);
                const stat = await fs.stat(filename);
                diskStamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
                if (cached?.diskStamp === diskStamp) { return cached; }
                document = TextDocument.create(uri, 'forge', 0, await fs.readFile(filename, 'utf8'));
            } catch {
                this.models.delete(uri);
                return undefined;
            }
        }
        const text = document.getText();
        if (cached?.document.getText() === text) {
            cached.diskStamp = diskStamp;
            return cached;
        }
        const model: Model = {
            ...ForgeSymbolExtractor.extractModel(text),
            // TextDocuments updates its objects in place; cache an immutable snapshot.
            document: TextDocument.create(uri, 'forge', document.version, text), context: sourceContext(text), diskStamp
        };
        // Bound memory even when navigating a large workspace over a long session.
        this.models.delete(uri);
        this.models.set(uri, model);
        if (this.models.size > 128) { this.models.delete(this.models.keys().next().value!); }
        return model;
    }

    private importUri(uri: string, filename: string): string | undefined {
        try { return pathToFileURL(path.resolve(path.dirname(fileURLToPath(uri)), filename)).href; }
        catch { return undefined; }
    }

    private async visible(model: Model, position: Position): Promise<VisibleSymbol[]> {
        const own = model.symbols.filter(symbol => isGlobal(symbol) || (symbol.scope &&
            (contains(symbol.scope, position) || contains(symbol.range, position) ||
                // An unfinished body can end exactly at the cursor.
                (symbol.scopeOpen && compare(position, symbol.scope.end) === 0))))
            .map(symbol => ({ symbol, name: symbol.name, uri: model.document.uri, priority: symbol.scope ? 0 : 1 }));
        const imported = await Promise.all(model.imports.map(async reference => {
            const uri = this.importUri(model.document.uri, reference.path);
            const target = uri ? await this.model(uri) : undefined;
            // Forge exports declarations defined in the module, not its imports or locals.
            return target ? target.symbols.filter(isGlobal).map(symbol => ({
                symbol, name: (reference.alias ?? '') + symbol.name, uri: target.document.uri, priority: 2
            })) : [];
        }));
        return [...own, ...imported.flat()].sort((a, b) => a.priority - b.priority ||
            (a.symbol.scope && b.symbol.scope ? compare(b.symbol.scope.start, a.symbol.scope.start) : 0));
    }

    private async matching(model: Model, position: Position, name: string, nameOffset?: number): Promise<VisibleSymbol[]> {
        const offset = model.document.offsetAt(position);
        const word = wordAt(model.context.code, nameOffset ?? offset);
        const member = word && /\.\s*$/.test(model.context.code.slice(0, word.start));
        const matches = (await this.visible(model, position)).filter(entry => entry.name === name &&
            (!member || entry.symbol.kind === SymbolKind.Field));
        if (!matches.length) { return []; }
        // Locals shadow outer bindings. Ambiguous globals can offer multiple destinations.
        return matches[0].priority === 0 ? matches.slice(0, 1) : matches.filter(entry => entry.priority === matches[0].priority);
    }

    async completion(uri: string, position: Position): Promise<CompletionItem[]> {
        let model = await this.model(uri);
        if (!model) { return []; }
        const offset = model.document.offsetAt(position);
        if (!model.context.isCode(offset)) { return []; }
        const word = wordAt(model.context.code, offset);
        if (!word) { model = this.completionModel(model, offset); }
        const start = word?.start ?? offset;
        const member = /\.\s*$/.test(model.context.code.slice(0, start));
        const range = Range.create(model.document.positionAt(start), model.document.positionAt(word?.end ?? offset));
        const seen = new Set<string>();
        const items: CompletionItem[] = [];
        for (const entry of await this.visible(model, position)) {
            if (seen.has(entry.name) || (member && entry.symbol.kind !== SymbolKind.Field)) { continue; }
            seen.add(entry.name);
            const kind = entry.symbol.kind === SymbolKind.Sig ? CompletionItemKind.Class :
                entry.symbol.kind === SymbolKind.Field ? CompletionItemKind.Field :
                    [SymbolKind.Predicate, SymbolKind.Function].includes(entry.symbol.kind) ? CompletionItemKind.Function : CompletionItemKind.Variable;
            items.push({
                label: entry.name, kind, detail: entry.symbol.detail, documentation: documentation(entry),
                sortText: `${entry.priority}_${entry.name}`, textEdit: TextEdit.replace(range, entry.name)
            });
        }
        if (!member) {
            items.push(...staticCompletions(model.context.dialect).filter(item => !seen.has(item.label)));
        }
        return items;
    }

    private completionModel(model: Model, offset: number): Model {
        // Supply an expression at an empty cursor so parser recovery retains surrounding
        // comprehensions/bindings. This is an in-memory parse only; map every range back.
        const placeholder = '__forge_completion__';
        const text = model.document.getText();
        const repairedText = text.slice(0, offset) + placeholder + text.slice(offset);
        const repairedDocument = TextDocument.create(model.document.uri, 'forge', 0, repairedText);
        const repair = ForgeSymbolExtractor.extractModel(repairedText);
        const originalPosition = (position: Position) => {
            const repairedOffset = repairedDocument.offsetAt(position);
            return model.document.positionAt(repairedOffset <= offset ? repairedOffset : Math.max(offset, repairedOffset - placeholder.length));
        };
        const originalRange = (range: Range): Range => Range.create(originalPosition(range.start), originalPosition(range.end));
        const symbols = new Map(model.symbols.map(symbol => [`${symbol.name}:${symbol.range.start.line}:${symbol.range.start.character}`, symbol]));
        for (const symbol of repair.symbols) {
            if (!symbol.scope || symbol.name === placeholder || symbol.detail?.includes(placeholder)) { continue; }
            const mapped = {
                ...symbol, range: originalRange(symbol.range),
                fullRange: symbol.fullRange && originalRange(symbol.fullRange),
                scope: symbol.scope && originalRange(symbol.scope)
            };
            const key = `${mapped.name}:${mapped.range.start.line}:${mapped.range.start.character}`;
            // Existing declarations retain their original details; recovered locals supply scope.
            if (!symbols.has(key)) { symbols.set(key, mapped); }
        }
        return { ...model, symbols: [...symbols.values()] };
    }

    async definition(uri: string, position: Position): Promise<Location[] | null> {
        const model = await this.model(uri);
        if (!model) { return null; }
        const reference = model.imports.find(item => contains(item.range, position));
        if (reference) {
            const targetUri = this.importUri(uri, reference.path);
            return targetUri && await this.model(targetUri) ? [Location.create(targetUri, Range.create(0, 0, 0, 0))] : null;
        }
        const offset = model.document.offsetAt(position);
        if (!model.context.isCode(offset)) { return null; }
        const word = wordAt(model.context.code, offset);
        if (!word) { return null; }
        const matches = await this.matching(model, position, word.name);
        return matches.length ? matches.map(entry => Location.create(entry.uri, entry.symbol.range)) : null;
    }

    async hover(uri: string, position: Position): Promise<Hover | null> {
        const model = await this.model(uri);
        if (!model) { return null; }
        const offset = model.document.offsetAt(position);
        if (!model.context.isCode(offset)) { return null; }
        const word = wordAt(model.context.code, offset);
        if (!word) { return null; }
        const [entry] = await this.matching(model, position, word.name);
        return entry ? {
            contents: documentation(entry),
            range: Range.create(model.document.positionAt(word.start), model.document.positionAt(word.end))
        } : null;
    }

    async signatureHelp(uri: string, position: Position): Promise<SignatureHelp | null> {
        const model = await this.model(uri);
        if (!model) { return null; }
        const offset = model.document.offsetAt(position);
        if (!model.context.isCode(offset)) { return null; }
        const code = model.context.code.slice(0, offset);
        const stack: { bracket: string; start: number; commas: number }[] = [];
        for (let i = 0; i < code.length; i++) {
            const char = code[i];
            if ('[({'.includes(char)) { stack.push({ bracket: char, start: i, commas: 0 }); }
            else if (']})'.includes(char)) { stack.pop(); }
            else if (char === ',' && stack.length) { stack[stack.length - 1].commas++; }
        }
        for (const frame of stack.reverse()) {
            if (frame.bracket !== '[') { continue; }
            const before = code.slice(0, frame.start).trimEnd();
            const word = wordAt(before, before.length);
            if (!word) { continue; }
            const matches = await this.matching(model, position, word.name, word.start);
            const callable = matches.filter(entry => entry.symbol.parameters &&
                // The name before this bracket must be a use, not a declaration.
                !(entry.uri === uri && model.document.offsetAt(entry.symbol.range.start) === word.start));
            if (!callable.length) { return null; }
            return {
                signatures: callable.map(entry => ({
                    label: `${entry.symbol.kind === SymbolKind.Predicate ? 'pred' : 'fun'} ${entry.name}[${entry.symbol.parameters!.map(p => p.label).join(', ')}]` +
                        (entry.symbol.returnType ? `: ${entry.symbol.returnType}` : ''),
                    documentation: documentation(entry),
                    parameters: entry.symbol.parameters!.map(parameter => ({ label: parameter.label }))
                })),
                activeSignature: 0,
                activeParameter: Math.min(frame.commas, Math.max(0, callable[0].symbol.parameters!.length - 1))
            };
        }
        return null;
    }
}
