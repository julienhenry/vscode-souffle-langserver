/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as lsp from 'vscode-languageserver/node';

import * as tree_sitter from 'web-tree-sitter';
//const souffle = require('tree-sitter-souffle');
//import * as souffle from 'tree-sitter-souffle';
import * as fs from 'fs';
import { URI as Uri } from 'vscode-uri';
import * as path from 'path';
import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { SouffleDocument, uriToSouffleDocument, parsers, legend } from './souffleDocument';
import { connect } from 'http2';
import { SemanticTokenTypes } from 'vscode-languageserver/node';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = lsp.createConnection(lsp.ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
//let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize(async (params: lsp.InitializeParams) => {
	let capabilities = params.capabilities;
	params.initializationOptions;
	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
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

	let ca: lsp.CodeActionOptions = {};
	const result: lsp.InitializeResult = {
		capabilities: {
			textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: ['.']
			},
			declarationProvider: true,
			hoverProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			documentHighlightProvider: true,
			codeActionProvider: {
				codeActionKinds: [lsp.CodeActionKind.QuickFix]
			},
			//semanticTokensProvider: {
			//	documentSelector: [{ scheme: 'file', language: 'souffle' }],
			//	legend: legend,
			//	//range: true,
			//	full:true
			//},
			codeLensProvider: {resolveProvider: false}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	let wasm = path.join(__dirname, '..', 'tree-sitter-souffle', 'tree-sitter-souffle.wasm');
	await tree_sitter.init();
	try {
		await tree_sitter.Language.load(wasm);
	} catch(e) {
		connection.window.showErrorMessage('error: ' + e);
	}
	let parser = await tree_sitter.Language.load(wasm).then(language => {
    	let parser = new tree_sitter();
    	parser.setLanguage(language);
    	return parser;
	});
	parsers.push(parser);

	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(lsp.DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface SouffleServerSettings {
	rootProjectFile: string;
	transformedRam: string;
	transformedDatalog: string;
	souffleInvocationDir: string;
}

export let rootUri: Uri;
export let transformedRam: Uri;
export let transformedDatalog: Uri;
export let souffleInvocationDir: Uri;

connection.onDidChangeConfiguration(change => {
	let settings: SouffleServerSettings = change.settings.souffleLanguageServer;
	let root_uri = Uri.file(settings.rootProjectFile);
	console.log('## Soufflé root file is ' + root_uri);
	rootUri = root_uri;
	transformedRam = Uri.file(settings.transformedRam);
	transformedDatalog = Uri.file(settings.transformedDatalog);
	souffleInvocationDir = Uri.file(settings.souffleInvocationDir);

	if (root_uri && fs.existsSync(root_uri.fsPath) && !uriToSouffleDocument.has(root_uri.toString())) {
		fs.readFile(root_uri.fsPath,(err, content) => {
			if (err) {
				return;
			}
			let root = new SouffleDocument(connection, root_uri.toString(), 'souffle', -1, content.toString());
			root.parse();
			sleep(1000).then(() => 
				root.validate(true)
			);
		});
	}
});

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('received an file change event');
});

export function sleep(ms = 0) {
	return new Promise(r => setTimeout(r, ms));
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(params: lsp.TextDocumentPositionParams): Promise<lsp.CompletionItem[]> => {
		let uri = params.textDocument.uri.toString();
		let pos = params.position;
		return sleep(100).then(() => {
			let souffleDoc =  uriToSouffleDocument.get(uri);
			if (souffleDoc) {
				return souffleDoc.getCompletion(pos); 
			}
			return Promise.resolve([]); 
		});
	}
);

connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.textDocument.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.textDocument.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
	let uri = params.textDocument.uri.toString();
	let languageId = params.textDocument.languageId;
	let version = params.textDocument.version;
	let text = params.textDocument.text;
	let d = new SouffleDocument(connection, uri, languageId, version, text);
	uriToSouffleDocument.set(uri, d);
	d.parse();
	d.validate();
});

connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
	let uri = params.textDocument.uri.toString();
	//let uri = change.document.uri.toString();
	let d = uriToSouffleDocument.get(uri);
	if (d) {
		d.updateDocument(params);
		d.parse();
		d.validate();
	}
});

connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});

//let handlerServer: RequestHandler<DeclarationParams, Declaration | DeclarationLink[] | undefined | null, Location[] | DeclarationLink[], void>): void {

