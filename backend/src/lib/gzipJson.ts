/**
 * Request bodies the Hub sends gzipped: the JSON a route reads, as `application/gzip` bytes.
 *
 * Publications carry what people made (HTML, JavaScript, any text a session wrote), and Cloudflare's
 * managed rules in front of harness.autonomous.ai and this API refuse a body with raw `<script>` in
 * it as an attack. Gzipped, such a body reaches the route, which validates it as it would a raw one.
 * Unpacking is bounded, so a small body cannot inflate past `maxBytes`.
 */
import { gunzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { ValidationError } from '../errors/index.js'

export const GZIP_JSON_TYPE = 'application/gzip'

export function gunzipJson(body: Buffer, maxBytes: number): unknown {
  try {
    return JSON.parse(gunzipSync(body, { maxOutputLength: maxBytes }).toString('utf8'))
  } catch {
    throw new ValidationError('Invalid compressed body.')
  }
}

/** Lets `app`'s routes read a gzipped body as the JSON it carries; each route's own bodyLimit still bounds what was sent. */
export function acceptGzipJson(app: FastifyInstance, maxBytes: number): void {
  app.addContentTypeParser(GZIP_JSON_TYPE, { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      done(null, gunzipJson(body as Buffer, maxBytes))
    } catch (error) {
      done(error as Error, undefined)
    }
  })
}
