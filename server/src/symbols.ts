import { ANTLRInputStream, CommonTokenStream } from 'antlr4ts';
import { ForgeLexer } from './parser/grammars/ForgeLexer';
import { ForgeParser, SigDeclContext, PredDeclContext, FunDeclContext, ArrowDeclContext, ParaDeclContext, QuantDeclContext } from './parser/grammars/ForgeParser';
import { ForgeVisitor } from './parser/grammars/ForgeVisitor';
import { AbstractParseTreeVisitor } from 'antlr4ts/tree/AbstractParseTreeVisitor';
import { Range } from 'vscode-languageserver';

export enum SymbolKind {
    Sig = 'sig',
    Predicate = 'predicate',
    Function = 'function',
    Field = 'field',
    Variable = 'variable',
    Parameter = 'parameter',
    Test = 'test',
    Example = 'example'
}

export interface ForgeSymbol {
    name: string;
    kind: SymbolKind;
    range: Range;
    detail?: string;
    documentation?: string;
}

/**
 * Visitor that extracts symbol information from the Forge AST
 */
class SymbolExtractorVisitor extends AbstractParseTreeVisitor<void> implements ForgeVisitor<void> {
    private symbols: ForgeSymbol[] = [];
    private text: string;
    private currentSigName: string | null = null;

    constructor(text: string) {
        super();
        this.text = text;
    }

    getSymbols(): ForgeSymbol[] {
        return this.symbols;
    }

    /**
     * Extract doc comment from block comments that appear before a declaration
     */
    private extractDocComment(startLine: number): string | undefined {
        const lines = this.text.split('\n');
        let docComment = '';
        let foundComment = false;
        
        // Look backwards from the declaration line
        for (let i = startLine - 1; i >= 0; i--) {
            const line = lines[i].trim();
            
            // Stop if we hit a non-comment, non-empty line
            if (line && !line.startsWith('//') && !line.startsWith('--') && !line.includes('*/') && !line.includes('/*') && !line.startsWith('*')) {
                break;
            }
            
            // Check for end of block comment
            if (line.includes('*/')) {
                foundComment = true;
                const endIndex = line.indexOf('*/');
                const content = line.substring(0, endIndex).trim();
                if (content.startsWith('*')) {
                    docComment = content.substring(1).trim() + (docComment ? '\n' + docComment : '');
                } else {
                    docComment = content + (docComment ? '\n' + docComment : '');
                }
            }
            // Check for start of block comment
            else if (line.includes('/*')) {
                const startIndex = line.indexOf('/*');
                const content = line.substring(startIndex + 2).trim();
                if (content.startsWith('*')) {
                    docComment = content.substring(1).trim() + (docComment ? '\n' + docComment : '');
                } else {
                    docComment = content + (docComment ? '\n' + docComment : '');
                }
                break; // Found start of comment, stop
            }
            // Middle of block comment
            else if (foundComment && line.startsWith('*')) {
                docComment = line.substring(1).trim() + (docComment ? '\n' + docComment : '');
            }
            else if (foundComment) {
                docComment = line + (docComment ? '\n' + docComment : '');
            }
        }
        
        return docComment.trim() || undefined;
    }

    protected defaultResult(): void {
        return;
    }

    /**
     * Extract signature declarations
     */
    visitSigDecl(ctx: SigDeclContext): void {
        // Get the first name from nameList
        const nameList = ctx.nameList();
        const nameContext = nameList.name();
        const nameToken = nameContext.IDENTIFIER_TOK();
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1; // Convert to 0-based
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);
            
            // Build detailed signature information
            let detail = '';
            if (ctx.ABSTRACT_TOK()) detail += 'abstract ';
            if (ctx.mult()) detail += ctx.mult()!.text + ' ';
            detail += 'sig ' + nameToken.text;
            if (ctx.sigExt()) {
                detail += ' ' + ctx.sigExt()!.text;
            }
            
