import { getTrustedTime } from "../../src/research/trusted-time.js"

export default {
  description:
    "Returns the application host's current UTC time after this tool call begins. Use it to timestamp completion of the immediately preceding provider response.",
  args: {},
  async execute() {
    return getTrustedTime()
  },
}
