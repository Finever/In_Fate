/** App 层可翻译成 HTTP 状态码的错误。 */

export class AgentModelMissingError extends Error {
  readonly code = 'EAGENTMODEL'
  readonly agentId: string

  constructor(agentId: string) {
    super(`agent has no model configured: ${agentId}`)
    this.name = 'AgentModelMissingError'
    this.agentId = agentId
  }
}

export class AgentModelInvalidError extends Error {
  readonly code = 'EAGENTMODELINVALID'
  readonly agentId: string

  constructor(agentId: string, message: string) {
    super(`agent model is invalid: ${agentId}: ${message}`)
    this.name = 'AgentModelInvalidError'
    this.agentId = agentId
  }
}
