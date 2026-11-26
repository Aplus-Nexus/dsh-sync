/**
 * Public surface of the sync core.
 *
 * Everything the plugin, the CLI and the MCP server need is exported here so
 * that none of them reaches into internal files.
 */
export { deriveKey, seal, open, keyFingerprint, sameKey, ENVELOPE_VERSION } from './crypto.js'
export { FolderBackend, MemoryBackend } from './backends.js'
export { GitBackend, stripCredentials } from './git-backend.js'
export { SyncEngine } from './engine.js'
export {
  portableFromDshEvent,
  comparePortable,
  titleOf,
  contentText,
  portableBlocks,
  messageKey,
  PORTABLE_VERSION,
} from './portable.js'
export { DshSource, EmptySource, readPortableSession, originOf } from './dsh-source.js'
export {
  projectKey,
  encodeSegment,
  logPathFor,
  parseLogBytes,
  encodeLogBytes,
  localizeHeader,
  tailFrom,
  headerSummary,
  LOG_HEADER_TYPE,
} from './native.js'
export { importNativeSession, hasLocalSession, readLocalLog, digestOfBytes, writeLog } from './import.js'
export { synthesizeSession, synthesizeSessionId, encodeSynthesizedLog } from './synthesize.js'
export { mergeNativeBranches, buildConflictTail } from './native-merge.js'
export {
  readModelConfig,
  mergeModelConfig,
  stripModelSecrets,
  containsSecret,
  describeRoutes,
  profilePatchPath,
  SECRET_PLACEHOLDER,
} from './models.js'
export {
  encodeChunks,
  decodeChunk,
  chunkPath,
  nativePath,
  notePath,
  parseChunkName,
  parseNativeName,
  assertSegment,
  encodeNativeChunk,
  decodeNativeChunk,
  SALT_PATH,
} from './store.js'
export {
  collectExtras,
  publishExtras,
  readExtras,
  restoreExtras,
  removeExtras,
  redactSecrets,
  isSyncablePath,
} from './extras.js'
export {
  canonicalJson,
  digestOf,
  sha256,
  b64u,
  unb64u,
  randomId,
  nowMs,
  parseJson,
  parseJsonl,
  chunkByBytes,
  humanBytes,
  isoTime,
  deviceIdFrom,
} from './util.js'
