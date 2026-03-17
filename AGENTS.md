# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

A VS Code extension that tracks file review progress with line-level granularity. Users add files to review, mark line ranges as reviewed, and the extension visually highlights unreviewed lines with gutter dots, background colors, and overview ruler markers. Review state persists in `.vscode/review-state.json`.

## Commands

```bash
pnpm lint          # TypeScript type-check + ESLint
pnpm test          # Run all tests (vitest)
pnpm test:watch    # Run tests in watch mode
pnpm build         # Full build: lint + test + bundle + package .vsix
pnpm dev           # Watch mode bundling (tsup)

# After implementing features or fixes, build and install to test locally:
pnpm build-and-install   # Build + install the .vsix into VS Code
```

Run a single test file: `pnpm vitest run src/review-state.test.ts`

## Architecture

The extension activates when a workspace contains `.vscode/review-state.json` and wires up event listeners in `src/main.ts`.

**Core data flow:**

- **Types** (`types.ts`): `ReviewState` → `FileReviewState` → `ReviewedRange`. Lines are 1-based. Each reviewed range stores per-line DJB2 hashes to detect content changes.
- **Review state logic** (`review-state.ts`): Pure functions for marking/unmarking lines, normalizing ranges, computing progress, and hashing. No VS Code dependency — fully testable.
- **Change tracking** (`change-tracker.ts`): Patience-diff algorithm that realigns reviewed ranges when document content changes. Detects deleted reviewed lines and marks adjacent lines for re-review. Falls back to LCS for non-unique regions, greedy matching for very large diffs.
- **State manager** (`review-state-manager.ts`): Stateful orchestrator that ties together review-state and change-tracker. Handles load/save (debounced), file open reverification, document change tracking, and emits `onDidChange` events.
- **Persistence** (`state-persistence.ts`): Serialization/deserialization with hand-written validation (no schemas/`as` casts). Invalid entries are stripped on load.

**VS Code integration layer:**

- `commands.ts`: Registers all `reviewHelper.*` commands
- `decorations.ts`: Creates and applies gutter dot SVGs, background highlights, and overview ruler markers for unreviewed lines
- `review-tree-provider.ts`: Tree view in the activity bar showing tracked files with progress
- `file-decoration-provider.ts`: Badge decorations on file explorer items
- `status-bar.ts`: Status bar showing overall review progress
- `absolute-path-detector.ts`: Warns users if review state contains absolute paths

**Key design decisions:**

- Line hashes use DJB2 with trailing whitespace trimmed, so whitespace-only changes don't invalidate reviews
- The change tracker stores a full document snapshot (`documentLineHashes`) to enable accurate old→new line mapping via patience diff
- Deletion-adjacent lines (lines next to where reviewed content was deleted) get a red gutter dot to signal context should be re-reviewed
- `tsup` mangles properties ending with `_` (via `mangleProps: /[^_]_$/`) — avoid naming public API properties with trailing underscores

## Testing

Tests use vitest with `jest-mock-vscode` to mock the `vscode` module (setup in `src/test/setup.ts`). Test files are colocated: `src/foo.test.ts` tests `src/foo.ts`. The core logic in `review-state.ts` and `change-tracker.ts` is pure and doesn't need VS Code mocks.

## Build

- Bundled with tsup (ESM, single entry `src/main.ts`, `vscode` externalized)
- Packaged as `.vsix` via `vsce package --no-dependencies`
- TypeScript strict mode with `noUncheckedIndexedAccess` enabled
