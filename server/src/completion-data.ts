import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';
import { ForgeDialect } from './source-context';

interface ForgeCompletionData {
    label: string;
    kind: CompletionItemKind;
    detail?: string;
    documentation?: string;
    insertText?: string;
    insertTextFormat?: InsertTextFormat;
}

const forgeKeywords: ForgeCompletionData[] = [
    { label: 'func', kind: CompletionItemKind.Keyword, detail: 'Total function field', documentation: 'Exactly one result for each input' },
    { label: 'pfunc', kind: CompletionItemKind.Keyword, detail: 'Partial function field', documentation: 'At most one result for each input' },
    { label: 'Int', kind: CompletionItemKind.Class, detail: 'Built-in integer signature' },
    { label: 'releases', kind: CompletionItemKind.Keyword, detail: 'Temporal release' },
    { label: 'before', kind: CompletionItemKind.Keyword, detail: 'Previous state' },
    { label: 'once', kind: CompletionItemKind.Keyword, detail: 'True in some past state' },
    { label: 'historically', kind: CompletionItemKind.Keyword, detail: 'True in all past states' },
    { label: 'since', kind: CompletionItemKind.Keyword, detail: 'Temporal since' },
    { label: 'triggered', kind: CompletionItemKind.Keyword, detail: 'Temporal triggered' },

    // Core keywords
    { label: 'sig', kind: CompletionItemKind.Keyword, detail: 'Signature declaration', documentation: 'Define a signature (type)' },
    { label: 'pred', kind: CompletionItemKind.Keyword, detail: 'Predicate declaration', documentation: 'Define a predicate (constraint)' },
    { label: 'fun', kind: CompletionItemKind.Keyword, detail: 'Function declaration', documentation: 'Define a function returning a value' },
    { label: 'assert', kind: CompletionItemKind.Keyword, detail: 'Assertion', documentation: 'Define an assertion to check' },
    { label: 'test', kind: CompletionItemKind.Keyword, detail: 'Test declaration', documentation: 'Define a test or test suite' },
    { label: 'expect', kind: CompletionItemKind.Keyword, detail: 'Test expectation block', documentation: 'Group test expectations' },
    { label: 'run', kind: CompletionItemKind.Keyword, detail: 'Run command', documentation: 'Find instances satisfying a predicate' },
    { label: 'check', kind: CompletionItemKind.Keyword, detail: 'Check command', documentation: 'Verify no counterexamples exist' },
    { label: 'example', kind: CompletionItemKind.Keyword, detail: 'Example instance', documentation: 'Define a concrete example instance' },
    { label: 'inst', kind: CompletionItemKind.Keyword, detail: 'Instance bounds', documentation: 'Define partial instance bounds' },

    // Multiplicity/quantifiers
    { label: 'all', kind: CompletionItemKind.Keyword, detail: 'Universal quantifier', documentation: 'For all elements...' },
    { label: 'some', kind: CompletionItemKind.Keyword, detail: 'Existential quantifier', documentation: 'There exists at least one...' },
    { label: 'no', kind: CompletionItemKind.Keyword, detail: 'No quantifier', documentation: 'There are no...' },
    { label: 'lone', kind: CompletionItemKind.Keyword, detail: 'At most one', documentation: 'Zero or one element' },
    { label: 'one', kind: CompletionItemKind.Keyword, detail: 'Exactly one', documentation: 'Exactly one element' },
    { label: 'set', kind: CompletionItemKind.Keyword, detail: 'Set multiplicity', documentation: 'Any number of elements (default)' },

    // Logical operators
    { label: 'and', kind: CompletionItemKind.Keyword, detail: 'Logical AND', documentation: 'Both conditions must be true' },
    { label: 'or', kind: CompletionItemKind.Keyword, detail: 'Logical OR', documentation: 'At least one condition must be true' },
    { label: 'not', kind: CompletionItemKind.Keyword, detail: 'Logical NOT', documentation: 'Negate a condition' },
    { label: 'implies', kind: CompletionItemKind.Keyword, detail: 'Implication', documentation: 'If-then logical implication' },
    { label: 'iff', kind: CompletionItemKind.Keyword, detail: 'Bi-implication', documentation: 'If and only if' },
    { label: 'else', kind: CompletionItemKind.Keyword, detail: 'Else clause', documentation: 'Alternative for implies' },

    // Signature modifiers
    { label: 'abstract', kind: CompletionItemKind.Keyword, detail: 'Abstract signature', documentation: 'Signature with no direct instances' },
    { label: 'extends', kind: CompletionItemKind.Keyword, detail: 'Signature extension', documentation: 'Extend a parent signature' },
    { label: 'in', kind: CompletionItemKind.Keyword, detail: 'Subset relation', documentation: 'Subset of another signature' },
    { label: 'var', kind: CompletionItemKind.Keyword, detail: 'Variable field/sig', documentation: 'Value can change over time' },
    { label: 'disj', kind: CompletionItemKind.Keyword, detail: 'Disjoint declaration', documentation: 'Declare disjoint variables' },

    // Temporal operators
    { label: 'always', kind: CompletionItemKind.Keyword, detail: 'Always (temporal)', documentation: 'True in all future states' },
    { label: 'eventually', kind: CompletionItemKind.Keyword, detail: 'Eventually (temporal)', documentation: 'True in some future state' },
    { label: 'after', kind: CompletionItemKind.Keyword, detail: 'After (temporal)', documentation: 'True in the next state' },
    { label: 'until', kind: CompletionItemKind.Keyword, detail: 'Until (temporal)', documentation: 'P until Q holds' },

    // Test/assertion keywords
    { label: 'is', kind: CompletionItemKind.Keyword, detail: 'Test expectation', documentation: 'Specify expected result' },
    { label: 'sat', kind: CompletionItemKind.Keyword, detail: 'Satisfiable', documentation: 'Expect satisfiable result' },
    { label: 'unsat', kind: CompletionItemKind.Keyword, detail: 'Unsatisfiable', documentation: 'Expect unsatisfiable result' },
    { label: 'theorem', kind: CompletionItemKind.Keyword, detail: 'Theorem expectation', documentation: 'Expect to prove as theorem' },

    // Other
    { label: 'for', kind: CompletionItemKind.Keyword, detail: 'Scope bounds', documentation: 'Specify scope for run/check' },
    { label: 'but', kind: CompletionItemKind.Keyword, detail: 'Scope exception', documentation: 'Override specific bounds' },
    { label: 'exactly', kind: CompletionItemKind.Keyword, detail: 'Exact bound', documentation: 'Exactly this many instances' },
    { label: 'let', kind: CompletionItemKind.Keyword, detail: 'Let binding', documentation: 'Introduce local binding' },
    { label: 'open', kind: CompletionItemKind.Keyword, detail: 'Import module', documentation: 'Import another Forge file' },
    { label: 'option', kind: CompletionItemKind.Keyword, detail: 'Set option', documentation: 'Configure Forge options' },

    // Built-in relations
    { label: 'none', kind: CompletionItemKind.Constant, detail: 'Empty set', documentation: 'The empty set' },
    { label: 'univ', kind: CompletionItemKind.Constant, detail: 'Universal set', documentation: 'Set of all atoms' },
    { label: 'iden', kind: CompletionItemKind.Constant, detail: 'Identity relation', documentation: 'Identity relation on atoms' },
];

