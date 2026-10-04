# Optional dependency diagnostics

The rules below describe the historical dependency audit. They are not mandatory implementation constraints and are not run by verify or CI. Screen import allowlists are advisory; correctness and behavior determine whether a change is acceptable.

# TypeScript dependency architecture

LoopDeck keeps the production TypeScript dependency contract intentionally small. The rules here describe the graph the repository already uses; they are guardrails, not a framework-style layer rewrite.

Run the check with:

```bash
npm run check:architecture
```

The command reads `tsconfig.json`, resolves imports with the TypeScript compiler's configured module resolution, and inspects production TypeScript under `src/`. Tests, generated output, CSS/assets, and external packages are outside this graph.

## Enforced rules

1. Production TypeScript must be acyclic.
2. Reusable/lower-level areas `src/core/**`, `src/storage/**`, `src/packs/**`, `src/pdf/**`, and `src/ui/**` must not import `src/screens/**` or `src/main.ts`.
3. New `src/screens/** -> src/screens/**` edges are rejected unless they are explicitly allow-listed in `scripts/check-architecture.mjs` with a narrow reason.

`src/main.ts` is the composition root, so dependencies are expected to point broadly from `main -> screens -> shared/domain modules`, not back upward.

## Current screen exceptions

The checker permits only these composition edges. Shared module presentation lives in src/ui/modulePresentation.ts and quiz view helpers in src/ui/inlineQuizView.ts:

- `src/screens/homeScreen.ts -> src/screens/homeFolders.ts` — home-only helper currently colocated under `screens`.
- `src/screens/moduleScreen.ts -> src/screens/inlineQuiz.ts` — deliberate composition of the shared inline quiz renderer.
- `src/screens/reviewCenter.ts -> src/screens/inlineQuiz.ts` — deliberate composition of the shared inline quiz renderer.

Do not add a broad directory exception. If a new peer-screen edge is truly necessary, document the exact source/target pair and why it should remain a composition dependency.

## Failure output

The check prints exact offending edges for boundary violations and a complete file chain for circular dependencies, for example:

```text
[architecture] FAILED with 1 violation:

- circular dependency:
  src/core/a.ts -> src/core/b.ts -> src/core/a.ts
```

The normal GitHub Actions web CI runs this command on pushes to `main` and on pull requests.
