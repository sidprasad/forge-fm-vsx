# Forge VSCode Extension


VS Code support for [Forge](https://forge-fm.org/).

## Highlights

- Run Forge files with robust process management (Racket discovery, version checks, graceful stop).
- Model-aware completion, signature help, hover, go to definition, and document symbols.
- Keywords matched to `#lang forge/froglet`, `#lang forge`, or `#lang forge/temporal`, plus 9 snippets.
- Syntax highlighting and language configuration for `.frg`.

## Quick start

1. Install Racket and Forge: `raco pkg install forge`
2. Install the extension from the 
3. Open a `.frg` file and run `Forge: Run` (or click the Run button).

## Code Completion

Use **Trigger Suggest** in the Command Palette (or your configured completion shortcut) to see names from the current model:

- Signatures, fields, predicates, and functions, with declaration details and doc comments.
- Parameters, quantified variables, comprehension variables, and `let` bindings that are visible at the cursor. Inner bindings take priority over outer names.
- Fields after a dot, plus common declaration and quantifier snippets elsewhere.
- Language-specific keywords: temporal operators and `var` appear for `#lang forge/temporal`; Froglet omits relational constructs such as `set`, `univ`, and `iden`.

Typing `[` or `,` in a predicate/function call shows its signature and highlights the active parameter. Nested calls are handled separately. Hover and **Go to Definition** also work for parameters and local bindings.

Quoted file imports such as `open "shared.frg"` contribute declarations to completion, signature help, hover, and navigation, even when the imported file is closed. Unsaved imported files take precedence over disk contents. Go to Definition on the quoted path opens the file. Forge aliases are direct prefixes: `open "shared.frg" as other` exposes a signature `Node` as `otherNode`.

These features use the editor's syntax parser and tolerate incomplete code. Field suggestions are not filtered by receiver type, and Racket library imports such as `open util/...` are not indexed. Completion skips comments and strings; Racket continues to provide syntax checking.

### Language feature tests

Run `npm run test:language` after installing dependencies. The suite covers model scopes, dialects, incomplete edits, file imports, and actual language-server requests over IPC. The IPC tests stub only the Racket diagnostics process, so they do not require Racket or a VS Code window.

## Commands & keyboard shortcuts

All commands live in the Command Palette under the **Forge** category. The keyboard shortcuts below apply while editing a Forge (`.frg`) file.

| Command | Mac | Windows / Linux | Description |
| --- | --- | --- | --- |
| `Forge: Run` | `Cmd+Alt+N` | `Ctrl+Alt+N` | Run the active Forge file |
| `Forge: Stop` | — | — | Stop the running Forge process |
| `Forge: Stop Sterling & Continue` | — | — | End the Sterling session so the run can finish |
| `Forge: Choose Where Sterling Opens` | `Cmd+Alt+S` | `Ctrl+Alt+S` | Pick whether Sterling opens in a VS Code panel or your web browser |
| `Forge: Open Settings` | `Cmd+Alt+,` | `Ctrl+Alt+,` | Open this extension's settings |
| `Forge: Show Output` | — | — | Reveal the Forge output channel |
| `Forge: Enable Logging` | — | — | Turn on telemetry |
| `Forge: Disable Logging` | — | — | Turn off telemetry |
| `Forge: Open Documentation` | — | — | Open the bundled Forge documentation |

## `@forge` Chat Participant (AI-Powered Help)

The extension includes a **chat participant** that lets students ask questions about Forge directly in VS Code's Copilot Chat. It comes bundled with the complete [Forge v5 documentation](https://forge-fm.github.io/forge-documentation/5.0/), so answers are grounded in the official reference material — not generic LLM guesses.

### Prerequisites

- **VS Code 1.93+**
- **GitHub Copilot** (or another VS Code language-model provider) installed and signed in.

### Usage

Open the Chat panel (`Ctrl+Shift+I` / `Cmd+Shift+I`) and type `@forge` followed by your question:

```
@forge How do I declare a sig with fields?
@forge What does "lone" mean?
@forge Why am I getting a "contract violation" error?
```

### Slash commands

| Command | Description |
| --- | --- |
| `@forge /docs <topic>` | Look up the official Forge documentation for a specific topic (sigs, quantifiers, temporal operators, etc.) |
| `@forge /explain` | Explain Forge code or concepts — automatically includes the active `.frg` file as context |

### How it works

1. **Bundled docs** — The full Forge v5 documentation is shipped inside the extension as structured data (see `client/src/forge-docs.ts`). No network fetch needed at query time.
2. **Keyword search** — When a question comes in, the extension scores every documentation section against the query using keyword and title matching, then selects the most relevant sections.
3. **LLM augmentation** — The relevant doc sections, plus the user's current `.frg` file (if open), are sent as context to the language model alongside a Forge-specific system prompt.
4. **Pedagogical guardrails** — The system prompt instructs the model to guide students toward understanding rather than providing homework solutions outright.

### Example workflow

1. Open your `.frg` file.
2. Open Chat and type: `@forge /explain`
3. The assistant reads your file and walks through the model, explaining each sig, predicate, and constraint.
4. Follow up with: `@forge Why is my run returning UNSAT?`
5. The assistant uses the relevant "Running" and "Bounds" documentation to help you debug.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `forge.racketPath` | string | `""` | Path to Racket executable. Leave empty to auto-detect. |
| `forge.minVersion` | string | `"3.3.0"` | Minimum Forge version required. |
| `forge.openSterlingIn` | string | `"webview"` | Where the Sterling visualizer opens: `webview` (VS Code panel) or `browser` (system browser). |
| `forge.copeAndDragVersion` | string | `"v4.8.0"` | Cope and Drag (Sterling visualizer) release to download and cache for the `webview`. Set another tag from [sidprasad/copeanddrag](https://github.com/sidprasad/copeanddrag/releases) to override, or an empty string to use the copy bundled with your Forge. Falls back to Forge's copy on failure or if Forge does not support serving an external visualizer. |
| `forgeLanguageServer.maxNumberOfProblems` | number | `100` | Max diagnostics produced by the server. |
| `forgeLanguageServer.trace.server` | string | `"messages"` | LSP trace verbosity. |
