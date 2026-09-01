import { acquireWorkerInstanceLock } from "../../src/event-ledger/deprecated/worker-instance-lock.js"

const ledgerPath = process.argv[2]
const releaseOnSignal = process.argv[3] === "release-on-signal"
if (ledgerPath === undefined) throw new Error("A ledger path is required")

const lock = acquireWorkerInstanceLock({ ledgerPath })
process.send?.("LOCKED")

if (releaseOnSignal) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      lock.release()
      process.exit(0)
    })
  }
}

setInterval(() => undefined, 1_000)
