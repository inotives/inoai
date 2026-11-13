# Bundled license sources

`sapphire-utilities-LICENSE.md` is the upstream MIT license for the
`@sapphire/async-queue` and `@sapphire/snowflake` packages. Their published
npm packages do not contain the license file. It was copied from
`sapphiredev/utilities` commit `02db95487ec6067fe30c217c84ba13fd1baa11f8`,
`LICENSE.md`. The standalone build includes it for both packages.

`standardwebhooks-LICENSE.md` is the upstream MIT license for the
`standardwebhooks` package, a dependency of `@anthropic-ai/sdk`. Its published
npm package does not contain the license file. It was copied from
`standard-webhooks/standard-webhooks` commit
`a3b5c6d079194df69cb433152206e43b63f1e17c`, `libraries/LICENSE`, which covers
the JavaScript library in `libraries/javascript`. The standalone build includes it.

`awesome-copilot-LICENSE.md` is the upstream MIT license (Copyright GitHub, Inc.)
for the role catalog in `src/inoai/roles/catalog/`. The catalog is converted
from `github/awesome-copilot` commit `222eba62d518c27317e917c92e3ec1a7e6729455`,
`agents/*.agent.md`, by `scripts/convert-awesome-copilot-roles.mjs`. The license
was copied from `LICENSE` at the same commit. The vendoring report is
`src/inoai/roles/catalog-vendoring.md`. The standalone build embeds the catalog
and includes this license.
