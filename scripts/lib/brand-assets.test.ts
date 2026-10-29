import { describe, expect, it } from "@effect/vitest";

import { resolveWebAssetBrandForPackageVersion } from "./brand-assets.ts";

describe("resolveWebAssetBrandForPackageVersion", () => {
  it("uses nightly art for nightly and preview versions", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.1.4-nightly.20261029.3867")).toBe("nightly");
    expect(resolveWebAssetBrandForPackageVersion("0.1.3-preview.20261026.3702")).toBe("nightly");
  });

  it("uses production art for stable and personal versions", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.1.4")).toBe("production");
    expect(resolveWebAssetBrandForPackageVersion("0.1.4-adi.1")).toBe("production");
  });
});
