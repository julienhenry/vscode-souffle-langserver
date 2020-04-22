/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Range,
	PublishDiagnosticsParams,
	LocationLink,
	Location,
	DeclarationParams,
	RequestHandler,
	DeclarationLink,
	CancellationToken,
	HandlerResult,
	HoverParams,
	Hover,
	DefinitionParams,
	ReferenceParams,
	DocumentHighlightParams,
	DocumentHighlight,
	CodeAction,
	CodeActionOptions,
	CodeActionKind,
	CodeActionParams,
	Command
} from 'vscode-languageserver';

import * as tree_sitter from 'tree-sitter';
const souffle = require('tree-sitter-souffle');
//import * as souffle from 'tree-sitter-souffle';
import * as fs from 'fs';
import { URI as Uri } from 'vscode-uri';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { SouffleDocument, uriToSouffleDocument } from './souffleDocument';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
//let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

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

	let ca: CodeActionOptions = {};
	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
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
				codeActionKinds: [CodeActionKind.QuickFix]
			}
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
interface SouffleServerSettings {
	rootProjectFile: string;
}

connection.onDidChangeConfiguration(change => {
	let settings: SouffleServerSettings = change.settings.souffleLanguageServer;
	let root_uri = Uri.file(settings.rootProjectFile);
	console.log("Soufflé root file is " + root_uri);

	if (root_uri && fs.existsSync(root_uri.fsPath) && !uriToSouffleDocument.has(root_uri.toString())) {
		fs.readFile(root_uri.fsPath,(err, content) => {
			if (err) {
				return;
			}
			let root = new SouffleDocument(connection, root_uri.toString(), "souffle", -1, content.toString());
			root.parse();
			sleep(2000).then(() => 
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
	(params: TextDocumentPositionParams): Promise<CompletionItem[]> => {
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
		d.updateDocument(params)
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
	(params: DeclarationParams, token: CancellationToken): HandlerResult<LocationLink[], void> => {
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
	(params: DefinitionParams, token: CancellationToken): HandlerResult<LocationLink[] | undefined, void> => {
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
	(params: ReferenceParams, token: CancellationToken): HandlerResult<Location[] | undefined, void> => {
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
	(params: DocumentHighlightParams, token: CancellationToken): HandlerResult<DocumentHighlight[] | undefined, void> => {
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
	(params: HoverParams, token: CancellationToken): HandlerResult<Hover | null | undefined, void> => {
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
	(params: CodeActionParams, token: CancellationToken): HandlerResult<(Command|CodeAction)[], void> => {
		let actions: (Command|CodeAction)[] = [];
		params.context.diagnostics.forEach(diag => {
			let command : Command = {
				title: "Set master project file",
				command: "souffleLanguageServer.selectRoot"
			}
			actions.push(command);
		});
		return Promise.resolve(actions); 
	}
);

// Listen on the connection
connection.listen();
