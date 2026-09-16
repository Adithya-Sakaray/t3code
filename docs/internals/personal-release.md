# Personal fork releases

> Maintainer notes for `Adithya-Sakaray/t3code`. Official release process:
> [Release Checklist](../operations/release.md).

One workflow ships both artifacts at the **same version**:

- `.github/workflows/personal-macos-release.yml` (**Personal Release**)
- npm: `@adithyasak/t3@<version>`
- desktop: unsigned `T3 Code Adi` DMG on a GitHub Release

The workspace package stays named `t3` so `--filter t3` and upstream rebases keep working. The
published tarball is renamed to `@adithyasak/t3` and keeps the `t3` executable.

## End-to-end

1. Actions → **Personal Release** → Run workflow, version `0.0.33-adi.2` (or the next
   `0.0.33-adi.N`). Or push `personal-v0.0.33-adi.3`.
2. npm publishes first: `@adithyasak/t3@<version>`.
3. Then the Mac DMG is built and attached to GitHub Release `personal-v<version>`.
4. Install or update **T3 Code Adi**. SSH remotes run `npx --yes @adithyasak/t3@<version>`.

Do not run two version numbers. Leave **skip_npm** off unless you are debugging a Mac-only build.

Both jobs copy `.env.example` to `.env` before building so official T3 Connect public identifiers
are baked in. This fork still uses production Clerk and `https://relay.t3.codes`.

## First-time npm package (CLI, not the website)

npm creates `@adithyasak/t3` on the first successful `npm publish`. Do that with this repo's CLI,
using the same version as the desktop you want to ship:

```sh
npm login
cp .env.example .env
T3CODE_CLI_PACKAGE_NAME=@adithyasak/t3 vp run --filter t3 build
T3CODE_CLI_PACKAGE_NAME=@adithyasak/t3 \
  node apps/server/scripts/cli.ts pack \
    --app-version 0.0.33-adi.2 \
    --package-name @adithyasak/t3 \
    --publish \
    --verbose
```

`--publish` runs `npm publish <tarball> --access public --tag latest`. Personal versions such as
`0.0.33-adi.2` are prereleases, so npm requires `--tag`. Confirm:

```sh
npm view @adithyasak/t3@0.0.33-adi.2 version
```

Then, for later GitHub Actions publishes, open
[https://www.npmjs.com/package/@adithyasak/t3/access](https://www.npmjs.com/package/@adithyasak/t3/access)
and add a Trusted Publisher:

- Provider: GitHub Actions
- Repository: `Adithya-Sakaray/t3code`
- Workflow file: `personal-macos-release.yml`
- Environment: leave empty

## Caveats

- A globally installed upstream `t3` no longer wins on SSH remotes. The runner always uses
  `npx --yes <pinned spec>`.
- Official T3 Code and T3 Code Adi both register `t3code://`. macOS hands OAuth callbacks to one
  default handler. If Connect sign-in opens the official app, quit it or “Open With” T3 Code Adi.
- Personal Mac builds are unsigned, so native Clerk passkeys are disabled. Email sign-in stays in
  the Clerk sheet. Google OAuth is kept in an in-app window so the `t3code://` callback is not
  stolen by official T3 Code. Official passkeys stay tied to `com.t3tools.t3code`.
- Personal npm builds do not bundle resource-monitor binaries.
- `node-pty` ships no Linux prebuilds. On Linux the CLI compiles it at install time. If you see
  `Failed to load node-pty for linux-x64`, install `python3`, `make`, and `g++`, prefer Node 24 LTS
  over Node 26, then `npm rebuild node-pty` inside the installed package. Official `t3` has the same
  requirement.
- The background-service launcher is `t3 __service-launcher` inside the scoped CLI
  (`runtime/versions/<version>/node_modules/@adithyasak/t3/dist/bin.mjs`).
  After this ships, run `npx @adithyasak/t3@<version> service update` so the boot
  unit points at the new runtime. A unit that still points at a standalone
  `service-launcher.mjs` will fail with "runtime is missing or incomplete."
- Kiro and the rest of the personal-fork provider work are unchanged by this distribution path.
