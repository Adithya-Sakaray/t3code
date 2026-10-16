import { describe, expect, it } from "@effect/vitest";

import { kiroAcpSpawnArgs, kiroLaunchRuntimeMode } from "./acpSupport.ts";
import {
  buildKiroServerModels,
  kiroAuthFromWhoami,
  kiroCapabilityCacheIsCurrent,
} from "./status.ts";

const CACHE = {
  version: "2.19.1",
  probedAt: "2026-10-16T12:00:00.000Z",
  effortLevels: {
    auto: [],
    "claude-opus-4.6": ["low", "medium", "high", "max"],
  },
  modes: [
    { id: "kiro_default", name: "kiro_default", description: "The default agent for Kiro CLI" },
    { id: "kiro_planner", name: "kiro_planner" },
  ],
  currentModeId: "kiro_default",
};

describe("buildKiroServerModels", () => {
  const models = buildKiroServerModels({
    models: [
      { id: "auto", name: "auto", contextWindowTokens: 1, rateMultiplier: 1, effortLevels: null },
      {
        id: "claude-opus-4.6",
        name: "claude-opus-4.6",
        contextWindowTokens: 1,
        rateMultiplier: 2.2,
        effortLevels: null,
      },
      { id: "glm-6", name: "glm-6", contextWindowTokens: 1, rateMultiplier: 1, effortLevels: null },
    ],
    defaultModelId: "auto",
    cache: CACHE,
    settings: { customModels: ["my-model"] },
  });
  const descriptorIds = (slug: string) =>
    models
      .find((model) => model.slug === slug)
      ?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id);

  it("offers effort only with the levels each model accepts", () => {
    expect(descriptorIds("auto")).toEqual(["_t3/session-mode"]);
    const opus = models.find((model) => model.slug === "claude-opus-4.6");
    const effort = opus?.capabilities?.optionDescriptors?.find((d) => d.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    // A model the probe has not seen yet gets no effort until it is probed.
    expect(descriptorIds("glm-6")).toEqual(["_t3/session-mode"]);
  });

  it("marks Kiro's default model and keeps custom models", () => {
    expect(models.find((model) => model.isDefault)?.slug).toBe("auto");
    expect(models.at(-1)).toMatchObject({ slug: "my-model", isCustom: true });
  });

  it("names Kiro's built-in agents as modes", () => {
    const mode = models[0]?.capabilities?.optionDescriptors?.find(
      (d) => d.id === "_t3/session-mode",
    );
    expect(mode?.type === "select" ? mode.options.map((option) => option.label) : []).toEqual([
      "Default",
      "Planner",
    ]);
  });
});

describe("kiroCapabilityCacheIsCurrent", () => {
  it("re-probes after a Kiro update or a new model", () => {
    expect(
      kiroCapabilityCacheIsCurrent({ cache: CACHE, version: "2.19.1", modelIds: ["auto"] }),
    ).toBe(true);
    expect(
      kiroCapabilityCacheIsCurrent({ cache: CACHE, version: "2.20.0", modelIds: ["auto"] }),
    ).toBe(false);
    expect(
      kiroCapabilityCacheIsCurrent({ cache: CACHE, version: "2.19.1", modelIds: ["new-model"] }),
    ).toBe(false);
    expect(kiroCapabilityCacheIsCurrent({ cache: null, version: "2.19.1", modelIds: [] })).toBe(
      false,
    );
  });
});

describe("kiro launch permissions", () => {
  it("encodes the permission mode in Kiro's launch flags", () => {
    expect(kiroAcpSpawnArgs("approval-required")).toEqual(["acp"]);
    expect(kiroAcpSpawnArgs("full-access")).toEqual(["acp", "--trust-all-tools"]);
    expect(kiroAcpSpawnArgs("auto-accept-edits")).toEqual([
      "acp",
      "--trust-tools",
      "read,glob,grep,code,introspect,todo_list,write",
    ]);
  });

  it("launches asking when T3 overrides approvals or Kiro lacks the mode", () => {
    const policy = { interactionMode: "default", cwd: null } as const;
    expect(kiroLaunchRuntimeMode({ ...policy, runtimeMode: "full-access" })).toBe("full-access");
    expect(kiroLaunchRuntimeMode({ ...policy, runtimeMode: "auto" })).toBe("approval-required");
    expect(
      kiroLaunchRuntimeMode({
        ...policy,
        runtimeMode: "full-access",
        approvalPolicy: "on-request",
      }),
    ).toBe("approval-required");
  });
});

describe("kiroAuthFromWhoami", () => {
  it("reads the account from `whoami -f json` despite the trailing profile text", () => {
    // kiro-cli 2.19.1 prints the JSON object, a blank line, then the profile.
    const stdout =
      '{"accountType":"IamIdentityCenter","email":"dev@example.com","region":"eu-north-1"}\n\nProfile:\nKiroProfile-us-east-1\narn:aws:codewhisperer:us-east-1:1:profile/X\n';
    expect(kiroAuthFromWhoami({ code: 0, stdout, stderr: "" })).toEqual({
      status: "authenticated",
      email: "dev@example.com",
      type: "IamIdentityCenter",
    });
  });

  it("reports a missing login as signed out", () => {
    expect(kiroAuthFromWhoami({ code: 1, stdout: '{"account":null}\n', stderr: "" })).toEqual({
      status: "unauthenticated",
    });
  });
});
