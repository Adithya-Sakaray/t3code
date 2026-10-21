import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  prunePinnedRuntimes,
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

const successfulRunner = (fs: FileSystem.FileSystem, path: Path.Path) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const prefixIndex = input.args.indexOf("--prefix");
        const stagingDir = input.args[prefixIndex + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        const entry = path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("resolves scoped npm package entry paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const paths = pinnedRuntimePaths(path, "/tmp/t3", "0.0.34-adi.1", "@adithyasak/t3");
      assert.ok(paths.entryPath.endsWith("/node_modules/@adithyasak/t3/dist/bin.mjs"));
    }),
  );

  it.effect("installs through pnpm when its Node runtime has no npm executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-pnpm-" });
      const commands: Array<ProcessRunner.ProcessRunInput> = [];
      const install = successfulRunner(fs, path);
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) => {
            commands.push(input);
            return input.command === "npm"
              ? Effect.fail(
                  new ProcessRunner.ProcessSpawnError({
                    command: "npm",
                    argumentCount: input.args.length,
                    cause: PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                    }),
                  }),
                )
              : install.run(input);
          },
        }),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.deepEqual(
        commands.map((command) => command.command),
        ["npm", "pnpm"],
      );
      assert.deepEqual(commands[1]!.args, ["--package=npm@11", "dlx", "npm", ...commands[0]!.args]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), "1.2.3\n");
    }),
  );

  it.effect("does not try a different installer for npm permission failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-permission-" });
      const commands: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) => {
            commands.push(input.command);
            return Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: input.command,
                argumentCount: input.args.length,
                cause: PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              }),
            );
          },
        }),
        validate: () => Effect.die("must not validate a failed install"),
      }).pipe(Effect.flip);
      assert.deepEqual(commands, ["npm"]);
    }),
  );

  it.effect("names the package spec when npm has no such version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-unpublished-" });
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "0.1.0",
        packageName: "@adithyasak/t3",
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: () =>
            Effect.succeed({
              stdout: "",
              stderr:
                "npm error code ETARGET\nnpm error notarget No matching version found for @adithyasak/t3@0.1.0.\n",
              code: ChildProcessSpawner.ExitCode(1),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        validate: () => Effect.die("must not validate a failed install"),
      }).pipe(Effect.flip);
      assert.equal(error._tag, "PinnedRuntimeInstallError");
      assert.equal(error.message, "@adithyasak/t3@0.1.0 is not published on npm.");
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), "1.2.3\n");
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      let validations = 0;
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: successfulRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});

