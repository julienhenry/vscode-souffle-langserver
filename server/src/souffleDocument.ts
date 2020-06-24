import * as fs from 'fs';
import * as path from 'path';
import * as tree_sitter from 'web-tree-sitter';
import { Connection, Diagnostic, DiagnosticSeverity, Position, PublishDiagnosticsParams, Range, Location, LocationLink, TextDocumentPositionParams, Hover, MarkupKind, MarkupContent, DocumentHighlight, DocumentHighlightKind, CompletionItem, CompletionItemKind, DidOpenTextDocumentParams, DidChangeTextDocumentParams, TextDocumentContentChangeEvent } from 'vscode-languageserver';
import { URI as Uri } from 'vscode-uri';
import {
	TextDocument
} from 'vscode-languageserver-textdocument';

export let parsers: tree_sitter[] = [];

export let uriToSouffleDocument = new Map<string, SouffleDocument>();

export class SouffleContext {
	// current components in which the parsing is currently located
	components: { name: string, node: tree_sitter.SyntaxNode }[] = [];

	constructor() {
	}

	enter_component(ident_node: tree_sitter.SyntaxNode, comp_type_node: tree_sitter.SyntaxNode) {
		this.components.push({ name: ident_node.text, node: comp_type_node });
	}

	exit_component() {
		this.components.pop();
	}

	prefix(): string {
		let prefix = "";
		this.components.forEach(component => {
			if (prefix.length > 0) {
				prefix += ".";
			}
			prefix += component.name
		});
		return prefix;
	}
}

export class SouffleDocument {
	connection: Connection;

	tree: tree_sitter.Tree;
	tree_version: number;
	document: TextDocument;
	version: number;

	includes: Uri[] = [];
	syntax_errors: {node: tree_sitter.SyntaxNode, message: string, severity: DiagnosticSeverity}[] = [];
	semantic_errors: {node: tree_sitter.SyntaxNode, message: string, severity: DiagnosticSeverity}[] = [];
	// #define preprocessor directives that are currently not parsed correctly
	preprocessor_define: string = "";

	// declarations of relations (i.e. .decl)
	relation_decls = new Map<string, tree_sitter.SyntaxNode>();

	// def and uses of relations in rules:
	relation_defs = new Map<string, tree_sitter.SyntaxNode[]>();
	relation_uses = new Map<string, tree_sitter.SyntaxNode[]>();

	type_defs = new Map<string, tree_sitter.SyntaxNode>();

	constructor(connection: Connection, uri: string, languageId: string, version: number, content: string) {
		this.connection = connection;
		let doc = TextDocument.create(uri,languageId,version,content);
		this.tree = parsers[0].parse(doc.getText());
		this.document = doc;
		this.version = version;
		this.tree_version = version;
		uriToSouffleDocument.set(uri, this);
	}

	log(str: string) {
		if (false) console.log(str);
	}

	getLeafAtPosition(pos: Position, tree: tree_sitter.Tree) {
		let point: tree_sitter.Point = { row: pos.line, column: pos.character };
		return tree.rootNode.descendantForPosition(point);
	}

