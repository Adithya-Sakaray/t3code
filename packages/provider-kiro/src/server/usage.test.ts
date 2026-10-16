import { describe, expect, it } from "@effect/vitest";

import { parseKiroSessionDocument } from "./usage.ts";

/** Shaped after a real kiro-cli 2.19.1 session sidecar (`sessions/cli/<id>.json`). */
function sidecar(turns: ReadonlyArray<Record<string, unknown>>) {
  return {
    session_id: "1ad9674b-721c-4358-9c44-ab2dd1556a15",
    cwd: "/tmp/kiro-probe-ws",
    session_state: {
      version: "v1",
      conversation_metadata: { user_turn_metadatas: turns },
      rts_model_state: { model_info: { model_id: "claude-sonnet-5.5", context_window_tokens: 1 } },
    },
  };
}

describe("parseKiroSessionDocument", () => {
  it("prices metered credits at Kiro's overage rate", () => {
    const records = parseKiroSessionDocument(
      sidecar([
        {
          end_timestamp: "2026-10-16T11:48:26.148161275Z",
          model: "auto",
          input_token_count: 0,
          output_token_count: 0,
          metering_usage: [
            { value: 0.056785035489220564, unit: "credit", unitPlural: "credits" },
            { value: 0.03761939054726368, unit: "credit", unitPlural: "credits" },
          ],
        },
      ]),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "kiro",
      model: "auto",
      sessionId: "1ad9674b-721c-4358-9c44-ab2dd1556a15",
      speed: "standard",
    });
    expect(records[0]!.reportedCostUsd).toBeCloseTo(0.0944 * 0.04, 6);
    expect(records[0]!.timestampMs).toBe(Date.parse("2026-10-16T11:48:26.148Z"));
  });

  it("falls back to the session model and skips turns that metered nothing", () => {
    const records = parseKiroSessionDocument(
      sidecar([
        {
          end_timestamp: "2026-10-16T11:00:00Z",
          metering_usage: [{ value: 1, unit: "credit" }],
        },
        { end_timestamp: "2026-10-16T11:05:00Z", metering_usage: [] },
        { metering_usage: [{ value: 1, unit: "credit" }] },
      ]),
    );
    expect(records.map((record) => record.model)).toEqual(["claude-sonnet-5.5"]);
  });

  it("ignores documents that are not session sidecars", () => {
    expect(parseKiroSessionDocument({ hello: "world" })).toEqual([]);
    expect(parseKiroSessionDocument(null)).toEqual([]);
  });
});
