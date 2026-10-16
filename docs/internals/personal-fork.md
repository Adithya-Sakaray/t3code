# Personal fork maintenance

> Maintainer notes for `Adithya-Sakaray/t3code`. Shipping a build is covered in
> [Personal fork releases](./personal-release.md).

The fork tracks upstream `pingdotgg/t3code` and carries a small set of changes on top. Each section
below is something an upstream merge can silently undo, and what breaks if it does.

## What the fork carries

**Kiro provider.** [`packages/provider-kiro`](../../packages/provider-kiro) runs `kiro-cli acp` as a
flavor of upstream's shared ACP adapter, like `provider-grok`. Kiro-specific behavior stays in that
package. The shared adapter gained three generic hooks for it (`reportSubagent`,
`updateContextUsage`, `rootSessionId` in
[`provider-acp/src/server/adapter.ts`](../../packages/provider-acp/src/server/adapter.ts)). Keep
them generic so upstream changes to that file merge cleanly. Contracts know `kiro` in
`UsageProviderKind`, `DEFAULT_MODEL_BY_PROVIDER`, and `PROVIDER_DISPLAY_NAMES`. Web and mobile
register `kiroClient` next to the other provider clients.

**npm distribution.** Since v0.1.0, upstream installs every runtime from executable archives on its
own GitHub releases. The fork installs `@adithyasak/t3` from npm instead, everywhere a runtime is
installed: pinned runtimes ([`pinnedRuntime.ts`](../../apps/server/src/cloud/pinnedRuntime.ts)),
the boot service, server self-update, and desktop SSH remotes (`npx` in
[`packages/ssh/src/tunnel.ts`](../../packages/ssh/src/tunnel.ts)). `t3 update` reads the newest
version from the package's npm dist-tags, because upstream's release index lists versions the fork
never published. The package name is baked in at build time from `T3CODE_CLI_PACKAGE_NAME`; a build
without it installs upstream's `t3`, which has no Kiro.

**Desktop identity.** T3 Code Adi has its own app id, updates from this repository's releases, and
links release notes to `personal-v<version>` tags.

## Official clients and fork servers

Kiro reaches official clients (app.t3.codes, official desktop and mobile) as generic server data, so
any client works as long as the server is the fork. Two limits apply:

- Upstream clients decode RPC results through the RPC exit codec, where `ForwardCompatibleArray`
  does not drop an element with an unknown literal. The whole response fails instead. A single
  `kiro` usage bucket left their Usage page empty, so the server sends Kiro usage only to clients
  whose version ends in `-adi.N`
  ([`forkClientUsage.ts`](../../apps/server/src/usage/forkClientUsage.ts)). Any new fork-only
  literal in a response that official clients read needs the same treatment.
- Official clients offer upstream versions in **Update server**. The fork server refuses them with
  "`@adithyasak/t3@<version>` is not published on npm" rather than installing anything.

## Kiro protocol traps

Learned from `kiro-cli` 2.19.1:

- Models arrive in `session/new`'s `models` field, not as an ACP config option, so upstream's
  generic model switching never sees them.
- Effort is per model, read and set through `_kiro.dev/commands/execute`. Discovering which models
  support it opens a session, which starts the user's Kiro MCP servers. The result is cached under
  `caches/kiro-capabilities` and refreshed only when Kiro's version or model list changes.
- Credits and context arrive in `_kiro.dev/metadata`. Crew children are announced by
  `_kiro.dev/subagent/list_update` and run in their own ACP sessions.
- A crew child calls `summary` either after its text answer, which it then repeats, or before any
  text. Only text after a summary that followed an answer is an echo.
- `whoami -f json` prints JSON followed by plain text, and exits 1 with `{"account":null}` when
  signed out.

## Syncing upstream

1. Branch from `main` into a separate worktree, keep a `backup/pre-<tag>-sync-<date>` branch, and
   merge the upstream release tag.
2. Take upstream's side everywhere except the areas above.
3. Expect conflicts in `apps/server/scripts/cli.ts`: after v0.1.0 upstream removed its npm platform
   packages (#20148). Keep the fork's `pack` path.
4. Verify beyond typecheck and tests:
   - `T3CODE_CLI_PACKAGE_NAME=@adithyasak/t3 vp run --filter t3 build`. The web build's license
     check fails if an inlined workspace package without a license, such as `effect-acp`, is listed
     in `dependencies`; keep those in `devDependencies`.
   - `node apps/server/scripts/cli.ts pack`, then `npm install` the tarball in an empty directory and
     start it against a throwaway home. This catches `workspace:` specs and missing runtime
     externals.
   - A live Kiro turn on each instance against a copied T3 home: models, effort, a crew subagent,
     credits, and a restart.
   - app.t3.codes against the fork server through a tunnel, including the Usage page.
5. Release with [Personal fork releases](./personal-release.md).

Pushes to `main` also trigger upstream workflows that need upstream's runners or secrets (CI, relay
deploy, EAS). On the fork they queue and are cancelled after a day; that is expected.