	visit(node: tree_sitter.SyntaxNode, ctx: SouffleContext) {
		if (node.type === 'ERROR' && node.children.find(function (node) { return node.hasError(); }) === undefined) {
			this.syntax_errors.push({node: node, message: "Syntax Error", severity: DiagnosticSeverity.Error});
		}

		if (node.type === 'filename') {
			let include_path = node.text;
			let doc_uri = Uri.parse(this.document.uri);
			//if (!path.isAbsolute(include_uri.fsPath)) {
			let include_uri: Uri;
			if (path.isAbsolute(include_path)) {
				include_uri = Uri.file(include_path);
			} else {
				include_uri = Uri.file(path.join(path.dirname(doc_uri.fsPath), include_path));
			}
			this.includes.push(include_uri);
			if (!fs.existsSync(include_uri.fsPath)) {
				this.syntax_errors.push({node: node, message: "Include file does not exist", severity: DiagnosticSeverity.Error});
			} else if (!uriToSouffleDocument.has(include_uri.toString())) {
				this.log("reading include file: " + include_uri.fsPath);
				fs.readFile(include_uri.fsPath,(err, content) => {
					if (err) {return;}
					let d = new SouffleDocument(this.connection, include_uri.toString(),"souffle",-1,content.toString());
					d.parse();
				});
			}
		}

		if (node.type === 'relation_decl') {
			let relation_list = node.children[1];
			let decls = relation_list.descendantsOfType("IDENT")
			decls.forEach(decl => {
				let name = ctx.prefix() + decl.text;
				this.relation_decls.set(name, decl);
			})

			let colons = node.descendantsOfType("COLON");
			colons.forEach(colon => {
				let arg_ident = colon.previousSibling;
				let type_identifier = colon.nextSibling;
			});
		}

		if (node.type === 'rule_def') {
			let head = node.children[0];
			let body = node.children[2];
			let head_atoms = head.descendantsOfType("atom");
			let body_atoms = body.descendantsOfType("atom");
			head_atoms.forEach(atom => {
				let identifier = atom.children[0];
				let cur = this.relation_defs.get(identifier.text);
				if (!cur) cur = [];
				cur.push(identifier);
				this.relation_defs.set(identifier.text, cur);
			});
			body_atoms.forEach(atom => {
				let identifier = atom.children[0];
				let cur = this.relation_uses.get(identifier.text);
				if (!cur) cur = [];
				cur.push(identifier);
				this.relation_uses.set(identifier.text, cur);
			});
		}

		if (node.type === 'fact') {
			// a fact is a definition
			let atom = node.children[0];
			let identifier = atom.children[0];
			let cur = this.relation_defs.get(identifier.text);
			if (!cur) cur = [];
			cur.push(identifier);
			this.relation_defs.set(identifier.text, cur);
		}

		if (node.type === 'INPUT_DECL') {
			// a .input directive is also defining facts
			let io_head = node.parent!;
			let identifiers = io_head.descendantsOfType("identifier");
			identifiers.forEach(identifier => {
				let cur = this.relation_defs.get(identifier.text);
				if (!cur) cur = [];
				cur.push(identifier);
				this.relation_defs.set(identifier.text, cur);
			});
		}

		if (node.type === 'define') {
			this.preprocessor_define += " " + node.text;
		}

		if (node.type === 'type') {
			let ident = node.children[1];
			this.type_defs.set(ident.text, node);
		}

		if (node.type === 'component') {
			// todo update ctx for children
			let component_head = node.children[0];
			let comp_types = node.descendantsOfType("comp_type");
			comp_types.forEach(comp_type => {
				let comp_ident = comp_type.children[0];
				ctx.enter_component(comp_ident, comp_type);
				if (node.childCount > 0) {
					for (let child of node.children) {
						this.visit(child, ctx);
					}
				}
				ctx.exit_component();
			});

		} else {
			if (node.childCount > 0) {
				for (let child of node.children) {
					this.visit(child, ctx);
				}
			}
		}
	}

	updateDocument(change: DidChangeTextDocumentParams) {
		let version = change.textDocument.version ? change.textDocument.version : (this.version+1);
		this.version = version;
		let textDocument = this.document;
		let contentChanges: TextDocumentContentChangeEvent[] = change.contentChanges;
		if (textDocument.languageId !== 'souffle') {
			return;
		}
		function asPoint(pos: Position): tree_sitter.Point {
			return { row: pos.line, column: pos.character };
		}

		if (contentChanges.length !== 0) {
			let old_tree = this.tree;
			for (let change of contentChanges) {
				if ('range' in change) {
					let range = change.range;
					let rangeLength = change.rangeLength ? change.rangeLength : 0;
					let startIndex = textDocument.offsetAt(range.start);
					let oldEndIndex = startIndex + rangeLength;
					let newEndIndex = startIndex + change.text.length;
					let startPos = textDocument.positionAt(startIndex);
					let oldEndPos = textDocument.positionAt(oldEndIndex);
					let newEndPos = textDocument.positionAt(newEndIndex);
					let startPosition = asPoint(startPos);
					let oldEndPosition = asPoint(oldEndPos);
					let newEndPosition = asPoint(newEndPos);
					let delta = { startIndex, oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition };
					old_tree.edit(delta);
				} else {
					this.connection.console.log("range NOT in change");
					// TODO
				}
			}
			TextDocument.update(textDocument,contentChanges,version);
			let new_tree = parsers[0].parse(textDocument.getText(), old_tree);
			this.log("updated tree");
			this.tree = new_tree;
			this.tree_version = version;
		}
	}

	parse() {
		this.syntax_errors = [];
		this.semantic_errors = [];
		this.includes = [];
		this.relation_decls.clear();
		this.relation_defs.clear();
		this.relation_uses.clear();
		let ctx = new SouffleContext();
		this.visit(this.tree.rootNode, ctx);
	}