connection.onDeclaration(
	(params: lsp.DeclarationParams, token: lsp.CancellationToken): lsp.HandlerResult<lsp.LocationLink[], void> => {
		let uri = params.textDocument.uri.toString();
		let pos = params.position;
		let souffleDoc =  uriToSouffleDocument.get(uri);
		if (souffleDoc) {
			return Promise.resolve(souffleDoc.getDeclarations(pos)); 
		}
		return Promise.resolve([]); 
	}
);

connection.onDefinition(
	(params: lsp.DefinitionParams, token: lsp.CancellationToken): lsp.HandlerResult<lsp.LocationLink[] | undefined, void> => {
		let uri = params.textDocument.uri.toString();
		let pos = params.position;
		let souffleDoc =  uriToSouffleDocument.get(uri);
		if (souffleDoc) {
			return Promise.resolve(souffleDoc.getDefinitions(pos)); 
		}
		return Promise.resolve([]); 
	}
);

connection.onReferences(
	(params: lsp.ReferenceParams, token: lsp.CancellationToken): lsp.HandlerResult<lsp.Location[] | undefined, void> => {
		let uri = params.textDocument.uri.toString();
		let pos = params.position;
		let souffleDoc =  uriToSouffleDocument.get(uri);
		if (souffleDoc) {
			return Promise.resolve(souffleDoc.getReferences(pos)); 
		}
		return Promise.resolve([]); 
	}
);

connection.onDocumentHighlight(
	(params: lsp.DocumentHighlightParams, token: lsp.CancellationToken): lsp.HandlerResult<lsp.DocumentHighlight[] | undefined, void> => {
		let uri = params.textDocument.uri.toString();
		let pos = params.position;
		let souffleDoc =  uriToSouffleDocument.get(uri);
		if (souffleDoc) {
			return Promise.resolve(souffleDoc.getDocumentHighlights(pos)); 
		}
		return Promise.resolve(undefined); 
	}
);

connection.onHover(
	(params: lsp.HoverParams, token: lsp.CancellationToken): lsp.HandlerResult<lsp.Hover | null | undefined, void> => {
		let uri = params.textDocument.uri.toString();
		let pos = params.position;
		let souffleDoc =  uriToSouffleDocument.get(uri);
		if (souffleDoc) {
			return Promise.resolve(souffleDoc.getHover(pos)); 
		}
		return Promise.resolve(undefined); 
	}
);

connection.onCodeAction(
	(params: lsp.CodeActionParams, token: lsp.CancellationToken): lsp.HandlerResult<(lsp.Command|lsp.CodeAction)[], void> => {
		let actions: (lsp.Command|lsp.CodeAction)[] = [];
		params.context.diagnostics.forEach(diag => {
			let codeAction: lsp.CodeAction = {
				command: {
					title: 'Set master project file',
					command: 'souffleLanguageServer.selectRoot',
					arguments: [params.textDocument.uri]
				},
				title: 'Update master project file',
				kind: lsp.CodeActionKind.QuickFix,
			};
			actions.push(codeAction);
		});
		return Promise.resolve(actions);
	}
);

connection.onCodeLens(
	(params: lsp.CodeLensParams, token: lsp.CancellationToken): lsp.HandlerResult<(lsp.CodeLens)[], void> => {
		let lenses: lsp.CodeLens[] = [];
		let uri = params.textDocument.uri.toString();
		let souffleDoc =  uriToSouffleDocument.get(uri);
		if (souffleDoc) {
			return Promise.resolve(souffleDoc.getLenses()); 
		}
		return Promise.resolve(lenses);
	}
);

connection.onRequest(lsp.SemanticTokensDeltaRequest.method, () => {console.log('semantic token delta request');});
connection.onRequest(lsp.SemanticTokensRefreshRequest.method, () => {console.log('semantic token refresh request');});
connection.onRequest(lsp.SemanticTokensRegistrationType.method, () => {console.log('semantic token registration request');});
connection.onRequest(lsp.SemanticTokensRangeRequest.method, () => {console.log('semantic token range request');});
connection.onRequest(lsp.SemanticTokensRequest.method, (params: lsp.SemanticTokensParams) => {
	console.log('semantic token request for ' + params.textDocument.uri);
	let souffleDoc =  uriToSouffleDocument.get(params.textDocument.uri);
	if (souffleDoc) {
		return Promise.resolve(souffleDoc.getSemanticTokens()); 
	}
	return Promise.resolve(undefined);
	//connection.sendProgress(lsp.SemanticTokensRequest.type)
});

// Listen on the connection
connection.listen();
