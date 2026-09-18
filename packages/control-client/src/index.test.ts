import { afterEach, expect, test, vi } from "vitest";
import { ControlClient, clientFromEnvironment } from "./index.js";

afterEach(() => vi.unstubAllGlobals());
const client = () =>
  new ControlClient("https://voice.example", "private-agent-token", 10);
const input = {
  target_id: "target",
  context_ref: "context",
  correlation_ref: "correlation",
  expires_at: "2026-09-18T00:00:00Z",
  idempotency_key: "stable-key",
};

test("only a fixed HTTPS origin or loopback HTTP and a bounded timeout are accepted", () => {
  for (const origin of [
    "http://voice.example",
    "https://user:pass@voice.example",
    "https://voice.example/?token=x",
    "https://voice.example/#x",
    "https://voice.example/prefix",
    "file:///tmp/token",
  ]) {
    expect(() => new ControlClient(origin, "token")).toThrow(
      "invalid_configuration",
    );
  }
  expect(
    () => new ControlClient("http://127.0.0.1:9000", "token"),
  ).not.toThrow();
  expect(() => new ControlClient("https://voice.example", "token\n")).toThrow(
    "invalid_configuration",
  );
  expect(
    () => new ControlClient("https://voice.example", "token", 60001),
  ).toThrow("invalid_configuration");
});

test("admin token environment variables cannot configure the MCP client", async () => {
  await expect(
    clientFromEnvironment({
      VOXDOCK_BASE_URL: "https://voice.example",
      VOXDOCK_API_TOKEN: "admin-token",
    }),
  ).rejects.toMatchObject({ code: "invalid_configuration" });
});

test("redirects are not followed and raw upstream bodies are not exposed", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response("private-agent-token", {
        status: 302,
        headers: { location: "https://other.example" },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  await expect(client().getCall("call-1")).rejects.toMatchObject({
    code: "rejected",
    status: 302,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
});

test("read errors and unknown mutation outcomes do not retry", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error("private-agent-token"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(client().createCall(input)).rejects.toMatchObject({
    code: "outcome_unknown",
    message: "outcome_unknown",
  });
  await expect(client().getCall("call-1")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("oversized and malformed success responses cannot report mutation success", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() =>
      Promise.resolve(new Response("x".repeat(65537))),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ state: "connected" })),
    );
  vi.stubGlobal("fetch", fetchMock);
  await expect(client().endCall("call-1")).rejects.toMatchObject({
    code: "outcome_unknown",
  });
  await expect(client().createCall(input)).rejects.toMatchObject({
    code: "outcome_unknown",
  });
});

test("invalid inputs never perform HTTP calls", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    client().createCall({ ...input, phone: "+123" } as typeof input),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(client().getCall("?token=secret")).rejects.toMatchObject({
    code: "invalid_input",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("timeout aborts the request and preserves unknown mutation outcome", async () => {
  const fetchMock = vi.fn(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(client().endCall("call-1")).rejects.toMatchObject({
    code: "outcome_unknown",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
