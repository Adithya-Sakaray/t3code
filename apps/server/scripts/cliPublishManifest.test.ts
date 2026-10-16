import { describe, expect, it } from "vite-plus/test";

import { createPublishPackageManifest } from "./cliPublishManifest.ts";

const source = {
  name: "t3",
  repository: {
    type: "git",
    url: "https://github.com/pingdotgg/t3code",
    directory: "apps/server",
  },
  bin: { t3: "./dist/bin.mjs" },
  type: "module",
  version: "0.0.32",
  engines: { node: "^24.13.1" },
  files: ["dist"],
  dependencies: {
    effect: "catalog:",
    yaml: "catalog:",
    "node-pty": "^1.1.0",
    "@t3tools/provider-kiro": "workspace:*",
  },
};

describe("createPublishPackageManifest", () => {
  it("resolves catalog dependencies, drops bundled workspace packages, and keeps the workspace package name by default", () => {
    const manifest = createPublishPackageManifest({
      source,
      version: "0.0.34-adi.1",
      workspaceCatalog: { effect: "4.0.0", yaml: "2.8.0" },
      workspaceOverrides: {},
    });

    expect(manifest.name).toBe("t3");
    expect(manifest.version).toBe("0.0.34-adi.1");
    expect(manifest.bin).toEqual({ t3: "./dist/bin.mjs" });
    expect(manifest.dependencies).toEqual({
      effect: "4.0.0",
      yaml: "2.8.0",
      "node-pty": "^1.1.0",
    });
    expect(manifest.repository.url).toBe("https://github.com/pingdotgg/t3code");
  });

  it("overrides the published name and repository without changing the t3 bin", () => {
    const manifest = createPublishPackageManifest({
      source,
      version: "0.0.34-adi.1",
      workspaceCatalog: { effect: "4.0.0", yaml: "2.8.0" },
      workspaceOverrides: {},
      packageName: "@adithyasak/t3",
      repositoryUrl: "https://github.com/Adithya-Sakaray/t3code",
    });

    expect(manifest.name).toBe("@adithyasak/t3");
    expect(manifest.bin).toEqual({ t3: "./dist/bin.mjs" });
    expect(manifest.repository).toEqual({
      type: "git",
      url: "https://github.com/Adithya-Sakaray/t3code",
      directory: "apps/server",
    });
  });
});
