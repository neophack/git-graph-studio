// CodeMirror's syntax colours, mapped to the theme CSS's --syntax-* tokens (each theme
// defines them: Dark+, light Dark+, Monokai, Nord), so the editor pane follows the active
// theme and matches the rest of the workbench.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const syntax = (name: string, fallback: string) => `var(${name}, ${fallback})`;

const highlight = HighlightStyle.define([
	{ tag: [t.keyword, t.modifier, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: syntax('--syntax-keyword', '#569cd6') },
	{ tag: [t.controlKeyword], color: syntax('--syntax-control', '#c586c0') },
	{ tag: [t.string, t.special(t.string), t.character], color: syntax('--syntax-string', '#ce9178') },
	{ tag: [t.regexp], color: syntax('--syntax-regexp', '#d16969') },
	{ tag: [t.escape], color: syntax('--syntax-char', '#d7ba7d') },
	{ tag: [t.number, t.integer, t.float, t.bool, t.atom, t.null], color: syntax('--syntax-number', '#b5cea8') },
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: syntax('--syntax-comment', '#6a9955') },
	{ tag: [t.typeName, t.className, t.namespace, t.macroName], color: syntax('--syntax-type', '#4ec9b0') },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: syntax('--syntax-function', '#dcdcaa') },
	{ tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.attributeName], color: syntax('--syntax-parameter', '#9cdcfe') },
	{ tag: [t.constant(t.variableName), t.constant(t.name)], color: syntax('--syntax-constant', '#4fc1ff') },
	{ tag: [t.operator, t.punctuation, t.separator, t.bracket], color: syntax('--syntax-punctuation', '#d4d4d4') },
	{ tag: [t.tagName], color: syntax('--syntax-keyword', '#569cd6') },
	{ tag: [t.angleBracket], color: syntax('--syntax-angle', '#808080') },
	{ tag: [t.attributeValue], color: syntax('--syntax-string', '#ce9178') },
	{ tag: [t.meta, t.processingInstruction, t.annotation], color: syntax('--syntax-control', '#c586c0') },
	{ tag: [t.heading], color: syntax('--syntax-keyword', '#569cd6'), fontWeight: 'bold' },
	{ tag: [t.emphasis], fontStyle: 'italic' },
	{ tag: [t.strong], fontWeight: 'bold' },
	{ tag: [t.link, t.url], color: 'var(--vscode-textLink-foreground, #4daafc)', textDecoration: 'underline' },
	{ tag: [t.inserted], color: 'var(--vscode-gitDecoration-addedResourceForeground, #89d185)' },
	{ tag: [t.deleted], color: 'var(--vscode-editorError-foreground, #f14c4c)' },
	{ tag: [t.invalid], color: syntax('--syntax-regexp', '#f44747') }
]);

export const vscodeHighlighting: Extension = syntaxHighlighting(highlight);
