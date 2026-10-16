import { ProviderDriverKind } from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { KiroSettings } from "../settings.ts";
import { createKiroAdapterV2, type KiroAdapterV2DriverEnv } from "./adapter.ts";
import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  rememberKiroUsageLimits,
} from "./status.ts";
import { makeKiroTextGeneration } from "./textGeneration.ts";
import { kiroUsageReader } from "./usage.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const DRIVER_KIND = ProviderDriverKind.make("kiro");
// Kiro CLI updates itself through its own installer; T3 leaves it manual.
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type KiroDriverEnv =
  | KiroAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path;

export const KiroDriver: ProviderDriver<
  KiroSettings,
  KiroDriverEnv,
  Path.Path | FileSystem.FileSystem
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  usage: kiroUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      // Each instance's environment selects its own KIRO_HOME and login, so
      // two instances run as two Kiro accounts.
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KiroSettings;
      const forceSessionProbe = yield* Ref.make(false);
      const cacheFile = path.join(
        host.paths.providerStatusCacheDir,
        "kiro-capabilities",
        `${instanceId}.json`,
      );

      const orchestrationAdapter = yield* createKiroAdapterV2(
        { instanceId, displayName, accentColor, environment, enabled, config },
        {
          onUsageLimits: (update) =>
            rememberKiroUsageLimits(cacheFile, {
              checkedAt: update.checkedAt,
              windows: update.windows,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.andThen(snapshot.applyUsageLimits(update)),
            ),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Kiro orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeKiroTextGeneration(effectiveConfig, processEnv);

      const checkProvider = Ref.getAndSet(forceSessionProbe, false).pipe(
        Effect.flatMap((force) =>
          checkKiroProviderStatus({
            settings: effectiveConfig,
            environment: processEnv,
            probeCwd: host.paths.cwd,
            cacheFile,
            forceSessionProbe: force,
          }),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKiroProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Kiro snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
        // An explicit model refresh re-probes a session for effort levels,
        // modes, and credits even when the cache still matches.
        invalidateCaches: Ref.set(forceSessionProbe, true),
      } satisfies ProviderInstance;
    }),
};
