/**
 * Cloud agents in their own process, as the core reaches them (an experiment; the process's side is
 * services/cloudProcess.ts). The core asks them four things, each when a person does it and never in a
 * connection's line: a New Harness for a cloud agent, words for one, an answer to its question, and Stop.
 * Each is a request to the process (core/serviceLinks.ts `call`, which starts it when it is off); an answer
 * that does not come is the port's fallback (core/api.ts `CLOUD_FALLBACKS`): refused, with a reason.
 */
import { CLOUD_DOWN as DOWN, type CloudPort, type CloudResult } from './api.js'

/** Ask the cloud process (core/serviceLinks.ts `call`, for `cloud`): never rejects. */
export type CallCloud = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

/** An answer as the port's result: done, or the refusal it carried, or the fallback for one that is neither. */
function result(answer: Record<string, unknown>): CloudResult {
  if (answer.ok === true) return typeof answer.detail === 'string' ? { ok: true, detail: answer.detail } : { ok: true }
  if (answer.ok === false && typeof answer.error === 'string') return { ok: false, error: answer.error, ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
  return DOWN
}

export function createCloudLink(call: CallCloud): CloudPort {
  return {
    create: async (request) => {
      const answer = await call('create', request)
      if (answer.ok === true && answer.agent && typeof answer.agent === 'object') return { ok: true, agent: answer.agent as Record<string, unknown> }
      const refused = result(answer)
      return refused.ok ? DOWN : refused
    },
    deliver: async (agentId, text) => result(await call('deliver', { agentId, text })),
    answer: async (agentId, requestId, answers) => result(await call('answer', { agentId, requestId, answers })),
    stop: async (agentId) => result(await call('stop', { agentId })),
  }
}
