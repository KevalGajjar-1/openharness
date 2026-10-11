/**
 * Agents a service owns: the cloud agents (docs/design/2026-10-11-cloud-agents.md, "The one core change").
 * They have no pane, so they are never registry rows. The cloud service publishes them through `core.cloud`
 * (`doors`); the core keeps the last list, sends each change to the apps and the dial as any agent's frame
 * (`location: 'cloud'`), and puts their questions wherever questions show. What a person does to one comes
 * back here first: a New Harness for a cloud agent, words for it, an answer to its question and Stop are
 * handed to the service's port, and everything else goes on to the terminal agents' own paths.
 */
import type { CloudCore, CloudPort, CloudResult } from '../api.js'
import { CLOUD_DOWN } from '../api.js'
import { cloudAgentFrame, cloudHarnessIn, isCloudAgent, type CloudAgentFrame, type CloudHarness } from '../../lib/cloudAgents.js'
import type { AutonomousDeviceInput } from '../deviceInput.js'
import type { QuestionAnswerResult } from '../../lib/questionController.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface CloudAgentsDeps {
  /** The cloud service's port, or null while it is off. */
  port: () => CloudPort | null
  /** Every client (`send`), the dial (`sendCommander`) and the windows on this computer (`sendLocal`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void; sendLocal(frame: Frame): void }
  /** What is still being asked, by agent, for a window that connects later (core/questions.ts). */
  openQuestions: Map<string, Record<string, unknown>>
  deviceInput: Pick<AutonomousDeviceInput, 'setUserAction'>
  log?: (line: string) => void
}

const DOWN = async (): Promise<typeof CLOUD_DOWN> => CLOUD_DOWN

export function createCloudAgents({ port, clients, openQuestions, deviceInput, log = (line) => console.log(line) }: CloudAgentsDeps) {
  let harnesses = new Map<string, CloudHarness>()
  /** Each open question's agent, by request id: an answer to one of these goes to the service. */
  const asked = new Map<string, string>()

  const sync = (harness: CloudHarness): void => {
    const frame: Frame = { type: 'agent_synced', payload: { agent: cloudAgentFrame(harness) } }
    clients.send(frame)
    // The dial lists the harnesses it can drive: a stopped one leaves its wheel.
    clients.sendCommander(harness.state === 'stopped' ? { type: 'agent_deleted', payload: { agentId: harness.agentId } } : frame)
  }
  const gone = (agentId: string): void => {
    const frame: Frame = { type: 'agent_deleted', payload: { agentId } }
    clients.send(frame)
    clients.sendCommander(frame)
  }

  const doors: CloudCore = {
    publish(list) {
      const next = new Map<string, CloudHarness>()
      for (const raw of Array.isArray(list) ? list : []) {
        const harness = cloudHarnessIn(raw)
        if (harness) next.set(harness.agentId, harness)
      }
      const before = harnesses
      harnesses = next
      for (const [agentId, harness] of next) if (JSON.stringify(before.get(agentId)) !== JSON.stringify(harness)) sync(harness)
      for (const agentId of before.keys()) if (!next.has(agentId)) gone(agentId)
    },
    ask(agentId, requestId, question) {
      if (!harnesses.has(agentId) || typeof requestId !== 'string' || !requestId.startsWith('cloud_q_') || typeof question?.text !== 'string') return
      const choices = (Array.isArray(question.choices) ? question.choices : []).filter((choice): choice is string => typeof choice === 'string' && !!choice).slice(0, 6)
      asked.set(requestId, agentId)
      const frame: Frame = {
        type: 'commander_question', agentId, dbSessionId: agentId,
        // As a terminal agent's question (core/questions.ts): one key, its choices, and free text, which the
        // windows take and the dial does not.
        payload: { requestId, questions: [{ key: 'answer', q: question.text.slice(0, 500), options: choices, multi: false, canText: true }], notification: { id: requestId, kind: 'needsYou' } },
      }
      deviceInput.setUserAction(agentId, true)
      clients.sendCommander(frame)
      clients.sendLocal(frame)
      openQuestions.set(agentId, frame)
      log(`[cloud] ${agentId} asking the person · req=${requestId}`)
    },
    unask(agentId, requestId) {
      if (asked.get(requestId) !== agentId) return
      asked.delete(requestId)
      const frame: Frame = { type: 'commander_question_close', agentId, dbSessionId: agentId, payload: { requestId } }
      deviceInput.setUserAction(agentId, false)
      clients.sendCommander(frame)
      clients.sendLocal(frame)
      openQuestions.delete(agentId)
    },
  }

  const call = async <T>(work: (cloud: CloudPort) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    const cloud = port()
    return cloud ? work(cloud) : fallback()
  }

  return {
    doors,
    /** Every cloud harness's frame, for `agents_list`. */
    frames: (): CloudAgentFrame[] => [...harnesses.values()].map(cloudAgentFrame),
    owns: (agentId: string): boolean => harnesses.has(agentId),
    /** `agent_create` for a cloud agent, answered as the socket answers one (`{ agent }`, or the refusal); null for any other engine. */
    create(payload: Record<string, unknown>): Promise<Record<string, unknown>> | null {
      if (!isCloudAgent(payload.engine)) return null
      return call((cloud) => cloud.create(payload), DOWN).then((result) => (result.ok ? { agent: result.agent } : { error: result.error, ...(result.detail ? { detail: result.detail } : {}) }))
    },
    /** Words for a cloud harness; null when it is not one. */
    deliver(agentId: string, text: string): Promise<CloudResult> | null {
      if (!harnesses.has(agentId)) return null
      return call((cloud) => cloud.deliver(agentId, text), DOWN)
    },
    /** `question_response` to a cloud harness's question, answered as a terminal agent's is; null when it is not one. */
    answer(payload: { requestId?: unknown; answers?: unknown }): Promise<QuestionAnswerResult> | null {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      const agentId = asked.get(requestId)
      if (!agentId) return null
      const answers = Object.fromEntries(Object.entries(payload.answers && typeof payload.answers === 'object' ? payload.answers : {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      return call((cloud) => cloud.answer(agentId, requestId, answers), DOWN)
        .then((result): QuestionAnswerResult => (result.ok ? { ok: true }
          : { ok: false, error: result.error === 'STALE_QUESTION' ? 'STALE_QUESTION' : 'ANSWER_FAILED', detail: result.detail ?? '' }))
    },
    /** Stop Harness for a cloud harness, answered as `agent_delete` is; null when it is not one. */
    stop(agentId: string): Promise<Record<string, unknown>> | null {
      if (!harnesses.has(agentId)) return null
      return call((cloud) => cloud.stop(agentId), DOWN)
        .then((result) => (result.ok ? { deleted: true, ...(result.detail ? { detail: result.detail } : {}) } : { error: result.error, ...(result.detail ? { detail: result.detail } : {}) }))
    },
  }
}

export type CloudAgents = ReturnType<typeof createCloudAgents>