	validate(recursive: boolean = false) {
		this.log("validating " + this.document.uri.toString());
		this.getSemanticErrors();
		let diags: Diagnostic[] = [];
		let errors = this.syntax_errors.concat(this.semantic_errors)
		errors.forEach(error => {
			let d: Diagnostic = {
				range: range(error.node),
				message: error.message,
				severity: error.severity,
				source: "Souffle language server"
			};
			diags.push(d);
		});

		let diagnostics: PublishDiagnosticsParams = {
			uri: this.document.uri,
			diagnostics: diags
		};
		this.connection.sendDiagnostics(diagnostics);

		if (recursive) {
			this.includes.forEach(include => {
				let included = uriToSouffleDocument.get(include.toString());
				if (included) {
					console.log("validating " + include.toString());
					included.validate(recursive);
				}
			});
		}
	}

	getSemanticErrors() {
		this.semantic_errors = [];
		let all = [this.relation_uses, this.relation_defs];
		all.forEach(map => {
			map.forEach((uses,symbol) => {
				let declared = false;
				uriToSouffleDocument.forEach(souffleDoc => {
					let decl = souffleDoc.relation_decls.get(symbol);
					if (decl) {declared = true;}
					if (!declared && souffleDoc.preprocessor_define.includes(symbol)) {
						// silent error if symbol appears in unparsed #define
						declared = true;
					}
				});
				if (!declared) {
					uses.forEach(node => {
						this.semantic_errors.push({node: node, message: "Use of undeclared relation: " + symbol, severity: DiagnosticSeverity.Error});
					});
				}
			});
		});

		// detect uses of relations that are never defined
		this.relation_uses.forEach((uses,symbol) => {
			let defined = false;
			uriToSouffleDocument.forEach(souffleDoc => {
				let decl = souffleDoc.relation_defs.get(symbol);
				if (decl) {defined = true;}
				if (!defined && souffleDoc.preprocessor_define.includes(symbol)) {
					// silent error if symbol appears in unparsed #define
					defined = true;
				}
			});
			if (!defined) {
				uses.forEach(node => {
					this.semantic_errors.push({node: node, message: "Use of a relation that is always empty: " + symbol, severity: DiagnosticSeverity.Warning});
				});
			}
		});

		// detect rules that use arguments only once
		let rules = this.tree.rootNode.descendantsOfType('rule_def')
		rules.forEach(rule => {
			let args = rule.descendantsOfType('arg')
			let used_idents = new Map<string, tree_sitter.SyntaxNode[]>();
			args.forEach(arg => {
				if (arg.childCount === 1 && arg.children[0].type === 'IDENT') {
					let ident = arg.children[0].text;
					let n = used_idents.get(ident);
					if (!n) {n = [];}
					n.push(arg.children[0])
					used_idents.set(ident, n);
				}
			});
			used_idents.forEach((nodes, symbol) => {
				if (this.preprocessor_define.includes(symbol)) {return;}
				if (nodes.length <= 1 && !(symbol.startsWith("__") && symbol.endsWith("__"))) {
					this.semantic_errors.push({node: nodes[0], message: "Symbol " + symbol + " is used only once", severity: DiagnosticSeverity.Warning})
				}
			})
		});
	}

	getDeclarations(position: Position): LocationLink[] {
		let leaf = this.getLeafAtPosition(position, this.tree);
		let symbol = leaf.text;
		let decls: LocationLink[] = [];
		this.log("getDeclarations for " + symbol);
		uriToSouffleDocument.forEach(souffleDoc => {
			let decl = souffleDoc.relation_decls.get(symbol);
			if (decl) {
				decls = decls.concat(toLocationLinks(souffleDoc.document.uri,[decl]));
			}
		});
		return decls;
	}

