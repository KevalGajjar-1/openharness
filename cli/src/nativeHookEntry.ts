/** Build this entry into one standalone notify.mjs for every distribution. */
import { runNotify } from '../hook/notify.mjs'
import { createNativeNotifyCursor, nativeNotifyRuntime } from './engines/kit/nativeNotifyCursor.js'
import type { ProcessImageArtifact } from './lib/nativeProcessImageArtifact.js'

declare const __DARWIN_PROCESS_IMAGES__: string | undefined
const selfPid = process.pid
const source = typeof __DARWIN_PROCESS_IMAGES__ === 'undefined' ? undefined : __DARWIN_PROCESS_IMAGES__
let artifact: ProcessImageArtifact | undefined
try { if (source) artifact = JSON.parse(source) as ProcessImageArtifact } catch { /* Missing evidence holds the client. */ }
void runNotify({ nativeCursor: createNativeNotifyCursor({ selfPid, artifact }), captureNativeRuntime: nativeNotifyRuntime })
