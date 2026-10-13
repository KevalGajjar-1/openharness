/**
 * A request body as `application/gzip` bytes of its JSON.
 *
 * Publications carry what people made (HTML, JavaScript, any text a session wrote), and Cloudflare's
 * managed rules in front of the Hub and its API refuse a body with raw `<script>` in it as an attack.
 * Gzipped, it reaches the backend, which unpacks and validates it as it would a raw one.
 */
export const gzipType = 'application/gzip';

export async function gzipJson(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Response(JSON.stringify(value)).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
