import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentSymbolParams,
	SymbolInformation,
	SymbolKind,
	Location,
	Range
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as net from 'net';
import { Buffer } from 'buffer';
import { ForgeSymbolExtractor, ForgeSymbol, SymbolKind as ForgeSymbolKind } from './symbols';
import { ForgeLanguageFeatures } from './language-features';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const languageFeatures = new ForgeLanguageFeatures(uri => documents.get(uri));
const racket = spawnRacket();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				triggerCharacters: ['.']
			},
			signatureHelpProvider: { triggerCharacters: ['[', ','], retriggerCharacters: [']'] },
			// Support for go-to-definition
			definitionProvider: true,
			// Support for hover information
			hoverProvider: true,
			// Support for document symbols
			documentSymbolProvider: true
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.forgeLanguageServer || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'forgeLanguageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

function spawnRacket(): ChildProcess {
	// spawn racket
	const syntaxCheck = path.resolve(__dirname, '../src/syntax_check.rkt');
	const racket = spawn('racket', [`"${syntaxCheck}"`], { shell: true });
	if (!racket) {
		connection.console.error('Cannot launch racket');
		throw new Error('Cannot launch racket');
	}
	// if (racket.stderr) {
	// 	racket.stderr.on('data', (data: string) => {
	// 		connection.console.log(`Racket data: ${data}`);
	// 	});
	// }
	// connection.console.log("Successfully spawned Racket");
	return racket;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

let waitingForRacket = true;
setTimeout(() => waitingForRacket = false, 3 * 1000); // need about ~2 second but to be safe here

let timestamp = Date.now();

async function validateTextDocument(textDocument: TextDocument): Promise<void> {

	// connection.console.log(`${Diagnostics.get(textDocument.uri)}`);
	if (waitingForRacket) return;
	// const settings = await getDocumentSettings(textDocument.uri);
	// when validate is called, we assign this validation a timestamp
	const myTimestamp = Date.now();
	timestamp = myTimestamp;

	const text = textDocument.getText();
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(text.length, 0);

	const diagnostics: Diagnostic[] = [];

	let myStderr = '\n';
	// connection.console.log(">>>>>>>>>> Connecting to socket");
	const so = new net.Socket();
	so.connect(8879, 'localhost');

	so.on('error', function (error) { connection.console.log(`client received error: ${error.toString()}`); });
	so.on('connect', function () {
		// connection.console.log("Connected to the socket");
		// it is possible that when we connect, there are already new validation being assigned
		// in this case we want to quit to allow others to enter the socket
		if (myTimestamp < timestamp) {
			// connection.console.log(`oops I connected too late: current timestamp is ${timestamp}, my timestamp is ${myTimestamp}`);
			so.end();
			so.destroy();
		} else {
			so.write(buf);
			// connection.console.log(`>>>>>>>>  text size is: ${text.length} ${buf}`);
			so.write(text);
			// connection.console.log("write text to the racket server");
		}
	});
	so.on('data', function (data) {
		if (myTimestamp < timestamp) {
			// connection.console.log(`oops my data arrived too late: current timestamp is ${timestamp}, my timestamp is ${myTimestamp}`);
			so.end();
			so.destroy();
		} else {
			myStderr += data;
			connection.console.log(data.toString());
			// connection.console.log(">>>>>>>>>> Ending socket");
			so.end();
			so.destroy();

			// when racket finishes eval, we parse the received stderr and send diagnostics to client
			if (myStderr !== '\n') {
				let start = 0;
				let end = 0;

				const line_match = /line=(\d+)/.exec(myStderr);
				const column_match = /column=(\d+)/.exec(myStderr);
				// let offset_match = parser(myStderr, /offset=(\d+)/);

				let line_num = 0;
				let col_num = 0;

				// the stderr could be tokenization issues
				if (line_match !== null && column_match !== null) {
					// connection.console.log(`line match: ${line_match[0]}, col match: ${column_match[0]}`);
					// racket line/col num starts from 0
					line_num = parseInt(line_match[0].slice('line='.length));
					col_num = parseInt(column_match[0].slice('column='.length));
				}

				// } else {
				// 	// for now this would not happen
				// 	const special_match = /frg:(\d+):(\d+):/.exec(myStderr);
				// 	if (special_match !== null) {
				// 		line_num = parseInt(special_match[1]);
				// 		col_num = parseInt(special_match[2]);
				// 	}
				// }

				// if we get some line/col number, we want to get the start and end of the error
				if (line_num !== 0) {
					// connection.console.log(`line num: ${line_num}, col num: ${col_num}`);
					let m: RegExpExecArray | null;
					// iterate over each line
					const pattern = /(.*[\n\r\w])/g; // include the new line char and eof
					while (line_num > 0 && (m = pattern.exec(text))) {
						// connection.console.log(`match: ${m[0]}, ${m.index}, ${m[0].length}`);
						start = m.index + col_num;
						end = m.index + m[0].length;
						line_num -= 1;
					}
					// connection.console.log(`start: ${start}, end: ${end}`);
				}

				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Warning,
					range: {
						start: textDocument.positionAt(start),
						end: textDocument.positionAt(end)
					},
					message: `Forge Syntax Error: ${myStderr}`,
					source: 'syntax_check.rkt'
				};
				if (hasDiagnosticRelatedInformationCapability) {
					diagnostic.relatedInformation = [
						{
							location: {
								uri: textDocument.uri,
								range: Object.assign({}, diagnostic.range)
							},
							message: `${myStderr}`
						}
					];
				}
				diagnostics.push(diagnostic);
			}
			// Send the computed diagnostics to VSCode.
			connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		}
	});
	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received a file change event');
});

