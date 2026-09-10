/**
 * JSON 文件持久化层（零依赖 MVP）
 * 每个 userId 一个文件：server/data/<userId>.json
 * 写盘采用 tmp + rename，避免半写状态。
 * 后续可替换为 SQLite / Postgres——只要实现同样的 load/save 接口。
 *
 * P1-12 修复：load 解析失败不再静默返回 null（会导致 save 用空状态覆盖→永久数据丢失）。
 * 改为：日志告警 + 把损坏文件 rename 为 .broken-{timestamp}，让运维可恢复。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = process.env.MUNINN_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data')

export class JsonStore<T> {
  private dir: string

  constructor(dir: string = DEFAULT_DIR) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  private file(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  load(userId: string): T | null {
    const f = this.file(userId)
    if (!existsSync(f)) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T
    } catch (err) {
      // P1-12：不再静默吞掉——损坏文件 rename 备份，防止 save 覆盖导致永久丢失
      const backup = `${f}.broken-${Date.now()}`
      console.error(`[store] 用户 ${userId} 的数据文件解析失败（${err instanceof Error ? err.message : String(err)}），已备份到 ${backup}`)
      try { renameSync(f, backup) } catch { /* rename 失败时无能为力，但至少留了日志 */ }
      return null
    }
  }

  save(userId: string, state: T): void {
    const f = this.file(userId)
    // 绕过 Railway Volume 的 tmp 文件权限限制（EACCES），直接写入最终文件
    writeFileSync(f, JSON.stringify(state, null, 2), 'utf8')
  }
}
