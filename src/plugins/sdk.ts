import type { ToolDefinition } from '../tools/types.ts'
import type { PluginDefinition, PluginPanel } from './types.ts'

/** 让工具定义获得稳定的上下文类型。 */
export function defineTool(tool: ToolDefinition): ToolDefinition {
  return tool
}

/** 让面板定义获得稳定的上下文类型。 */
export function definePanel(panel: PluginPanel): PluginPanel {
  return panel
}

/** 让插件定义获得稳定的上下文类型。 */
export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin
}