connection.onCompletion(params => languageFeatures.completion(params.textDocument.uri, params.position));
connection.onSignatureHelp(params => languageFeatures.signatureHelp(params.textDocument.uri, params.position));

connection.onExit(() => {
	// kill racket
	if (racket) {
		racket.kill('SIGTERM');
	}
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// ========== LSP Feature Implementations ==========

// Cache symbols per document
const documentSymbols = new Map<string, ForgeSymbol[]>();

// Update symbols when document changes
documents.onDidChangeContent(change => {
	const text = change.document.getText();
	const symbols = ForgeSymbolExtractor.extractSymbols(text);
	documentSymbols.set(change.document.uri, symbols);
});

// Provide document symbols (outline view)
connection.onDocumentSymbol((params: DocumentSymbolParams): SymbolInformation[] => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];
	
	const symbols = documentSymbols.get(params.textDocument.uri);
	if (!symbols) return [];
	
	return symbols.map(symbol => ({
		name: symbol.name,
		kind: forgeSymbolKindToLSP(symbol.kind),
		location: Location.create(params.textDocument.uri, symbol.range),
		containerName: symbol.detail
	}));
});

// Custom request: the runnable items (named tests, examples, run/check commands) in a
// document. The client's Test Explorer and "Run" CodeLens use this. `range` anchors the
// item on the name/keyword; `fullRange` is the whole construct's span.
interface ForgeRunnable {
	name: string;
	kind: string;
	range: Range;
	fullRange: Range;
	detail?: string;
}
connection.onRequest('forge/runnables', (params: { uri: string }): ForgeRunnable[] => {
	const symbols = documentSymbols.get(params.uri) ?? [];
	return symbols
		.filter(s =>
			s.kind === ForgeSymbolKind.Test ||
			s.kind === ForgeSymbolKind.Example ||
			s.kind === ForgeSymbolKind.Command
		)
		.map(s => ({
			name: s.name,
			kind: s.kind,
			range: s.range,
			fullRange: s.fullRange ?? s.range,
			detail: s.detail
		}));
});

connection.onDefinition(params => languageFeatures.definition(params.textDocument.uri, params.position));
connection.onHover(params => languageFeatures.hover(params.textDocument.uri, params.position));

// Helper to convert Forge symbol kinds to LSP symbol kinds
function forgeSymbolKindToLSP(kind: ForgeSymbolKind): SymbolKind {
	switch (kind) {
		case ForgeSymbolKind.Sig:
			return SymbolKind.Class;
		case ForgeSymbolKind.Predicate:
			return SymbolKind.Function;
		case ForgeSymbolKind.Function:
			return SymbolKind.Function;
		case ForgeSymbolKind.Field:
			return SymbolKind.Field;
		case ForgeSymbolKind.Variable:
			return SymbolKind.Variable;
		case ForgeSymbolKind.Parameter:
			return SymbolKind.Variable;
		case ForgeSymbolKind.Test:
			return SymbolKind.Method;
		case ForgeSymbolKind.Example:
			return SymbolKind.Constant;
		case ForgeSymbolKind.Command:
			return SymbolKind.Event;
		default:
			return SymbolKind.Variable;
	}
}

// Listen on the connection
connection.listen();
