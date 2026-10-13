/**
 * The card without its `update`. That sentence is the Pro's alone (a local cable tee); the relay to the cloud and the
 * Wi-Fi devices get the card as they always did.
 */
export function withoutUpdate<T extends { type?: string; payload?: unknown }>(frame: T): T {
  const payload = frame.payload as Record<string, unknown> | undefined
  if (frame.type !== 'commander_event' || !payload || payload.kind !== 'processing' || !('update' in payload)) return frame
  const { update: _update, ...rest } = payload
  return { ...frame, payload: rest }
}

/** True for a card that is the local devices' alone (a shell result or a turn's start for the turn stats, or the streaming reply text): never relayed. */
export function isLocalOnly(frame: { type?: string; payload?: unknown }): boolean {
  const kind = (frame.payload as { kind?: unknown } | undefined)?.kind
  return frame.type === 'commander_event' && (kind === 'tool_end' || kind === 'turn_started' || kind === 'reply_text')
}

/** A tool_end without `outputTail`: that tail is the turn stats' input and goes to the local devices alone,
 * never to a client, a relay or a history page. */
export function withoutOutputTail<T extends { type?: string; payload?: unknown }>(event: T): T {
  if (event.type !== 'tool_end' || !event.payload || !('outputTail' in (event.payload as object))) return event
  const { outputTail: _tail, ...payload } = event.payload as Record<string, unknown>
  return { ...event, payload }
}
