#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../../scripts/lib/brand-assets.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../package.json" with { type: "json" };
import { createPublishPackageManifest } from "./cliPublishManifest.ts";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from "./cliErrors.ts";

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const preparePublishIcons = Effect.fn("preparePublishIcons")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const brand = resolveWebAssetBrandForPackageVersion(version);
  const icons = resolveWebIconOverrides(brand, "dist/client").map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
  }));

  for (const icon of icons) {
    if (!(yield* fs.exists(icon.sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath });
    }
    if (!(yield* fs.exists(icon.targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath });
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    Effect.all({
      original: fs.readFile(icon.targetPath),
      publish: fs.readFile(icon.sourcePath),
    }).pipe(Effect.map((contents) => ({ ...icon, ...contents }))),
  );
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

interface PreparedPublishPackage {
  readonly packageJsonString: string;
  readonly originalPackageJson: Uint8Array;
  readonly icons: ReadonlyArray<{
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly original: Uint8Array;
    readonly publish: Uint8Array;
  }>;
}

interface PreparePublishPackageConfig {
  readonly appVersion: Option.Option<string>;
  readonly packageName: Option.Option<string>;
  readonly repositoryUrl: Option.Option<string>;
}

const createVpPmPublishArgs = (config: PublishCommandConfig): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    "t3",
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

const assertServerBuildAssets = Effect.fn("assertServerBuildAssets")(function* (serverDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  for (const relPath of ["dist/bin.mjs", "dist/client/index.html"]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
    }
  }
});

const preparePublishPackage = Effect.fn("preparePublishPackage")(function* (
  config: PreparePublishPackageConfig,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const packageJsonPath = path.join(serverDir, "package.json");
  const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
  const workspaceConfig = yield* readWorkspaceConfig();
  const packageName = Option.getOrUndefined(
    Option.orElse(
      Option.filter(config.packageName, (value) => value.trim().length > 0),
      () => Option.fromNullishOr(process.env.T3CODE_CLI_PACKAGE_NAME?.trim() || undefined),
    ),
  );
  const repositoryUrl = Option.getOrUndefined(
    Option.orElse(
      Option.filter(config.repositoryUrl, (value) => value.trim().length > 0),
      () => {
        const repository = process.env.GITHUB_REPOSITORY?.trim();
        return repository ? Option.some(`https://github.com/${repository}`) : Option.none();
      },
    ),
  );
  const pkg = createPublishPackageManifest({
    source: serverPackageJson,
    version,
    workspaceCatalog: workspaceConfig.catalog ?? {},
    workspaceOverrides: workspaceConfig.overrides ?? {},
    ...(packageName === undefined ? {} : { packageName }),
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
  });

  return {
    repoRoot,
    serverDir,
    packageJsonPath,
    version,
    packageName: pkg.name,
    packageJsonString: yield* encodePackageJson(pkg),
    originalPackageJson: yield* fs.readFile(packageJsonPath),
    icons: yield* preparePublishIcons(repoRoot, serverDir, version),
  } satisfies PreparedPublishPackage & {
    readonly repoRoot: string;
    readonly serverDir: string;
    readonly packageJsonPath: string;
    readonly version: string;
    readonly packageName: string;
  };
});

const applyPreparedPublishPackage = Effect.fn("applyPreparedPublishPackage")(function* (
  resource: PreparedPublishPackage & { readonly packageJsonPath: string },
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(resource.packageJsonPath, `${resource.packageJsonString}\n`);
  for (const icon of resource.icons) {
    yield* fs.writeFile(icon.targetPath, icon.publish);
  }
  yield* Effect.log("[cli] Applied package metadata and publish icon overrides");
});

