import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

const telegram = {
  enabled: true,
  account_ref: "telegram-bridge",
  api_id_env: "TELEGRAM_API_ID",
  api_hash_file: "/not-read/hash",
  session_file: "/not-read/session",
};
const target = {
  id: "owner",
  channel: "telegram",
  account_ref: "telegram-bridge",
  peer_id_env: "OWNER_ID",
  principal_ref: "owner",
};
describe("configuration", () => {
  it("defaults to paused calling with bounded resources and no audio storage", () => {
    const result = parseConfig({});
    expect(result.calling).toMatchObject({
      enabled: false,
      max_concurrent_calls: 1,
      redial_attempts: 0,
      max_call_seconds: 600,
    });
    expect(result.service.listen).toBe("127.0.0.1:8787");
    expect(result.records.raw_audio).toBe(false);
    expect(result.live.store).toBe(false);
    expect(result.channels).toEqual({
      telegram: { enabled: false },
      whatsapp: { enabled: false },
    });
  });
  it("validates configured Telegram without requiring WhatsApp credentials or reading secrets", () => {
    const result = parseConfig({ channels: { telegram }, targets: [target] });
    expect(result.channels.whatsapp.enabled).toBe(false);
    expect(result.targets[0]?.enabled).toBe(true);
  });
  it("validates WhatsApp independently", () => {
    expect(
      parseConfig({
        channels: {
          whatsapp: {
            enabled: true,
            account_ref: "wa",
            endpoint: "http://localhost:8080",
            media_token_file: "/not-read/key",
          },
        },
      }).channels.telegram.enabled,
    ).toBe(false);
  });
  it("retains targets and credential references when a channel is paused", () => {
    const result = parseConfig({
      channels: { telegram: { ...telegram, enabled: false } },
      targets: [target],
    });
    expect(result.channels.telegram).toEqual({ ...telegram, enabled: false });
    expect(result.targets[0]?.id).toBe(target.id);
  });
  it("keeps WhatsApp callable after Telegram is paused with its entries retained", () => {
    const result = parseConfig({
      calling: { enabled: true },
      security: { control_token_file: "/not-read/control" },
      live: { api_key_file: "/not-read/live" },
      backend: {
        id: "backend",
        base_url: "http://localhost:8090",
        request_token_file: "/not-read/token",
        event_signing_key_file: "/not-read/events",
      },
      channels: {
        telegram: { ...telegram, enabled: false },
        whatsapp: {
          enabled: true,
          account_ref: "wa",
          endpoint: "http://localhost:8080",
          media_token_file: "/not-read/wa",
        },
      },
      targets: [
        target,
        { ...target, id: "owner-wa", channel: "whatsapp", account_ref: "wa" },
      ],
    });
    expect(result.calling.enabled).toBe(true);
    expect(result.channels.telegram.enabled).toBe(false);
    expect(result.channels.whatsapp.enabled).toBe(true);
  });
  it("does not treat a paused channel target as callable", () => {
    expect(() =>
      parseConfig({
        calling: { enabled: true },
        security: { control_token_file: "/not-read/control" },
        live: { api_key_file: "/not-read/live" },
        backend: {
          id: "backend",
          base_url: "http://localhost:8090",
          request_token_file: "/not-read/token",
          event_signing_key_file: "/not-read/events",
        },
        channels: { telegram: { ...telegram, enabled: false } },
        targets: [target],
      }),
    ).toThrow("Calling requires");
  });
  it("accepts independent ringing and connected duration limits", () => {
    expect(
      parseConfig({
        calling: { ring_timeout_seconds: 90, max_call_seconds: 60 },
      }).calling.max_call_seconds,
    ).toBe(60);
  });
  it.each([
    { calling: { max_call_seconds: 0 } },
    { calling: { max_concurrent_calls: 2 } },
    { calling: { redial_attempts: 1 } },
    { records: { raw_audio: true } },
    { channels: { telegram: { enabled: true } } },
    { unknown: true },
    { service: { listen: "0.0.0.0:8787" } },
    { calling: { enabled: true } },
    { channels: { telegram }, targets: [{ ...target, account_ref: "other" }] },
    { channels: { telegram }, targets: [target, target] },
  ])("rejects invalid or unsafe configuration %#", (input) =>
    expect(() => parseConfig(input)).toThrow(),
  );
  it("does not mutate input", () => {
    const input = {};
    parseConfig(input);
    expect(input).toEqual({});
  });
  it("never includes supplied values in errors", () =>
    expect(() => parseConfig({ secret: "sensitive" })).toThrow(
      "Invalid configuration at /secret",
    ));
});
