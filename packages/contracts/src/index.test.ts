import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import { CallRequestSchema, DelegationResultSchema } from "./index.js";
const request = {
  target_id: "owner-telegram",
  context_ref: "task:1",
  correlation_ref: "delivery:1",
  expires_at: "2026-09-17T09:05:00Z",
};
it("requires a fixed target, correlation and expiry", () => {
  expect(Value.Check(CallRequestSchema, request)).toBe(true);
  expect(
    Value.Check(CallRequestSchema, { ...request, expires_at: undefined }),
  ).toBe(false);
  expect(
    Value.Check(CallRequestSchema, { ...request, target_id: "@arbitrary" }),
  ).toBe(false);
  expect(
    Value.Check(CallRequestSchema, {
      ...request,
      callback_url: "https://example.com",
    }),
  ).toBe(false);
});
it("requires identified revisioned delegation results", () => {
  expect(
    Value.Check(DelegationResultSchema, {
      result_id: "r1",
      delegation_id: "d1",
      call_id: "c1",
      revision: 1,
      status: "accepted",
      spoken_summary: "Queued.",
    }),
  ).toBe(true);
  expect(
    Value.Check(DelegationResultSchema, {
      status: "completed",
      spoken_summary: "Done.",
    }),
  ).toBe(false);
});
