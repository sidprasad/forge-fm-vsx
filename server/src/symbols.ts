import { ANTLRInputStream, CommonTokenStream } from 'antlr4ts';
import { ForgeLexer } from './parser/grammars/ForgeLexer';
import { ForgeParser, SigDeclContext, PredDeclContext, FunDeclContext } from './parser/grammars/ForgeParser';
import { ForgeVisitor } from './parser/grammars/ForgeVisitor';
import { AbstractParseTreeVisitor } from 'antlr4ts/tree/AbstractParseTreeVisitor';
import { Range } from 'vscode-languageserver';

export enum SymbolKind {
    Sig = 'sig',
    Predicate = 'predicate',
    Function = 'function',
    Field = 'field',
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
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Sig,
                range: Range.create(line, column, line, column + nameToken.text.length),
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
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Predicate,
                range: Range.create(line, column, line, column + nameToken.text.length),
                documentation: docComment
            });
        }
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
            
            this.symbols.push({
                name: nameToken.text,
                kind: SymbolKind.Function,
                range: Range.create(line, column, line, column + nameToken.text.length),
                documentation: docComment
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
