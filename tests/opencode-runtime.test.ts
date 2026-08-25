import { describe, expect, it } from "vitest"

import { createOpencodeEnvironment } from "../src/opencode-runtime.js"

describe("createOpencodeEnvironment", () => {
  it("removes settings that can replace the checked-in agent policy", () => {
    const environment = createOpencodeEnvironment(
      {
        HOME: "/tmp/home",
        OPENCODE_AGENT: "build",
        OPENCODE_CONFIG: "/tmp/unsafe.json",
        OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}',
        OPENCODE_CONFIG_DIR: "/tmp/unsafe",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/tmp/user-config",
      },
      "/tmp/runtime-config",
    )

    expect(environment).toEqual({
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/runtime-config",
    })
  })
})