const restorePreparedPublishPackage = Effect.fn("restorePreparedPublishPackage")(function* (
  resource: PreparedPublishPackage & { readonly packageJsonPath: string },
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFile(resource.packageJsonPath, resource.originalPackageJson);
  for (const icon of resource.icons) {
    yield* fs.writeFile(icon.targetPath, icon.original);
  }
  if (verbose) yield* Effect.log("[cli] Restored original publish assets");
});

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    packageName: Flag.string("package-name").pipe(Flag.optional),
    repositoryUrl: Flag.string("repository-url").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      yield* assertServerBuildAssets(serverDir);

      yield* Effect.acquireUseRelease(
        preparePublishPackage(config),
        (resource) =>
          Effect.gen(function* () {
            yield* applyPreparedPublishPackage(resource);

            const args = createVpPmPublishArgs(config);
            const spawnCommand = yield* resolveSpawnCommand("vp", ["pm", ...args]);

            yield* Effect.log(`[cli] Running: vp pm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: repoRoot,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
            );
          }),
        (resource) => restorePreparedPublishPackage(resource, config.verbose),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

const packCmd = Command.make(
  "pack",
  {
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    packageName: Flag.string("package-name").pipe(Flag.optional),
    repositoryUrl: Flag.string("repository-url").pipe(Flag.optional),
    outputDir: Flag.string("output-dir").pipe(Flag.optional),
    publish: Flag.boolean("publish").pipe(Flag.withDefault(false)),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      yield* assertServerBuildAssets(serverDir);

      const outputDir = Option.getOrElse(config.outputDir, () =>
        path.join(repoRoot, "release-publish"),
      );
      yield* fs.makeDirectory(outputDir, { recursive: true });

      const tarballPath = yield* Effect.acquireUseRelease(
        preparePublishPackage({
          appVersion: config.appVersion,
          packageName: Option.filter(config.packageName, (value) => value.trim().length > 0),
          repositoryUrl: config.repositoryUrl,
        }),
        (resource) =>
          Effect.gen(function* () {
            yield* applyPreparedPublishPackage(resource);

            const args = ["pm", "pack", "--pack-destination", outputDir];
            const spawnCommand = yield* resolveSpawnCommand("vp", args);
            yield* Effect.log(`[cli] Running: vp ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: serverDir,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
            );

            const packedFiles = (yield* fs.readDirectory(outputDir)).filter((entry) =>
              entry.endsWith(".tgz"),
            );
            const matchingFiles = packedFiles.filter((entry) => entry.includes(resource.version));
            const packedFile = matchingFiles.at(-1) ?? packedFiles.at(-1);
            if (packedFile === undefined) {
              return yield* new ServerCliBuildAssetMissingError({
                assetPath: path.join(outputDir, "*.tgz"),
              });
            }
            const tarball = path.join(outputDir, packedFile);
            yield* Effect.log(
              `[cli] Packed ${resource.packageName}@${resource.version} -> ${tarball}`,
            );

            const githubOutput = process.env.GITHUB_OUTPUT?.trim();
            if (githubOutput) {
              yield* fs.writeFileString(
                githubOutput,
                [
                  `tarball=${tarball}`,
                  `package_name=${resource.packageName}`,
                  `version=${resource.version}`,
                ].join("\n") + "\n",
                { flag: "a" },
              );
            }

            return tarball;
          }),
        (resource) => restorePreparedPublishPackage(resource, config.verbose),
      );

      yield* Effect.log(tarballPath);

      if (config.publish) {
        // npm requires an explicit tag for prerelease versions such as 0.0.33-adi.2.
        const publishArgs = [
          "publish",
          tarballPath,
          "--access",
          config.access,
          "--tag",
          config.tag,
        ];
        const spawnCommand = yield* resolveSpawnCommand("npm", publishArgs);
        yield* Effect.log(`[cli] Running: npm ${publishArgs.join(" ")}`);
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: repoRoot,
            stdout: config.verbose ? "inherit" : "ignore",
            stderr: "inherit",
            shell: spawnCommand.shell,
          }),
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Pack the server package with resolved catalog deps. Pass --publish to npm publish the tarball.",
  ),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd, packCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
