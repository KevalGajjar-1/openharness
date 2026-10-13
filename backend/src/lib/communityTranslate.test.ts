import { describe, expect, it, vi } from 'vitest'
import { batchesOf, parseTranslation, translateDraft, translationLimits, TranslationTooLong } from './communityTranslate.js'

/** A model that answers each asked item by [answer], read back from the prompt it was given. */
const model = (answer: (text: string) => string | null) => vi.fn(async (prompt: string) => {
  const items = JSON.parse(prompt.slice(prompt.indexOf('Items:\n') + 7)) as { i: number; text: string }[]
  return { text: JSON.stringify({ items: items.map(({ i, text }) => { const en = answer(text); return en === null ? { i, same: true } : { i, en } }) }) }
})

describe('translateDraft', () => {
  it('translates the title, description and people\'s turns, keeping tool output as it is', async () => {
    const ask = model(text => text.startsWith('EN:') ? null : `EN:${text}`)
    const result = await translateDraft({
      title: 'Trò chơi rắn', description: 'EN: already English',
      conversation: [{ role: 'user', text: 'làm game rắn' }, { role: 'tool', text: 'npm ERR! lỗi' }, { role: 'assistant', text: 'Xong rồi' }],
    }, ask)
    expect(result).toEqual({
      title: 'EN:Trò chơi rắn', description: 'EN: already English',
      conversation: [{ role: 'user', text: 'EN:làm game rắn' }, { role: 'tool', text: 'npm ERR! lỗi' }, { role: 'assistant', text: 'EN:Xong rồi' }],
      translated: true,
    })
    expect(ask.mock.calls[0][0]).not.toContain('npm ERR!')
  })

  it('says nothing was translated when every item is already English', async () => {
    const result = await translateDraft({ title: 'Snake', description: '', conversation: [{ role: 'user', text: 'Make a snake game' }] }, model(() => null))
    expect(result.translated).toBe(false)
    expect(result.title).toBe('Snake')
  })

  it('asks nothing for an empty draft', async () => {
    const ask = model(() => null)
    expect((await translateDraft({ title: '', description: '', conversation: [{ role: 'tool', text: 'log' }] }, ask)).translated).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps a translated title within what the Hub accepts', async () => {
    const result = await translateDraft({ title: 'Tiêu đề', description: '', conversation: [] }, model(() => 'x'.repeat(150)))
    expect(result.title).toHaveLength(100)
  })

  it('retries an incomplete reply once, then fails rather than publishing half a translation', async () => {
    const ask = vi.fn(async () => ({ text: '{"items":[]}' }))
    await expect(translateDraft({ title: 'Tiêu đề', description: '', conversation: [] }, ask)).rejects.toThrow('incomplete')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('refuses a draft longer than one request may translate, without asking', async () => {
    const ask = model(() => null)
    const conversation = Array.from({ length: 8 }, () => ({ role: 'user' as const, text: 'x'.repeat(11_000) }))
    await expect(translateDraft({ title: 't', description: '', conversation }, ask)).rejects.toBeInstanceOf(TranslationTooLong)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('batchesOf', () => {
  it('packs items up to the batch size, skips blanks, and sends a long item alone', () => {
    expect(batchesOf([{ text: 'aaaa' }, { text: '' }, { text: 'bbbb' }, { text: 'c'.repeat(20) }, { text: 'dd' }], 10)).toEqual([[0, 2], [3], [4]])
    expect(translationLimits.batchChars).toBeLessThan(translationLimits.totalChars)
  })
})

describe('parseTranslation', () => {
  it('reads a fenced reply and ignores items it was not asked about', () => {
    const answers = parseTranslation('Sure:\n```json\n{"items":[{"i":0,"en":"Hello"},{"i":2,"same":true},{"i":9,"en":"x"}]}\n```', [0, 2])
    expect(answers).toEqual(new Map([[0, 'Hello'], [2, null]]))
  })
  it('is null when an asked item is missing or blank', () => {
    expect(parseTranslation('{"items":[{"i":0,"en":"Hello"}]}', [0, 1])).toBeNull()
    expect(parseTranslation('{"items":[{"i":0,"en":"  "}]}', [0])).toBeNull()
    expect(parseTranslation('not json', [0])).toBeNull()
  })
})
