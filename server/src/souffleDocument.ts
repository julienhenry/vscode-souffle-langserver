import * as fs from 'fs';
import * as path from 'path';
import * as tree_sitter from 'web-tree-sitter';
import { CodeLens, Command, Connection, Diagnostic, DiagnosticSeverity, Position, PublishDiagnosticsParams, Range, Location, LocationLink, TextDocumentPositionParams, Hover, MarkupKind, MarkupContent, DocumentHighlight, DocumentHighlightKind, CompletionItem, CompletionItemKind, DidOpenTextDocumentParams, DidChangeTextDocumentParams, TextDocumentContentChangeEvent, SemanticTokensBuilder, SemanticTokens, SemanticTokenTypes, SemanticTokenModifiers } from 'vscode-languageserver/node';
import { URI as Uri } from 'vscode-uri';
import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { rootUri, souffleInvocationDir, transformedDatalog, transformedRam } from './server';

export let parsers: tree_sitter[] = [];

export let uriToSouffleDocument = new Map<string, SouffleDocument>();

enum tokenTypes {
    namespace,
    type,
    class,
    enum,
    interface,
    struct,
    typeParameter,
    parameter,
    variable,
    property,
    enumMember,
    event,
    function,
    method,
    macro,
    keyword,
    modifier,
    comment,
    string,
    number,
    regexp,
    operator
}

enum tokenModifiers {
    declaration,
    definition,
    readonly,
    static,
    deprecated,
    abstract,
    async,
    modification,
    documentation,
    defaultLibrary
}

export const legend = {
	tokenTypes: [
		'namespace',
		'type',
		'class',
		'enum',
		'interface',
		'struct',
		'typeParameter',
		'parameter',
		'variable',
		'property',
		'enumMember',
		'event',
		'function',
		'method',
		'macro',
		'keyword',
		'modifier',
		'comment',
		'string',
		'number',
		'regexp',
		'operator'
	],
	tokenModifiers: [
		'declaration',
		'definition',
		'readonly',
		'static',
		'deprecated',
		'abstract',
		'async',
		'modification',
		'documentation',
		'defaultLibrary'
	]
};

export class SouffleComponent {
	doc: SouffleDocument;
	is_init: boolean;
	name: string;
	node: tree_sitter.SyntaxNode;
	children = new Map<string, SouffleComponent>();
	parent: SouffleComponent | undefined;

	// declarations of relations (i.e. .decl)
	relation_decls = new Map<string, tree_sitter.SyntaxNode>();
	// def and uses of relations in rules:
	relation_defs = new Map<string, tree_sitter.SyntaxNode[]>();
	relation_uses = new Map<string, tree_sitter.SyntaxNode[]>();

	init_comp = new Map<string, SouffleComponent>();

	type_defs = new Map<string, tree_sitter.SyntaxNode>();

	constructor(doc: SouffleDocument, n: string, init: boolean, node: tree_sitter.SyntaxNode) {
		this.doc = doc;
		this.name = n;
		this.is_init = init;
		this.node = node;
		this.parent = undefined;
	}

	clear() {
		this.relation_decls.clear();
		this.relation_defs.clear();
		this.relation_uses.clear();
		this.init_comp.clear();
		this.type_defs.clear();
		this.children.forEach((comp,_) => comp.clear());
		this.children.clear();
	}

	addChild(comp: SouffleComponent) {
		this.children.set(comp.name, comp);
		comp.parent = this;
	}

	instantiate(init_name: string, inst_comp: SouffleComponent) {
		this.init_comp.set(init_name, inst_comp);
	}

	find_decls(identifier: string[]):tree_sitter.SyntaxNode | undefined {
		let head = identifier[0];
		if (identifier.length <= 1) {
			let decls = this.relation_decls.get(head);
			if (decls) {
				return decls;
			} else {
				return undefined;
			}
		} else {
			let comp = this.init_comp.get(head);
			if (comp) {
				return comp.find_decls(identifier.slice(1));
			} else if (this.parent) {
				return this.parent.find_decls(identifier);
			}
		}
	}

