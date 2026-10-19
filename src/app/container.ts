/**
 * 轻量服务容器：实例级、逆序释放、服务名拼错时列出可用项。
 *
 * @module if/app/container
 */

export class Container {
  private readonly services = new Map<string, unknown>()
  private readonly disposers: { readonly name: string; readonly dispose: () => void | Promise<void> }[] = []

  register<T>(name: string, value: T): void {
    if (this.services.has(name)) throw new Error(`service already registered: ${name}`)
    this.services.set(name, value)
  }

  get<T>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error(`service not found: ${name}; available: ${[...this.services.keys()].join(', ')}`)
    }
    return this.services.get(name) as T
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  onDispose(name: string, dispose: () => void | Promise<void>): void {
    this.disposers.push({ name, dispose })
  }

  /** 逆序释放：后注册的先关，避免依赖方先死。 */
  async dispose(): Promise<void> {
    for (const item of [...this.disposers].reverse()) {
      try {
        await item.dispose()
      } catch (error) {
        console.error(`[dispose] ${item.name}:`, error)
      }
    }
    this.disposers.length = 0
    this.services.clear()
  }
}