const forgeSnippets: ForgeCompletionData[] = [
    {
        label: 'sig (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Signature declaration',
        documentation: 'Create a new signature with fields',
        insertText: 'sig ${1:Name} {\n\t${2:// fields}\n}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'abstract sig (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Abstract signature',
        documentation: 'Create an abstract signature',
        insertText: 'abstract sig ${1:Name} {\n\t${2:// fields}\n}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'pred (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Predicate declaration',
        documentation: 'Create a new predicate',
        insertText: 'pred ${1:name}[${2:params}] {\n\t${3:// constraints}\n}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'fun (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Function declaration',
        documentation: 'Create a new function',
        insertText: 'fun ${1:name}[${2:params}]: ${3:Type} {\n\t${4:// expression}\n}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'run (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Run command',
        documentation: 'Run a predicate to find instances',
        insertText: 'run {\n\t${1:// constraints}\n} for ${2:5} ${3:// scope}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'check (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Check command',
        documentation: 'Check that a property always holds',
        insertText: 'check {\n\t${1:// assertion}\n} for ${2:5} ${3:// scope}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'test expect (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Test expect block',
        documentation: 'Create a test expectation block',
        insertText: 'test expect ${1:testName} {\n\t${2:testCase}: {\n\t\t${3:// constraints}\n\t} for ${4:5} is ${5:sat}\n}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'all (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Universal quantifier',
        documentation: 'For all elements satisfying...',
        insertText: 'all ${1:x}: ${2:Type} | ${3:constraint}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
    {
        label: 'some (snippet)',
        kind: CompletionItemKind.Snippet,
        detail: 'Existential quantifier',
        documentation: 'There exists some element...',
        insertText: 'some ${1:x}: ${2:Type} | ${3:constraint}',
        insertTextFormat: InsertTextFormat.Snippet,
    },
];

const temporalKeywords = new Set(['var', 'always', 'eventually', 'after', 'until', 'releases', 'before', 'once', 'historically', 'since', 'triggered']);

/** Unknown/incomplete language headers retain the common relational vocabulary. */
export function staticCompletions(dialect: ForgeDialect): CompletionItem[] {
    return [...forgeKeywords, ...forgeSnippets]
        .filter(item => (!temporalKeywords.has(item.label) || dialect === 'temporal') &&
            !(dialect === 'froglet' && ['set', 'univ', 'iden'].includes(item.label)))
        .map(item => ({ ...item, sortText: `${item.kind === CompletionItemKind.Snippet ? 3 : 4}_${item.label}` }));
}