	// used for completion, get all declarations starting with some prefix
	get_usable_decls(prefix: string, look_into_alldocuments: boolean): Map<string, tree_sitter.SyntaxNode> {
		let res = new Map<string, tree_sitter.SyntaxNode>();
		this.relation_decls.forEach((value, key) => {
			if (key.startsWith(prefix)) {
				res.set(key, value);
			}
		});
		let splitted = prefix.split('.');
		if (splitted.length > 1) {
			let comp = this.init_comp.get(splitted[0]);
			if (comp) {
				let decls = comp.get_usable_decls(splitted.slice(1).join('.'), false);
				decls.forEach((value, key) => {
					res.set(splitted[0] + '.' + key, value);
				});
			}
		}
		if (look_into_alldocuments) {
			uriToSouffleDocument.forEach((doc, uri) => {
				let decls = doc.globalCtx.get_usable_decls(prefix, false);
				decls.forEach((value, key) => {
					res.set(key, value);
				});
			});
		}
		return res;
	}


	find_defs(identifier: string[]): tree_sitter.SyntaxNode[] {
		let head = identifier[0];
		let defs: tree_sitter.SyntaxNode[] = [];
		if (identifier.length <= 1) {
			let d = this.relation_defs.get(head);
			if (d) {
				defs = defs.concat(d);
			}
		} else {
			// TODO ugly
			let id = identifier.join('.');
			let d = this.relation_defs.get(id);
			if (d) {
				defs = defs.concat(d);
			}
			//
			let comp = this.init_comp.get(head);
			if (comp) {
				defs = defs.concat(comp.find_defs(identifier.slice(1)));
			}
			if (this.parent) {
				return this.parent.find_defs(identifier);
			}
		}
		return defs;
	}

