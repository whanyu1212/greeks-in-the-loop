import { describe, expect, it } from "vitest"

import {
  createOpencodeEnvironment,
  startOpencode,
} from "../src/opencode-runtime.js"

describe("createOpencodeEnvironment", () => {
  it("removes settings that can replace the checked-in agent policy", () => {
    const environment = createOpencodeEnvironment(
      {
        HOME: "/tmp/home",
        OPENCODE_AGENT: "build",
        OPENCODE_CONFIG: "/tmp/unsafe.json",
        OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}',
        OPENCODE_CONFIG_DIR: "/tmp/unsafe",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
        PATH: "/usr/bin",
        PHOENIX_API_KEY: "secret",
        PHOENIX_CLIENT_HEADERS: '{"authorization":"secret"}',
        Phoenix_Api_Key: "case-insensitive-secret",
        otel_exporter_otlp_headers: "authorization=case-insensitive-secret",
        XDG_CONFIG_HOME: "/tmp/user-config",
      },
      "/tmp/runtime-config",
    )

    expect(environment).toEqual({
      HOME: "/tmp/home",
      OTEL_SDK_DISABLED: "true",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/runtime-config",
    })
  })
})

describe("startOpencode", () => {
  it("does not spawn when shutdown was already requested", async () => {
    const reason = new Error("shutdown")

    await expect(
      startOpencode({
        port: 4096,
        signal: AbortSignal.abort(reason),
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(reason)
  })
})
