import { promises as fs } from 'fs'
import { join } from 'path'
import type { Task, Settings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

export class Store {
  constructor(private baseDir: string) {}

  private tasksPath(): string { return join(this.baseDir, 'tasks.json') }
  private settingsPath(): string { return join(this.baseDir, 'settings.json') }

  async loadTasks(): Promise<Task[]> {
    return this.readJson<Task[]>(this.tasksPath(), [])
  }
  async saveTasks(tasks: Task[]): Promise<void> {
    await this.writeJsonAtomic(this.tasksPath(), tasks)
  }
  async loadSettings(): Promise<Settings> {
    return this.readJson<Settings>(this.settingsPath(), DEFAULT_SETTINGS)
  }
  async saveSettings(settings: Settings): Promise<void> {
    await this.writeJsonAtomic(this.settingsPath(), settings)
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as T
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return fallback
      // 主文件损坏 → 尝试 .bak
      try {
        return JSON.parse(await fs.readFile(path + '.bak', 'utf8')) as T
      } catch {
        return fallback
      }
    }
  }

  private async writeJsonAtomic(path: string, data: unknown): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true })
    const tmp = path + '.tmp'
    const bak = path + '.bak'
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    try {
      await fs.copyFile(path, bak) // 覆盖前备份旧版本
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') throw err
    }
    await fs.rename(tmp, path)
  }
}
