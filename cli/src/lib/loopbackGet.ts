/**
 * A GET to a program listening on this computer's loopback, answered with its HTTP status: how a sign-in a phone
 * caught is handed to the program that started it (core/terminals/browser.ts). Resolves on the response's head;
 * the program may keep the body, or the connection, as long as it likes.
 */
import http from 'node:http'

export function loopbackGet(url: string, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('timeout', () => request.destroy(new Error('The program did not answer.')))
    request.on('error', reject)
  })
}