	find_uses(identifier: string[]): tree_sitter.SyntaxNode[] {
		let head = identifier[0];
		let defs: tree_sitter.SyntaxNode[] = [];
		if (identifier.length <= 1) {
			let d = this.relation_uses.get(head);
			if (d) {
				defs = defs.concat(d);
			}
		} else {
			// TODO ugly
			let id = identifier.join('.');
			let d = this.relation_uses.get(id);
			if (d) {
				defs = defs.concat(d);
			}
			//
			let comp = this.init_comp.get(head);
			if (comp) {
				defs = defs.concat(comp.find_uses(identifier.slice(1)));
			}
			if (this.parent) {
				return this.parent.find_uses(identifier);
			}
		}
		return defs;
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
	preprocessor_define: string = '';

	globalCtx: SouffleComponent;

	components_decls = new Map<tree_sitter.SyntaxNode, SouffleComponent>();

	semanticTokens: SemanticTokensBuilder = new SemanticTokensBuilder();

	constructor(connection: Connection, uri: string, languageId: string, version: number, content: string) {
		this.connection = connection;
		let doc = TextDocument.create(uri,languageId,version,content);
		this.tree = parsers[0].parse(doc.getText());
		this.document = doc;
		this.version = version;
		this.tree_version = version;
		uriToSouffleDocument.set(uri, this);
		this.globalCtx = new SouffleComponent(this, '', true, this.tree.rootNode);
	}

	log(str: string) {
		if (false) {console.log(str);}
	}

	getLeafAtPosition(pos: Position, tree: tree_sitter.Tree) {
		let point: tree_sitter.Point = { row: pos.line, column: pos.character };
		return tree.rootNode.descendantForPosition(point);
	}

	setSemanticToken(node: tree_sitter.SyntaxNode, t:tokenTypes, modifiers:tokenModifiers) {
		// TODO push must be called in the order it appears in the file,
		// which is not the case right now
		this.semanticTokens.push(
			node.startPosition.row,
			node.startPosition.column,
			node.endPosition.column - node.startPosition.column,
			t,
			modifiers);
	}

	tokens: {row: number, col:number, length:number, token_types: number, token_modifiers: number}[] = [];

	computeSemanticTokens(node:tree_sitter.SyntaxNode) {
		return; // TODO
		this.semanticTokens = new SemanticTokensBuilder();
		this.tokens = [];
		console.log('compute semantic tokens');
		let rules = node.descendantsOfType('rule_def');
		for (const rule of rules) {
			let args = rule.descendantsOfType('arg');
			for (const arg of args) {
				this.setSemanticToken(arg, tokenTypes.variable, tokenModifiers.readonly);
			}

			let head = node.children[0];
			let body = node.children[2];
			let head_atoms = head.descendantsOfType('atom');
			let body_atoms = body.descendantsOfType('atom');
			for (const atom of head_atoms) {
				let identifier = atom.children[0];
				this.setSemanticToken(identifier, tokenTypes.function, tokenModifiers.definition);
			}
			for (const atom of body_atoms) {
				let identifier = atom.children[0];
				this.setSemanticToken(identifier, tokenTypes.function, tokenModifiers.readonly);
			}
		}

		node.descendantsOfType('fact').forEach(fact => {
			let atom = fact.children[0];
			let identifier = atom.children[0];
			this.setSemanticToken(identifier, tokenTypes.function, tokenModifiers.definition);
		});

		node.descendantsOfType('type').forEach(ty => {
			let ident = ty.children[1];
			this.setSemanticToken(ty.children[0], tokenTypes.keyword, tokenModifiers.definition);
			this.setSemanticToken(ident, tokenTypes.type, tokenModifiers.definition);

		});
	}


	visit(node: tree_sitter.SyntaxNode, ctx: SouffleComponent) {
		if (node.type === 'ERROR' && node.children.find(function (node) { return node.hasError(); }) === undefined) {
			this.syntax_errors.push({node: node, message: 'Syntax Error', severity: DiagnosticSeverity.Error});
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
				this.syntax_errors.push({node: node, message: 'Include file does not exist', severity: DiagnosticSeverity.Error});
			} else if (!uriToSouffleDocument.has(include_uri.toString())) {
				this.log('reading include file: ' + include_uri.fsPath);
				fs.readFile(include_uri.fsPath,(err, content) => {
					if (err) {return;}
					let d = new SouffleDocument(this.connection, include_uri.toString(),'souffle',-1,content.toString());
					d.parse();
				});
			}
		}

		if (node.type === 'relation_decl') {
			let relation_list = node.children[1];
			let decls = relation_list.descendantsOfType('IDENT');
			for (const decl of decls) {
				let name = decl.text;
				ctx.relation_decls.set(name, decl);
			}

			let colons = node.descendantsOfType('COLON');
			for (const colon of colons) {
				let arg_ident = colon.previousSibling;
				let type_identifier = colon.nextSibling;
			}
		}

		if (node.type === 'rule_def') {
			// TODO: USE identifier
			let head = node.children[0];
			let body = node.children[2];
			let head_atoms = head.descendantsOfType('atom');
			let body_atoms = body.descendantsOfType('atom');
			for (const atom of head_atoms) {
				let identifier = atom.children[0];
				let cur = ctx.relation_defs.get(identifier.text);
				if (!cur) {cur = [];}
				cur.push(identifier);
				ctx.relation_defs.set(identifier.text, cur);
			}
			for (const atom of body_atoms) {
				let identifier = atom.children[0];
				let cur = ctx.relation_uses.get(identifier.text);
				if (!cur) {cur = [];}
				cur.push(identifier);
				ctx.relation_uses.set(identifier.text, cur);
			}
		}

		if (node.type === 'fact') {
			// a fact is a definition
			// TODO: USE identifier
			let atom = node.children[0];
			let identifier = atom.children[0];
			let cur = ctx.relation_defs.get(identifier.text);
			if (!cur) {cur = [];}
			cur.push(identifier);
			ctx.relation_defs.set(identifier.text, cur);
		}

		if (node.type === 'INPUT_DECL') {
			// a .input directive is also defining facts
			let io_head = node.parent!;
			let identifiers = io_head.descendantsOfType('identifier');
			// TODO: USE identifier
			for (const identifier of identifiers) {
				if (identifier.parent!.type === 'identifier') {return;}
				let cur = ctx.relation_defs.get(identifier.text);
				if (!cur) {cur = [];}
				cur.push(identifier);
				ctx.relation_defs.set(identifier.text, cur);
			}
		}

		if (node.type === 'define') {
			this.preprocessor_define += ' ' + node.text;
		}

		if (node.type === 'type') {
			let ident = node.children[1];
			ctx.type_defs.set(ident.text, node);
		}

		if (node.type === 'comp_init') {
			let ident = node.children[1];
			let comp_types = node.descendantsOfType('comp_type');
			for (const comp_type of comp_types) {
				let comp_ident = comp_type.children[0];
				let instantiated = ctx.children.get(comp_ident.text);
				if (instantiated)
				{ctx.instantiate(ident.text, instantiated);}
			}
		}

		if (node.type === 'component') {
			// todo update ctx for children
			let component_head = node.children[0];
			let comp_types = node.descendantsOfType('comp_type');
			for (const comp_type of comp_types) {
				let comp_ident = comp_type.children[0];
				let child_ctx = new SouffleComponent(this, comp_ident.text, false, node);
				if (node.childCount > 0) {
					for (let child of node.children) {
						this.visit(child, child_ctx);
					}
				}
				ctx.addChild(child_ctx);
				this.components_decls.set(node, child_ctx);
			}

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
					this.connection.console.log('range NOT in change');
					// TODO
				}
			}
			TextDocument.update(textDocument,contentChanges,version);
			let new_tree = parsers[0].parse(textDocument.getText(), old_tree);
			this.log('updated tree');
			this.tree = new_tree;
			this.tree_version = version;
		}
	}

	parse() {
		this.syntax_errors = [];
		this.semantic_errors = [];
		this.includes = [];
		this.globalCtx.clear();
		this.visit(this.tree.rootNode, this.globalCtx);
	}

	validate(recursive: boolean = false) {
		this.log('validating ' + this.document.uri.toString());
		this.getSemanticErrors();
		let diags: Diagnostic[] = [];
		let errors = this.syntax_errors.concat(this.semantic_errors);
		errors.forEach(error => {
			let d: Diagnostic = {
				range: range(error.node),
				message: error.message,
				severity: error.severity,
				source: 'Souffle language server'
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
					console.log('validating ' + include.toString());
					included.validate(recursive);
				}
			});
		}
	}

	getSemanticErrors() {
		this.semantic_errors = [];
		let all = [this.globalCtx.relation_uses, this.globalCtx.relation_defs];
		all.forEach(map => {
			map.forEach((uses,symbol) => {
				let declared = false;
				uriToSouffleDocument.forEach(souffleDoc => {
					let decl = souffleDoc.globalCtx.find_decls(symbol.split('.'));
					if (decl) {declared = true;}
					if (!declared && souffleDoc.preprocessor_define.includes(symbol)) {
						// silent error if symbol appears in unparsed #define
						declared = true;
					}
				});
				if (!declared) {
					uses.forEach(node => {
						//this.semantic_errors.push({node: node, message: "Use of undeclared relation: " + symbol, severity: DiagnosticSeverity.Error});
					});
				}
			});
		});

		// detect uses of relations that are never defined
		this.globalCtx.relation_uses.forEach((uses,symbol) => {
			let defined = false;
			uriToSouffleDocument.forEach(souffleDoc => {
				let decl = souffleDoc.globalCtx.find_decls(symbol.split('.'));
				if (decl) {defined = true;}
				if (!defined && souffleDoc.preprocessor_define.includes(symbol)) {
					// silent error if symbol appears in unparsed #define
					defined = true;
				}
			});
			if (!defined) {
				uses.forEach(node => {
					//this.semantic_errors.push({node: node, message: "Use of a relation that is always empty: " + symbol, severity: DiagnosticSeverity.Warning});
				});
			}
		});

		// detect rules that use arguments only once
		let rules = this.tree.rootNode.descendantsOfType('rule_def');
		rules.forEach(rule => {
			let args = rule.descendantsOfType('arg');
			let used_idents = new Map<string, tree_sitter.SyntaxNode[]>();
			args.forEach(arg => {
				if (arg.childCount === 1 && arg.children[0].type === 'IDENT') {
					let ident = arg.children[0].text;
					let n = used_idents.get(ident);
					if (!n) {n = [];}
					n.push(arg.children[0]);
					used_idents.set(ident, n);
				}
			});
			used_idents.forEach((nodes, symbol) => {
				if (this.preprocessor_define.includes(symbol)) {return;}
				if (nodes.length <= 1 && !(symbol.startsWith('__') && symbol.endsWith('__'))) {
					this.semantic_errors.push({node: nodes[0], message: 'Symbol ' + symbol + ' is used only once', severity: DiagnosticSeverity.Warning});
				}
			});
		});
	}

	getFullIdentifier(node: tree_sitter.SyntaxNode): tree_sitter.SyntaxNode {
		while (node.type === 'IDENT' && node.parent && node.parent.type === 'identifier') {
			node = node.parent;
		}
		return node;
	}

	getParentComponent(node: tree_sitter.SyntaxNode): SouffleComponent {
		while (node.parent && !this.components_decls.has(node)) {
			node = node.parent;
		}
		let comp = this.components_decls.get(node);
		if (comp)
		{return comp;}
		else
		{return this.globalCtx;}
	}

	getSemanticTokens(): SemanticTokens {
		this.computeSemanticTokens(this.tree.rootNode);
		let tokens = this.semanticTokens.build();
		return tokens;
	}

	getDeclarations(position: Position): LocationLink[] {
		let leaf = this.getLeafAtPosition(position, this.tree);
		leaf = this.getFullIdentifier(leaf);
		let decls: LocationLink[] = [];
		let component = this.getParentComponent(leaf);
		let identifier = leaf.text.split('.');

		let decl = component.find_decls(identifier);
		if (decl) {
			decls = decls.concat(toLocationLinks(this.document.uri,[decl]));
		}

		uriToSouffleDocument.forEach(souffleDoc => {
			if (souffleDoc.document.uri.toString() === this.document.uri.toString()) {return;}
			let decl = souffleDoc.globalCtx.find_decls(identifier);
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
			let uses = souffleDoc.globalCtx.relation_uses.get(symbol);
			if (uses) {
				refs = refs.concat(toLocations(souffleDoc.document.uri,uses));
			}
			let defs = souffleDoc.globalCtx.relation_defs.get(symbol);
			if (defs) {
				refs = refs.concat(toLocations(souffleDoc.document.uri,defs));
			}
		});
		return refs;
	}

	getDefinitions(position: Position): LocationLink[] | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		leaf = this.getFullIdentifier(leaf);
		let component = this.getParentComponent(leaf);
		let identifier = leaf.text.split('.');
		let defs: LocationLink[] = [];

		let def = component.find_defs(identifier);
		if (def) {
			defs = defs.concat(toLocationLinks(this.document.uri,def));
		}

		uriToSouffleDocument.forEach(souffleDoc => {
			if (souffleDoc.document.uri.toString() === this.document.uri.toString()) {return;}
			let def = souffleDoc.globalCtx.find_defs(identifier);
			if (def) {
				defs = defs.concat(toLocationLinks(souffleDoc.document.uri,def));
			}
		});
		return defs;
	}

	getDocumentHighlights(position: Position): DocumentHighlight[] | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		leaf = this.getFullIdentifier(leaf);
		let symbol = leaf.text;
		let highlights: DocumentHighlight[] = [];

		let uses = this.globalCtx.find_uses(symbol.split('.'));
		if (uses) {
			uses.forEach(use => {
				highlights.push(DocumentHighlight.create(range(use), DocumentHighlightKind.Read));
			});
		}
		let defs = this.globalCtx.find_defs(symbol.split('.'));
		if (defs) {
			defs.forEach(def => {
				highlights.push(DocumentHighlight.create(range(def), DocumentHighlightKind.Write));
			});
		}

		// if we want to highlight an arg used in a rule
		let arg = leaf;
		while (arg.type !== 'arg' && arg.parent) {
			arg = arg.parent;
		}
		if (arg.type === 'arg') {
			let symbol = arg.text;
			let rule_def = arg;
			while (rule_def.type !== 'rule_def' && rule_def.parent) {rule_def = rule_def.parent;}
			let args = rule_def.descendantsOfType('arg');
			args.forEach(arg => {
				if (arg.text === symbol) {
					highlights.push(DocumentHighlight.create(range(arg), DocumentHighlightKind.Write));
				}
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
		{--startChar;}
		let endChar = character;
		while (endChar < lineText.length - 1 && !/\s/.test(lineText.charAt(endChar)))
		{++endChar;}
		if (startChar === endChar)
		{return undefined;}
		else
		{return Range.create(position.line, startChar, position.line, endChar);}
	}

	getCompletion(position: Position): Promise<CompletionItem[]> {
		while (this.version !== this.tree_version) {
			this.log('mismatch version: ' + this.version + ' ... ' + this.tree_version);
			break;
		}
		//let symbol = this.document.getText(this.getWordRangeAtPosition(position));

		let leaf = this.getLeafAtPosition(position, this.tree);

		leaf = this.getFullIdentifier(leaf);
		let component = this.getParentComponent(leaf);

		let symbol = leaf.text;
		symbol = symbol.split(/\s/)[0];

		this.log('got Completion request: ' + symbol);
		let items: CompletionItem[] = [];
		component.get_usable_decls(symbol, true).forEach((node,name) => {
			if (name.startsWith(symbol)) {
				while (node && node.type !== 'relation_decl') {
					if (node.parent) {node  = node.parent;}
					else {break;}
				}
				let markup = [];
				markup.push('```souffle');
				markup.push(node.text);
				markup.push('```');
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
		return Promise.resolve(items);
	}

	getHover(position: Position): Hover | undefined {
		let leaf = this.getLeafAtPosition(position, this.tree);
		leaf = this.getFullIdentifier(leaf);
		let component = this.getParentComponent(leaf);

		let symbol = leaf.text;
		let markup = [];
		markup.push('```souffle');

		component.get_usable_decls(leaf.text, true).forEach((decl, sym) => {
			while (decl && decl.type !== 'relation_decl') {
				if (decl.parent) {decl  = decl.parent;}
				else {break;}
			}
			markup.push(decl.text);
		});
		uriToSouffleDocument.forEach(souffleDoc => {
			let type_def = souffleDoc.globalCtx.type_defs.get(symbol);
			if (type_def) {
				markup.push(type_def.text);
			}
		});
		markup.push('```');
		let markdown : MarkupContent = {
			kind: MarkupKind.Markdown,
			value: markup.join('\n')
		};
		if (markup.length <= 2) {return undefined;}
		return { 
			contents: markdown,
			range: {start: {line: leaf.startPosition.row, character: leaf.startPosition.column}, end: {line: leaf.endPosition.row, character: leaf.endPosition.column}}
		};
	}

	parseTransformedDatalog(dl_path:Uri, transformed_path:Uri) {
		let res : Map<number, Location[]> = new Map();
		if (!fs.existsSync(transformed_path.fsPath) || !fs.statSync(transformed_path.fsPath).isFile()) {
			return res;
		}
		let content = fs.readFileSync(transformed_path.fsPath).toString();
		let tree = parsers[0].parse(content);
		let comments = tree.rootNode.descendantsOfType('LOC');
		let regexp = /.loc (?<filename>[^ ]+) \[(?<startline>\d+):(?<startcol>\d+)-(?<endline>\d+):(?<endcol>\d+)\]/g;
		comments.forEach(comment => {
			let m = regexp.exec(comment.text);
			if (!m) {return;}
			let groups = m.groups;
			if (!groups) {return;}
			let resolved = path.resolve(souffleInvocationDir.fsPath, groups.filename);
			if (resolved !== dl_path.fsPath) {return;}
			let rule = comment.parent;
			if (!rule) {return;}
			let desc = rule.descendantsOfType('rule_def');
			if (desc.length <= 0) {return;}
			rule = desc[0];
			if (rule) {
				let rule_range = range(rule);
				let orig_range : Range = {'start': {'line': +groups.startline-1, 'character': +groups.startcol-1}, 'end': {'line': +groups.endline-1, 'character': +groups.endcol-1}};
				let cur = res.get(orig_range.start.line);
				if (!cur) {cur = [];}
				cur.push(Location.create(transformed_path.toString(), rule_range));
				res.set(orig_range.start.line, cur);
			}
		});
		return res;
	}

	parseTransformedRam(dl_path:Uri, transformed_path:Uri) {
		let res : Map<number, Location[]> = new Map();
		if (!fs.existsSync(transformed_path.fsPath) || !fs.statSync(transformed_path.fsPath).isFile()) {
			return res;
		}
		let lines = fs.readFileSync(transformed_path.fsPath).toString().split('\n');
		let regexp = /in file (?<filename>[^ ]+) \[(?<startline>\d+):(?<startcol>\d+)-(?<endline>\d+):(?<endcol>\d+)\]/g;
		lines.forEach((line, index) => {
			let m = regexp.exec(line);
			if (!m) {return;}
			let groups = m.groups;
			if (!groups) {return;}
			let resolved = path.resolve(souffleInvocationDir.fsPath, groups.filename);
			if (resolved !== dl_path.fsPath) {return;}
			let cur = res.get(+groups.startline-1);
			if (!cur) {cur = [];}
			cur.push(Location.create(transformed_path.toString(), Range.create(Position.create(index,0), Position.create(index, line.length-1))));
			res.set(+groups.startline-1, cur);
		});
		return res;
	}

	getLenses(): CodeLens[] {
		let res = this.parseTransformedDatalog(Uri.parse(this.document.uri), transformedDatalog);
		let ram_res = this.parseTransformedRam(Uri.parse(this.document.uri), transformedRam);
		let rules = this.tree.rootNode.descendantsOfType('rule_def');
		let lenses: CodeLens[] = [];
		rules.forEach(rule => {
			let r = range(rule);
			let transformed_dl_ranges = res.get(r.start.line);
			if (transformed_dl_ranges) {
				let lens = CodeLens.create(r);
				lens.command = Command.create('Datalog', 'peek',
					this.document.uri,
					r.start,
					transformed_dl_ranges,
					'peek'
				);
				lenses.push(lens);
			}
			let transformed_ram_ranges = ram_res.get(r.start.line);
			if (transformed_ram_ranges) {
				let lens = CodeLens.create(r);
				lens.command = Command.create('RAM', 'peek',
					this.document.uri,
					r.start,
					transformed_ram_ranges,
					'peek'
				);
				lenses.push(lens);
			}
		});
		return lenses;
	}
}

function range(root: tree_sitter.SyntaxNode): Range {
	return {
		'start': { 'line': root.startPosition.row, 'character': root.startPosition.column },
		'end': { 'line': root.endPosition.row, 'character': root.endPosition.column }
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
