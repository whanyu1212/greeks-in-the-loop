import { Client, type PoolConfig } from "pg"

import {
  WorkerInstanceLockInitializationError,
  WorkerInstanceLockReleaseError,
  WorkerInstanceLockUnavailableError,
} from "./worker-instance-lock-errors.js"

export type PostgresWorkerInstanceLock = Readonly<{
  release(): Promise<void>
}>

/** Holds a PostgreSQL session advisory lock for one worker deployment. */
export async function acquirePostgresWorkerInstanceLock(
  poolConfig: PoolConfig,
  lockName = "greeks-in-the-loop:research-worker",
): Promise<PostgresWorkerInstanceLock> {
  const client = new Client({
    application_name: "greeks-in-the-loop-worker-lock",
    connectionTimeoutMillis: 10_000,
    ...poolConfig,
  })
  try {
    await client.connect()
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockName],
    )
    if (result.rows[0]?.acquired !== true) {
      await client.end()
      throw new WorkerInstanceLockUnavailableError()
    }
  } catch (error) {
    if (error instanceof WorkerInstanceLockUnavailableError) throw error
    await client.end().catch(() => undefined)
    throw new WorkerInstanceLockInitializationError()
  }

  let released = false
  return {
    async release() {
      if (released) return
      try {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [lockName],
        )
        if (result.rows[0]?.released !== true) {
          throw new Error("PostgreSQL worker lock was not held")
        }
        await client.end()
        released = true
      } catch {
        await client.end().catch(() => undefined)
        throw new WorkerInstanceLockReleaseError()
      }
    },
  }
}
