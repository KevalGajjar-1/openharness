/** Admission tests keep the original journal's limits and deterministic fault
 * points. Production catalog quotas and resource lifetime have separate HTTP,
 * storage and OS-process integration coverage. This is never a daemon fallback. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { createNativeHookJournal } from '../engines/kit/nativeHookJournal.js'
import type { NativeHookStorage } from '../engines/kit/nativeHookStorage.js'

export async function fixtureNativeHookAdmissionStorage(root: string): Promise<NativeHookStorage> {
  let closed = false
  const journals = new Set<ReturnType<typeof createNativeHookJournal>>()
  return {
    async effects(processKey, current = () => true) {
      if (closed) throw Error('fixture hook storage is closed')
      // Resolve per fixture so a test's injected journal failure is not hidden
      // by the hoisted storage mock's module cache. This adapter is test-only.
      const { createNativeHookJournal } = await import('../engines/kit/nativeHookJournal.js')
      const journal = createNativeHookJournal({
        directory: join(root, createHash('sha256').update(processKey).digest('hex')),
        processKey, current: () => !closed && current(),
      })
      journals.add(journal)
      return journal
    },
    async outbox() { throw Error('client outboxes require the storage integration fixture') },
    async close() { closed = true; for (const journal of journals) journal.close() },
  }
}
