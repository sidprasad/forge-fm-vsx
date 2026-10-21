import { ANTLRInputStream, CommonTokenStream, ParserRuleContext } from 'antlr4ts';
import { ForgeLexer } from './parser/grammars/ForgeLexer';
import {
    ForgeParser, SigDeclContext, PredDeclContext, FunDeclContext, ArrowDeclContext,
    ParaDeclContext, QuantDeclContext, TestDeclContext, ExampleDeclContext, CmdDeclContext,
    AssertDeclContext, NameListContext, NameContext, LetDeclContext, ImportDeclContext,
    ExprContext, Expr18Context, QuantifiedPropertyDeclContext, BlockContext, ArrowMultContext, ArrowExprContext
} from './parser/grammars/ForgeParser';
import { ForgeVisitor } from './parser/grammars/ForgeVisitor';
import { AbstractParseTreeVisitor } from 'antlr4ts/tree/AbstractParseTreeVisitor';
import { Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { sourceContext } from './source-context';

export enum SymbolKind {
    Sig = 'sig',
    Predicate = 'predicate',
    Function = 'function',
    Field = 'field',
    Variable = 'variable',
    Parameter = 'parameter',
    Test = 'test',
    Example = 'example',
    Command = 'command'
}

export interface ForgeSymbol {
    name: string;
    kind: SymbolKind;
    // The selection range: just the name/keyword token. Used by go-to-definition and hover,
    // and as a DocumentSymbol's selectionRange.
    range: Range;
    // The full source span of the declaration (start of the construct → end). Used to place
    // Test Explorer items / CodeLens and to compute folding ranges. Falls back to `range`.
    fullRange?: Range;
    detail?: string;
    documentation?: string;
    // Present only for local bindings; globals remain visible throughout the module.
    scope?: Range;
    scopeOpen?: boolean;
    parameters?: { name: string; label: string }[];
    returnType?: string;
}

export interface ForgeImport {
    path: string;
    alias?: string;
    range: Range;
}

export interface ForgeModel {
    symbols: ForgeSymbol[];
    imports: ForgeImport[];
}

/**
 * Visitor that extracts symbol information from the Forge AST
 */
class SymbolExtractorVisitor extends AbstractParseTreeVisitor<void> implements ForgeVisitor<void> {
    private symbols: ForgeSymbol[] = [];
    private text: string;
    private currentSigName: string | null = null;
    private imports: ForgeImport[] = [];
    private document: TextDocument;
    private code: string;
    private braceEnds = new Map<number, number>();
    private unclosedBraces = new Set<number>();

    constructor(text: string) {
        super();
        this.text = text;
        this.document = TextDocument.create('', 'forge', 0, text);
        this.code = sourceContext(text).code;
        const braces: number[] = [];
        for (let i = 0; i < this.code.length; i++) {
            if (this.code[i] === '{') { braces.push(i); }
            else if (this.code[i] === '}' && braces.length) { this.braceEnds.set(braces.pop()!, i + 1); }
        }
        for (const start of braces) {
            this.braceEnds.set(start, text.length);
            this.unclosedBraces.add(start);
        }
    }

    getSymbols(): ForgeSymbol[] {
        return this.symbols.filter(symbol => /^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol.name));
    }

    getImports(): ForgeImport[] { return this.imports; }

    private sourceOf(ctx: ParserRuleContext | undefined): string {
        if (!ctx) { return ''; }
        return this.text.slice(ctx.start.startIndex, (ctx.stop?.stopIndex ?? ctx.start.stopIndex) + 1).trim();
    }

    private parametersOf(ctx: PredDeclContext | FunDeclContext): { name: string; label: string }[] {
        const parameters: { name: string; label: string }[] = [];
        for (let list = ctx.paraDecls()?.paraDeclList(); list; list = list.paraDeclList()) {
            const declaration = list.tryGetRuleContext(0, ParaDeclContext);
            if (!declaration) { continue; }
            const type = [declaration.helperMult()?.text, this.sourceOf(declaration.tryGetRuleContext(0, ExprContext))].filter(Boolean).join(' ');
            for (const name of this.namesOf(declaration.tryGetRuleContext(0, NameListContext))) {
                parameters.push({ name: name.text, label: `${name.text}: ${type}` });
            }
        }
        return parameters;
    }

    private bindingScope(ctx: ParserRuleContext): Pick<ForgeSymbol, 'scope' | 'scopeOpen'> {
        let owner = ctx.parent;
        while (owner && !(owner instanceof PredDeclContext || owner instanceof FunDeclContext ||
            owner instanceof ExprContext || owner instanceof Expr18Context || owner instanceof QuantifiedPropertyDeclContext)) {
            owner = owner.parent;
        }
        let end = (owner?.stop?.stopIndex ?? this.text.length - 1) + 1;
        const bodyStart = owner instanceof PredDeclContext ? owner.tryGetRuleContext(0, BlockContext)?.start.startIndex :
            owner instanceof FunDeclContext ? owner.tryGetToken(ForgeParser.LEFT_CURLY_TOK, 0)?.symbol.startIndex :
                owner instanceof Expr18Context ? owner.start.startIndex :
                    owner instanceof ExprContext ? (owner.blockOrBar()?.block()?.start.startIndex ?? owner.blockOrBar()?.expr()?.start.startIndex) : undefined;
        if (bodyStart !== undefined && this.braceEnds.has(bodyStart)) {
            // ANTLR may stop at the opening brace when the body has an unfinished expression.
            end = this.braceEnds.get(bodyStart)!;
        } else if (owner instanceof PredDeclContext || owner instanceof FunDeclContext) {
            // Error recovery can stop before trailing whitespace in an unfinished body.
            if (owner.stop?.text !== '}') { end = this.text.length; }
        } else if (owner?.stop?.text !== '}') {
            while (end < this.code.length && /\s/.test(this.code[end])) { end++; }
        }
        // Forge expands a group of let bindings to Racket `let`: initializers do not
        // see any name from that group. Quantifier domains can use earlier bindings.
        const start = ctx instanceof LetDeclContext && owner instanceof ExprContext ?
            owner.blockOrBar()?.start.startIndex ?? end : (ctx.stop?.stopIndex ?? ctx.start.stopIndex) + 1;
        return {
            scope: Range.create(this.document.positionAt(start), this.document.positionAt(Math.max(start, end))),
            scopeOpen: end === this.text.length && (bodyStart !== undefined && this.braceEnds.has(bodyStart) ?
                this.unclosedBraces.has(bodyStart) : owner?.stop?.text !== '}')
        };
    }

    visitImportDecl(ctx: ImportDeclContext): void {
        const file = ctx.FILE_PATH_TOK();
        if (!file) { return; } // Bare imports name Racket library modules, not relative Forge files.
        try {
            const filePath: string = JSON.parse(file.text);
            this.imports.push({
                path: filePath, alias: ctx.tryGetRuleContext(0, NameContext)?.text,
                range: Range.create(this.document.positionAt(file.symbol.startIndex), this.document.positionAt(file.symbol.stopIndex + 1))
            });
        } catch { /* An unfinished path is normal while editing. */ }
    }

    visitLetDecl(ctx: LetDeclContext): void {
        const name = ctx.tryGetRuleContext(0, NameContext)?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
        if (name) {
            this.symbols.push({
                name: name.text, kind: SymbolKind.Variable,
                range: this.fullRangeOf(ctx.tryGetRuleContext(0, NameContext)!), ...this.bindingScope(ctx),
                detail: `${name.text} = ${this.sourceOf(ctx.tryGetRuleContext(0, ExprContext))}`
            });
        }
        this.visitChildren(ctx);
    }

    /**
     * Extract the doc comment that immediately precedes a declaration.
     * Only blocks starting with `/**` are treated as docstrings; any other
     * comments between the doc block and the declaration will cause the doc
     * to be ignored.
     */
    private extractDocComment(startLine: number): string | undefined {
        const lines = this.text.split('\n');
        let currentLine = startLine - 1;

        // Skip blank lines directly above the declaration
        while (currentLine >= 0 && lines[currentLine].trim() === '') {
            currentLine--;
        }

        if (currentLine < 0) {
            return undefined;
        }

        // The line immediately above must be part of the doc block
        const endLine = currentLine;
        if (!lines[endLine].includes('*/') && !lines[endLine].includes('/**')) {
            return undefined;
        }

        // Walk upward to find the start of the doc block
        const docLines: string[] = [lines[endLine]];
        let foundStart = lines[endLine].includes('/**');
        while (!foundStart && currentLine > 0) {
            currentLine--;
            docLines.push(lines[currentLine]);
            if (lines[currentLine].includes('/**')) {
                foundStart = true;
                break;
            }
            // If we hit another block terminator before finding '/**', bail
            if (lines[currentLine].includes('*/')) {
                return undefined;
            }
        }

        if (!foundStart) {
            return undefined;
        }

        // Assemble the doc block in original order
        const rawBlock = docLines.reverse().join('\n');
        const startIndex = rawBlock.indexOf('/**');
        const endIndex = rawBlock.lastIndexOf('*/');
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
            return undefined;
        }

        const inner = rawBlock.slice(startIndex + 3, endIndex);
        const cleaned = inner
            .split('\n')
            .map(line => line.replace(/^\s*\*\s?/, '').trimEnd())
            .join('\n')
            .trim();

        return cleaned || undefined;
    }

    protected defaultResult(): void {
        return;
    }

    /**
     * Compute the full source span of a parse-tree node (first token → last token),
     * 0-based for LSP. Used for folding ranges and to anchor Test Explorer items / CodeLens.
     */
    private fullRangeOf(ctx: ParserRuleContext): Range {
        const start = ctx.start;
        const stop = ctx.stop ?? ctx.start;
        return Range.create(
            start.line - 1,
            start.charPositionInLine,
            stop.line - 1,
            stop.charPositionInLine + (stop.text?.length ?? 0)
        );
    }

    /**
     * Flatten a `nameList` into all of its names.
     *
     * The grammar makes `nameList` right-recursive (`name (',' nameList)?`), so a multi-name
     * declaration such as `sig A, B extends C {}` or `left, right: lone Node` nests as
     * name(A) → nameList → name(B) → … . Reading only `.name()` (as the declaration visitors
     * once did) silently dropped every name after the first, so those extra names were absent
     * from the outline, go-to-definition, and hover.
     */
    private namesOf(nameList: NameListContext | undefined): NameContext[] {
        const names: NameContext[] = [];
        for (let cur = nameList; cur; cur = cur.nameList()) {
            const name = cur.tryGetRuleContext(0, NameContext);
            if (name) {
                names.push(name);
            }
        }
        return names;
    }

    /**
     * Extract signature declarations
     */
    visitSigDecl(ctx: SigDeclContext): void {
        // A single declaration may introduce several sigs at once, e.g.
        // `sig Undergrad, Grad extends Student {}`. The modifiers and extension apply to all
        // of them, so build that shared prefix/suffix once and emit one symbol per name.
        let prefix = '';
        if (ctx.ABSTRACT_TOK()) prefix += 'abstract ';
        if (ctx.mult()) prefix += ctx.mult()!.text + ' ';
        const ext = ctx.sigExt() ? ' ' + this.sourceOf(ctx.sigExt()) : '';

        const previousSigName = this.currentSigName;
        let firstSigName: string | undefined;

        for (const nameContext of this.namesOf(ctx.tryGetRuleContext(0, NameListContext))) {
            const nameToken = nameContext.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
            if (!nameToken) {
                continue;
            }
            const line = nameToken.symbol.line - 1; // Convert to 0-based
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);

            if (firstSigName === undefined) {
                firstSigName = nameToken.text;
            }

            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Sig,
                range: Range.create(line, column, line, column + nameToken.text.length),
                fullRange: this.fullRangeOf(ctx),
                detail: (prefix + 'sig ' + nameToken.text + ext).trim(),
                documentation: docComment
            });
        }

        // Fields in the shared body belong to every name in the list; `currentSigName` only
        // drives the field's display detail, so attribute them to the first name.
        this.currentSigName = firstSigName ?? previousSigName;
        this.visitChildren(ctx);
        this.currentSigName = previousSigName;
    }

    /**
     * Extract field declarations (arrowDecl) from signatures
     */
    visitArrowDecl(ctx: ArrowDeclContext): void {
        if (this.currentSigName) {
            // Fields can be declared as a group sharing one type, e.g. `left, right: lone Node`.
            let fieldType = '';
            if (ctx.tryGetRuleContext(0, ArrowMultContext)) {
                fieldType = ctx.tryGetRuleContext(0, ArrowMultContext)!.text + ' ';
            }
            if (ctx.tryGetRuleContext(0, ArrowExprContext)) {
                fieldType += this.sourceOf(ctx.tryGetRuleContext(0, ArrowExprContext));
            }

            for (const nameContext of this.namesOf(ctx.tryGetRuleContext(0, NameListContext))) {
                const nameToken = nameContext.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
                if (!nameToken) {
                    continue;
                }
                const line = nameToken.symbol.line - 1;
                const column = nameToken.symbol.charPositionInLine;
                const docComment = this.extractDocComment(line);

                this.symbols.push({
                    name: nameToken.text,
                    kind: SymbolKind.Field,
                    range: Range.create(line, column, line, column + nameToken.text.length),
                    detail: `field in ${this.currentSigName}: ${fieldType}`,
                    documentation: docComment
                });
            }
        }

        this.visitChildren(ctx);
    }

    /**
     * Extract predicate declarations
     */
    visitPredDecl(ctx: PredDeclContext): void {
        const nameContext = ctx.tryGetRuleContext(0, NameContext);
        const nameToken = nameContext?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);
            
            // Build predicate signature
            let detail = 'pred ' + nameToken.text;
            if (ctx.paraDecls()) {
                detail += this.sourceOf(ctx.paraDecls());
            }
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Predicate,
                range: Range.create(line, column, line, column + nameToken.text.length),
                fullRange: this.fullRangeOf(ctx),
                detail: detail,
                documentation: docComment,
                parameters: this.parametersOf(ctx)
            });
        }
        
        // Visit children to capture parameters
        this.visitChildren(ctx);
    }

    /**
     * Extract function declarations
     */
    visitFunDecl(ctx: FunDeclContext): void {
        const nameContext = ctx.tryGetRuleContext(0, NameContext);
        const nameToken = nameContext?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);
            
            // Build function signature
            let detail = 'fun ' + nameToken.text;
            if (ctx.paraDecls()) {
                detail += this.sourceOf(ctx.paraDecls());
            }
            detail += ': ';
            if (ctx.helperMult()) {
                detail += ctx.helperMult()!.text + ' ';
            }
            // Get return type from first expr
            const exprs = ctx.expr();
            if (exprs && exprs.length > 0) {
                detail += this.sourceOf(exprs[0]);
            }
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Function,
                range: Range.create(line, column, line, column + nameToken.text.length),
                fullRange: this.fullRangeOf(ctx),
                detail: detail,
                documentation: docComment,
                parameters: this.parametersOf(ctx),
                returnType: [ctx.helperMult()?.text, this.sourceOf(exprs[0])].filter(Boolean).join(' ')
            });
        }
        
        this.visitChildren(ctx);
    }

    /**
     * Extract quantified variable declarations (all s: Node, some n: Person, etc.)
     */
    visitQuantDecl(ctx: QuantDeclContext): void {
        // A quantifier can bind several variables of one type, e.g. `all x, y: A | ...`.
        let varType = '';
        if (ctx.SET_TOK()) {
            varType = 'set ';
        }
        if (ctx.tryGetRuleContext(0, ExprContext)) {
            varType += this.sourceOf(ctx.tryGetRuleContext(0, ExprContext));
        }

        for (const nameContext of this.namesOf(ctx.tryGetRuleContext(0, NameListContext))) {
            const nameToken = nameContext.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
            if (!nameToken) {
                continue;
            }
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;

            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Variable,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: `${nameToken.text}: ${varType}`,
                ...this.bindingScope(ctx),
                documentation: undefined
            });
        }

        this.visitChildren(ctx);
    }

    /**
     * Extract parameter declarations from predicates/functions
     */
    visitParaDecl(ctx: ParaDeclContext): void {
        // A parameter group shares one type, e.g. `pred p[x, y: A]`.
        let paramType = '';
        if (ctx.helperMult()) {
            paramType = ctx.helperMult()!.text + ' ';
        }
        if (ctx.tryGetRuleContext(0, ExprContext)) {
            paramType += this.sourceOf(ctx.tryGetRuleContext(0, ExprContext));
        }

        for (const nameContext of this.namesOf(ctx.tryGetRuleContext(0, NameListContext))) {
            const nameToken = nameContext.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
            if (!nameToken) {
                continue;
            }
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;

            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Parameter,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: `parameter ${nameToken.text}: ${paramType}`,
                ...this.bindingScope(ctx),
                documentation: undefined
            });
        }

        this.visitChildren(ctx);
    }

    /**
     * Extract a named test from a `test expect { name: {...} is <expectation> }` block.
     * Only label-named tests are captured, since those are the ones Forge reports as
     * "Test passed: <name>" / "Test <name> failed" — the strings the Test Explorer maps.
     */
    visitTestDecl(ctx: TestDeclContext): void {
        const nameToken = ctx.tryGetRuleContext(0, NameContext)?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);

        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;

            let expectation = '';
            if (ctx.SAT_TOK()) { expectation = 'sat'; }
            else if (ctx.UNSAT_TOK()) { expectation = 'unsat'; }
            else if (ctx.THEOREM_TOK()) { expectation = 'theorem'; }
            else if (ctx.CHECKED_TOK()) { expectation = 'checked'; }
            else if (ctx.FORGE_ERROR_TOK()) { expectation = 'forge_error'; }

            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Test,
                range: Range.create(line, column, line, column + nameToken.text.length),
                fullRange: this.fullRangeOf(ctx),
                detail: expectation ? `test … is ${expectation}` : 'test',
                documentation: this.extractDocComment(line)
            });
        }

        this.visitChildren(ctx);
    }

    /**
     * Extract `example <name> is <pred> for {...}` declarations. Examples run as tests and
     * report pass/fail the same way named tests do.
     */
    visitExampleDecl(ctx: ExampleDeclContext): void {
        const nameToken = ctx.tryGetRuleContext(0, NameContext)?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);

        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;

            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Example,
                range: Range.create(line, column, line, column + nameToken.text.length),
                fullRange: this.fullRangeOf(ctx),
                detail: 'example',
                documentation: this.extractDocComment(line)
            });
        }

        this.visitChildren(ctx);
    }

    /**
     * Extract `run` / `check` commands. These may be anonymous; anchor the symbol on the name
     * when present, otherwise on the run/check keyword. Used to place "Run" CodeLens.
     */
    visitCmdDecl(ctx: CmdDeclContext): void {
        const keyword = ctx.RUN_TOK() ? 'run' : (ctx.CHECK_TOK() ? 'check' : 'command');
        const nameNode = ctx.tryGetRuleContext(0, NameContext)?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);
        const anchor = nameNode?.symbol ?? (ctx.RUN_TOK() ?? ctx.CHECK_TOK())?.symbol;

        if (anchor) {
            const line = anchor.line - 1;
            const column = anchor.charPositionInLine;
            const anchorText = anchor.text ?? keyword;

            this.symbols.push({
                name: nameNode?.text ?? keyword,
                kind: SymbolKind.Command,
                range: Range.create(line, column, line, column + anchorText.length),
                fullRange: this.fullRangeOf(ctx),
                detail: keyword
            });
        }

        this.visitChildren(ctx);
    }

    /**
     * Extract named `assert <name> { ... }` declarations (verification tests).
     */
    visitAssertDecl(ctx: AssertDeclContext): void {
        const nameToken = ctx.tryGetRuleContext(0, NameContext)?.tryGetToken(ForgeParser.IDENTIFIER_TOK, 0);

        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;

            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Test,
                range: Range.create(line, column, line, column + nameToken.text.length),
                fullRange: this.fullRangeOf(ctx),
                detail: 'assert',
                documentation: this.extractDocComment(line)
            });
        }

        this.visitChildren(ctx);
    }
}

/**
 * Symbol extractor using ANTLR parser
 */
export class ForgeSymbolExtractor {
    /**
     * Parse Forge code and extract symbol information
     */
    static extractSymbols(text: string): ForgeSymbol[] {
        return this.extractModel(text).symbols;
    }

    static extractModel(text: string): ForgeModel {
        try {
            // Create lexer and parser
            const inputStream = new ANTLRInputStream(text);
            const lexer = new ForgeLexer(inputStream);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new ForgeParser(tokenStream);
            lexer.removeErrorListeners();
            parser.removeErrorListeners();

            // Parse the file
            const tree = parser.alloyModule();

            // Extract symbols using visitor
            const visitor = new SymbolExtractorVisitor(text);
            visitor.visit(tree);

            return { symbols: visitor.getSymbols(), imports: visitor.getImports() };
        } catch (error) {
            console.error('Error parsing Forge code:', error);
            return { symbols: [], imports: [] };
        }
    }
}
