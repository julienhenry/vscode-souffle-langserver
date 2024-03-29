/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as vscode from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	Position,
	Location,
	Range
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
	// The server is implemented in node
	let serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);
	// The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	console.log('Activating souffle-langserver ' + serverModule);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'souffle' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc'),
			configurationSection: 'souffleLanguageServer'
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'souffle-langserver',
		'Soufflé language server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
	console.log(`Activating souffle-langserver done`);
	context.subscriptions.push(vscode.commands.registerCommand('souffleLanguageServer.selectRoot', (defaultUri: string) => {
		vscode.window.showOpenDialog(
			{canSelectFolders: false, canSelectMany: false, defaultUri: vscode.Uri.parse(defaultUri)}
		).then(uris => {
			uris.forEach(uri => {
				vscode.window.showInformationMessage('setting new root to ' + uri.fsPath);
				vscode.workspace.getConfiguration().update('souffleLanguageServer.rootProjectFile', uri.fsPath);
			});
		});
	}));

	function convertPosition(pos:Position): vscode.Position {
		return new vscode.Position(pos.line, pos.character);
	}

	function convertRange(range:Range): vscode.Range {
		return new vscode.Range(convertPosition(range.start), convertPosition(range.end));
	}

	function convertLocation(loc:Location): vscode.Location {
		return new vscode.Location(vscode.Uri.parse(loc.uri), convertRange(loc.range));
	}

	context.subscriptions.push(vscode.commands.registerCommand('peek', (uri_str: string, pos:Position, locs:Location[], kind:string) => {
		let p = convertPosition(pos);
		let uri = vscode.Uri.parse(uri_str);
		let l = [];
		locs.forEach(loc => {
			l.push(convertLocation(loc));
		});
		vscode.commands.executeCommand('editor.action.peekLocations',
			uri,
			p,
			l,
			kind
		).then(ok => {}, ko => {vscode.window.showErrorMessage('error ' + ko);});
	}));

}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