            // Store current sig name for field processing
            const previousSigName = this.currentSigName;
            this.currentSigName = nameToken.text;
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Sig,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: detail.trim(),
                documentation: docComment
            });
            
            // Visit children to capture fields
            this.visitChildren(ctx);
            
            // Restore previous sig name
            this.currentSigName = previousSigName;
        }
    }

    /**
     * Extract field declarations (arrowDecl) from signatures
     */
    visitArrowDecl(ctx: ArrowDeclContext): void {
        const nameList = ctx.nameList();
        const nameContext = nameList.name();
        const nameToken = nameContext.IDENTIFIER_TOK();
        
        if (nameToken && this.currentSigName) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);
            
            // Build field type information
            let fieldType = '';
            if (ctx.arrowMult()) {
                fieldType = ctx.arrowMult()!.text + ' ';
            }
            if (ctx.arrowExpr()) {
                fieldType += ctx.arrowExpr().text;
            }
            
            const detail = `${nameToken.text}: ${fieldType}`;
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Field,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: `field in ${this.currentSigName}: ${fieldType}`,
                documentation: docComment
            });
        }
        
        this.visitChildren(ctx);
    }

    /**
     * Extract predicate declarations
     */
    visitPredDecl(ctx: PredDeclContext): void {
        const nameContext = ctx.name();
        const nameToken = nameContext.IDENTIFIER_TOK();
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);
            
            // Build predicate signature
            let detail = 'pred ' + nameToken.text;
            if (ctx.paraDecls()) {
                detail += ctx.paraDecls()!.text;
            }
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Predicate,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: detail,
                documentation: docComment
            });
        }
        
        // Visit children to capture parameters
        this.visitChildren(ctx);
    }

    /**
     * Extract function declarations
     */
    visitFunDecl(ctx: FunDeclContext): void {
        const nameContext = ctx.name();
        const nameToken = nameContext.IDENTIFIER_TOK();
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            const docComment = this.extractDocComment(line);
            
            // Build function signature
            let detail = 'fun ' + nameToken.text;
            if (ctx.paraDecls()) {
                detail += ctx.paraDecls()!.text;
            }
            detail += ': ';
            if (ctx.helperMult()) {
                detail += ctx.helperMult()!.text + ' ';
            }
            // Get return type from first expr
            const exprs = ctx.expr();
            if (exprs && exprs.length > 0) {
                detail += exprs[0].text;
            }
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Function,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: detail,
                documentation: docComment
            });
        }
        
        this.visitChildren(ctx);
    }

    /**
     * Extract quantified variable declarations (all s: Node, some n: Person, etc.)
     */
    visitQuantDecl(ctx: QuantDeclContext): void {
        const nameList = ctx.nameList();
        const nameContext = nameList.name();
        const nameToken = nameContext.IDENTIFIER_TOK();
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            
            // Build variable type information
            let varType = '';
            if (ctx.SET_TOK()) {
                varType = 'set ';
            }
            if (ctx.expr()) {
                varType += ctx.expr().text;
            }
            
            const detail = `${nameToken.text}: ${varType}`;
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Variable,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: detail,
                documentation: undefined
            });
        }
        
        this.visitChildren(ctx);
    }

    /**
     * Extract parameter declarations from predicates/functions
     */
    visitParaDecl(ctx: ParaDeclContext): void {
        const nameList = ctx.nameList();
        const nameContext = nameList.name();
        const nameToken = nameContext.IDENTIFIER_TOK();
        
        if (nameToken) {
            const line = nameToken.symbol.line - 1;
            const column = nameToken.symbol.charPositionInLine;
            
            // Build parameter type information
            let paramType = '';
            if (ctx.helperMult()) {
                paramType = ctx.helperMult()!.text + ' ';
            }
            if (ctx.expr()) {
                paramType += ctx.expr().text;
            }
            
            const detail = `parameter ${nameToken.text}: ${paramType}`;
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Parameter,
                range: Range.create(line, column, line, column + nameToken.text.length),
                detail: detail,
                documentation: undefined
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
        try {
            // Create lexer and parser
            const inputStream = new ANTLRInputStream(text);
            const lexer = new ForgeLexer(inputStream);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new ForgeParser(tokenStream);

            // Parse the file
            const tree = parser.alloyModule();

            // Extract symbols using visitor
            const visitor = new SymbolExtractorVisitor(text);
            visitor.visit(tree);

            return visitor.getSymbols();
        } catch (error) {
            console.error('Error parsing Forge code:', error);
            return [];
        }
    }
}
