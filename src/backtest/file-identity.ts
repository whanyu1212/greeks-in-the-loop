import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

/** Detects lexical paths, symlinks, and hard links that identify the same file. */
export const pathsReferToSameFile = (left: string, right: string) => {
  if (resolve(left) === resolve(right)) return true
  if (!existsSync(left) || !existsSync(right)) return false
  const leftStat = statSync(left)
  const rightStat = statSync(right)
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}
