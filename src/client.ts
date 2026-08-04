/**
 * `videodraft/client` — the embeddable VideoDraft client.
 *
 * This is the supported programmatic surface for other VideoDraft software
 * (the macOS app's Bun sidecar imports this instead of reimplementing the
 * JSON-RPC/auth/polling stack). It must stay free of CLI concerns: no
 * commander, no prompts, no process.exit, no console output.
 *
 *   import { VideoDraftClient, resolveAuth } from "videodraft/client";
 *   const { tokenProvider, baseUrl } = resolveAuth({});  // reads the shared config store
 *   const client = new VideoDraftClient({ tokenProvider, baseUrl });
 *   const me = await client.callTool("whoami");
 */

export {
  VideoDraftClient,
  staticTokenProvider,
  type TokenProvider,
  type VideoDraftClientOptions,
  type McpToolInfo,
} from "./core/rpc.js";

export {
  resolveAuth,
  profileTokenProvider,
  type ResolvedAuth,
} from "./auth/token-provider.js";

export {
  configDir,
  configPath,
  readConfig,
  writeConfig,
  updateConfig,
  getProfile,
  DEFAULT_BASE_URL,
  type CliConfig,
  type Profile,
} from "./core/config.js";

export {
  pollGeneration,
  pollGenerations,
  pollGenerationsBatch,
  pollExport,
  extractOutputUrls,
  nextPollDelay,
  type GenerationResult,
  type PollOptions,
} from "./core/poll.js";

export {
  downloadUrl,
  downloadOutputs,
  renderTemplate,
  extFromUrl,
  type DownloadedFile,
} from "./core/download.js";

export { uploadFile, guessContentType, type UploadResult } from "./core/upload.js";

export {
  CliError,
  AuthError,
  RpcError,
  ToolError,
  TimeoutError,
  EXIT,
} from "./core/errors.js";

export {
  authorizeViaLoopback,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  probeClientId,
  registerCliClient,
  createPkcePair,
  buildAuthorizeUrl,
  STATIC_CLI_CLIENT_ID,
} from "./auth/oauth.js";
