# Code quality checks

Source layout and implementation style are unrestricted: there are no mandatory compression, file/function size, import allowlist, non-null assertion, explicit-any or console rules.

`npm run verify` checks TypeScript diagnostics, behavior tests and the production build. `npm run format:check` checks changed-file formatting when requested. Functional tests, data integrity checks, input resource limits and browser QA remain in place.

Architecture, dead-code and source navigation scripts are optional diagnostics. They are not part of `check`, `verify`, lint or CI, and their recommendations do not require restructuring otherwise correct code. `npm run check:architecture`, `npm run deadcode`, `npm run code:map` and `npm run readability` remain available for manual investigation.
