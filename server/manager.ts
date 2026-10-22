/**
 * 多用户引擎管理：按需加载、惰性实例化、变更后落盘。
 * P1-1 修复：per-user 异步锁——reflect/ingest/counterCheck 等含 await 的操作
 * 在并发调用时会因控制权交出而状态突变；withLock 保证同一用户的操作串行执行。
 */
import { HeadlessMuninn, type MuninnState } from './core'
import { JsonStore } from './store'
import { loadStamps } from './services/stamps'

export class EngineManager {
  private engines = new Map<string, HeadlessMuninn>()
  private store = new JsonStore<MuninnState>()
  /** P1-1：per-user Promise 链，串行化含 await 的引擎操作 */
  private locks = new Map<string, Promise<unknown>>()

  get(userId: string): HeadlessMuninn {
    let e = this.engines.get(userId)
    if (!e) {
      e = new HeadlessMuninn(this.store.load(userId))
      // 注入情感层印章状态，让 getContextPacket 可返回 recentStamps
      e.setStamps(loadStamps(userId))
      this.engines.set(userId, e)
    }
    return e
  }

  /**
   * P1-1：串行化执行含 await 的引擎操作，防止并发状态突变。
   * 用法：await manager.withLock(uid, e => e.ingest(text))
   *      await manager.withLock(uid, e => e.reflect())
   * 读操作（getContextPacket / listClaims / getState）无需加锁——它们不突变状态（P1-2 修复后）。
   */
  async withLock<T>(userId: string, fn: (e: HeadlessMuninn) => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    this.locks.set(userId, prev.then(() => gate))
    await prev
    try {
      const e = this.get(userId)
      const result = await fn(e)
      this.persist(userId)
      return result
    } finally {
      release()
    }
  }

  /** 触发反刍：自动注入 userId 以生成日记/心迹 */
  async reflect(userId: string): Promise<Awaited<ReturnType<HeadlessMuninn['reflect']>>> {
    return this.withLock(userId, (e) => e.reflect(userId))
  }

  /** 有变更才写盘（tmp + rename 原子写） */
  persist(userId: string): void {
    const e = this.engines.get(userId)
    if (e?.isDirty()) {
      this.store.save(userId, e.getState())
      e.markClean()
    }
  }

  /** 当前已加载进内存的用户（自动反刍用；不做全目录扫描） */
  loadedUserIds(): string[] {
    return [...this.engines.keys()]
  }
}