it.layer(NodeServices.layer)("prunePinnedRuntimes", (it) => {
  const lsofRunner = (stdout: string) =>
    ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    });

  const setup = Effect.fn(function* (versions: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-prune-" });
    const versionsDir = path.join(baseDir, "runtime", "versions");
    const now = Duration.toMillis(Duration.days(1));
    yield* TestClock.setTime(now);
    const install = Effect.fn(function* (
      version: string,
      completed: "long ago" | "just now" | "never" = "long ago",
    ) {
      const directory = path.join(versionsDir, version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "t3"), "");
      if (completed === "never") return;
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      const at = completed === "just now" ? now : 0;
      yield* fs.utimes(sentinel, at, at);
    });
    for (const version of versions) yield* install(version);
    return { baseDir, versionsDir, install };
  });

  it.effect("removes only completed runtimes nothing references", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir, install } = yield* setup([
        "1.0.0",
        "1.1.0",
        "1.2.0",
        "1.2.5",
        "1.3.0",
        "1.3.5",
        "1.4.0",
        "1.5.0",
        "2.0.0",
        "2.1.0",
      ]);
      // A downgrade another process installed but has not pointed anything at yet.
      yield* install("0.5.0", "just now");
      yield* install("1.0.1", "never");
      yield* install(".staging-abc", "never");
      yield* install(".pruned-0.8.0");
      yield* install("other", "never");
      yield* fs.symlink(path.join(versionsDir, "other"), path.join(versionsDir, "0.9.0"));
      const binDir = path.join(baseDir, "bin");
      const customBinDir = path.join(baseDir, "custom-bin");
      yield* fs.makeDirectory(binDir);
      yield* fs.makeDirectory(customBinDir);
      // Chained: the launcher reaches its runtime through a second link.
      yield* fs.symlink(path.join(versionsDir, "1.2.0", "t3"), path.join(baseDir, "alias-t3"));
      yield* fs.symlink(path.join(baseDir, "alias-t3"), path.join(binDir, "t3"));
      yield* fs.symlink(path.join(versionsDir, "1.2.5", "t3"), path.join(customBinDir, "t3"));
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "launchers"),
        `${path.join(customBinDir, "t3")}\n`,
      );
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-state.json"),
        JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.4.0",
          update: { id: "u", fromVersion: "1.4.0", targetVersion: "1.5.0", status: "rolled-back" },
        }),
      );

      const removed = yield* prunePinnedRuntimes({
        baseDir,
        keep: ["2.0.0"],
        references: [`ExecStart=${path.join(versionsDir, "1.3.5", "t3")} __service-launcher`],
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          lsofRunner(`p42\nftxt\nn${path.join(versionsDir, "1.3.0", "t3")}\n`),
        ),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: binDir }),
      );

      // 1.2.0 is the default launcher, 1.2.5 a recorded one, 1.3.0 running, 1.3.5 in the unit,
      // 1.4.0 active, 1.5.0 the rolled-back target, 2.0.0 the caller's, 0.5.0 just installed.
      // Being newer than the caller's version does not keep 2.1.0.
      assert.deepEqual(removed.toSorted(), ["0.8.0", "1.0.0", "1.1.0", "2.1.0"]);
      // The launcher found on PATH is remembered for a service that cannot see it.
      assert.equal(
        yield* fs.readFileString(path.join(baseDir, "runtime", "launchers")),
        `${path.join(customBinDir, "t3")}\n${path.join(binDir, "t3")}\n`,
      );
      assert.deepEqual((yield* fs.readDirectory(versionsDir)).toSorted(), [
        ".staging-abc",
        "0.5.0",
        "0.9.0",
        "1.0.1",
        "1.2.0",
        "1.2.5",
        "1.3.0",
        "1.3.5",
        "1.4.0",
        "1.5.0",
        "2.0.0",
        "other",
      ]);
    }),
  );

  it.effect("matches a Windows shim whatever its casing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
      const shim = path.join(baseDir, "t3.cmd");
      yield* fs.writeFileString(
        shim,
        `@echo off\r\n"${path.join(versionsDir, "1.0.0", "t3.exe").toUpperCase()}" %*`,
      );
      yield* fs.writeFileString(path.join(baseDir, "runtime", "launchers"), `${shim}\n`);

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          lsofRunner("C:\\Windows\\explorer.exe\n"),
        ),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.deepEqual(removed, ["1.1.0"]);
    }),
  );

  it.effect.each([
    { name: "the process list is unavailable", state: undefined, lsof: "" },
    { name: "the service state is unparseable", state: "{", lsof: "p1\nftxt\nn/sbin/launchd\n" },
    {
      name: "the service state cannot be read",
      state: null,
      lsof: "p1\nftxt\nn/sbin/launchd\n",
    },
  ])("keeps everything when $name", ({ state, lsof }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir } = yield* setup(["1.0.0"]);
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      if (state === null) yield* fs.makeDirectory(statePath);
      else if (state !== undefined) yield* fs.writeFileString(statePath, state);

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, lsofRunner(lsof)),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
      );
      assert.deepEqual(removed, []);
      assert.deepEqual(yield* fs.readDirectory(versionsDir), ["1.0.0"]);
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "keeps a runtime a process runs through a symlink",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
        const entry = path.join(versionsDir, "1.0.0", "t3");
        yield* fs.copyFile("/bin/sleep", entry);
        yield* fs.chmod(entry, 0o755);
        const link = path.join(baseDir, "t3");
        yield* fs.symlink(entry, link);
        // Its argv names only the link, as with `t3 serve` run from PATH. Removing the link after
        // spawning leaves the process's executable as the only reference.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.spawn(ChildProcess.make(link, ["30"]));
        yield* fs.remove(link);

        const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
          Effect.provide(ProcessRunner.layer),
        );
        assert.deepEqual(removed, ["1.1.0"]);
      }),
  );
});
