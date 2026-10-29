# Changesets

Published packages (`@searxng-js/sex-*`) are versioned independently. Run `bun run changeset` to describe a change.

Private libraries that are bundled into published packages (`sex-errors`) are versioned along with them, because changesets
refuses a published package that depends on a package it skips; they are never tagged or published. The apps (`sex`,
`sex-lite`) and the packages only they use (`sex-server`, `sex-testing`) are in `ignore`.