	getReferences(position: Position): Location[] | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		let symbol = leaf.text;
		let refs: Location[] = [];
		uriToSouffleDocument.forEach(souffleDoc => {
			let uses = souffleDoc.relation_uses.get(symbol);
			if (uses) {
				refs = refs.concat(toLocations(souffleDoc.document.uri,uses));
			}
			let defs = souffleDoc.relation_defs.get(symbol);
			if (defs) {
				refs = refs.concat(toLocations(souffleDoc.document.uri,defs));
			}
		});
		return refs;
	}

	getDefinitions(position: Position): LocationLink[] | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		let symbol = leaf.text;
		let defs: LocationLink[] = [];
		uriToSouffleDocument.forEach(souffleDoc => {
			let def = souffleDoc.relation_defs.get(symbol);
			if (def) {
				defs = defs.concat(toLocationLinks(souffleDoc.document.uri,def));
			}
		});
		return defs;
	}

	getDocumentHighlights(position: Position): DocumentHighlight[] | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		let symbol = leaf.text;
		let highlights: DocumentHighlight[] = [];

		let uses = this.relation_uses.get(symbol);
		if (uses) {
			uses.forEach(use => {
				highlights.push(DocumentHighlight.create(range(use), DocumentHighlightKind.Read));
			});
		}
		let defs = this.relation_defs.get(symbol);
		if (defs) {
			defs.forEach(def => {
				highlights.push(DocumentHighlight.create(range(def), DocumentHighlightKind.Write));
			});
		}
		return highlights;
	}

	getWordRangeAtPosition(position: Position): Range |  undefined {
		const lineText = this.document.getText({
			start: {line: position.line, character: 0}, 
			end: {line: position.line, character: 1000}
		});
		const character = Math.min(lineText.length - 1, Math.max(0, position.character));
		let startChar = character;
		while (startChar > 0 && !/\s/.test(lineText.charAt(startChar - 1)))
			--startChar;
		let endChar = character;
		while (endChar < lineText.length - 1 && !/\s/.test(lineText.charAt(endChar)))
			++endChar;
		if (startChar === endChar)
			return undefined;
		else
			return Range.create(position.line, startChar, position.line, endChar);
	}

	getCompletion(position: Position): Promise<CompletionItem[]> {
		while (this.version != this.tree_version) {
			this.log("mismatch version: " + this.version + " ... " + this.tree_version);
			break;
		}
		//let symbol = this.document.getText(this.getWordRangeAtPosition(position));

		let leaf = this.getLeafAtPosition(position, this.tree);
		let symbol = leaf.text;
		symbol = symbol.split(/\s/)[0];

		this.log("got Completion request: " + symbol);
		let items: CompletionItem[] = [];
		uriToSouffleDocument.forEach(souffleDoc => {
			souffleDoc.relation_decls.forEach((node,name) => {
				if (name.includes("next_instruction")) {
					this.log("name: " + name);
				}
				if (name.startsWith(symbol)) {
					while (node && node.type !== 'relation_decl') {
						if (node.parent) node  = node.parent;
						else break;
					}
					let markup = [];
					markup.push("```souffle");
					markup.push(node.text);
					markup.push("```");
					let markdown : MarkupContent = {
						kind: MarkupKind.Markdown,
						value: markup.join('\n')
					};
					items.push({
						label: name,
						kind: CompletionItemKind.Function,
						documentation: markdown,
						//detail: node.text,
						data: 1,
					});
				}
			});
		});
		return Promise.resolve(items);
	}

	getHover(position: Position): Hover | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		let symbol = leaf.text;
		let markup = [];
		markup.push("```souffle");
		uriToSouffleDocument.forEach(souffleDoc => {
			let decl = souffleDoc.relation_decls.get(symbol);
			if (decl) {
				while (decl && decl.type !== 'relation_decl') {
					if (decl.parent) decl  = decl.parent;
					else break;
				}
				markup.push(decl.text);
			}
			let type_def = souffleDoc.type_defs.get(symbol);
			if (type_def) {
				markup.push(type_def.text);
			}
		});
		markup.push("```");
		let markdown : MarkupContent = {
			kind: MarkupKind.Markdown,
			value: markup.join('\n')
		};
		if (markup.length <= 2) return undefined;
		return { 
			contents: markdown,
			range: {start: {line: leaf.startPosition.row, character: leaf.startPosition.column}, end: {line: leaf.endPosition.row, character: leaf.endPosition.column}}
		};
	}

}

function range(root: tree_sitter.SyntaxNode): Range {
	return {
		"start": { "line": root.startPosition.row, "character": root.startPosition.column },
		"end": { "line": root.endPosition.row, "character": root.endPosition.column }
	};
}

export function toLocationLinks(uri: string, nodes: tree_sitter.SyntaxNode[]): LocationLink[] {
	let locs: LocationLink[] = [];
	for (let root of nodes) {
		let symbol = root.text;
		let r = range(root);
		let loc: LocationLink = {
			targetUri: uri,
			targetRange: r,
			targetSelectionRange: r,
		};
		locs.push(loc);
	}
	return locs;
}

function toLocations(uri: string, nodes: tree_sitter.SyntaxNode[]):Location[] {
	let locs: Location[] = [];
	for (let root of nodes) {
		let symbol = root.text;
		let r = range(root);
		let loc: Location = {
			uri: uri,
			range: r
		};
		locs.push(loc);
	}
	return locs;
}
