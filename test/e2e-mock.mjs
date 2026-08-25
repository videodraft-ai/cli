/**
 * End-to-end test of the BUILT binary (dist/index.js) against a mock MCP
 * server. Exercises the full stack: commander → auth resolution → JSON-RPC →
 * polling → download → output/exit-code contract.
 *
 *   pnpm build && node test/e2e-mock.mjs
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// IMPORTANT: the mock server lives in THIS process — the CLI must run
// asynchronously (execFileSync would block the event loop and deadlock the
// child against a server that can never respond).
const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "dist", "index.js");
assert.ok(fs.existsSync(bin), "dist/index.js missing — run pnpm build first");

// ---------------------------------------------------------------------------
// Mock MCP server
// ---------------------------------------------------------------------------

let statusPolls = 0;
let batchRequests = 0;
const batchPolls = {};

// A valid 10 ms, mono, 8 kHz PCM WAV file. Keep the fixture tiny so the E2E
// exercises real audio download/content handling without slowing the suite.
const wavSamples = 80;
const wavFixture = Buffer.alloc(44 + wavSamples * 2);
wavFixture.write("RIFF", 0, "ascii");
wavFixture.writeUInt32LE(wavFixture.length - 8, 4);
wavFixture.write("WAVE", 8, "ascii");
wavFixture.write("fmt ", 12, "ascii");
wavFixture.writeUInt32LE(16, 16);
wavFixture.writeUInt16LE(1, 20); // PCM
wavFixture.writeUInt16LE(1, 22); // mono
wavFixture.writeUInt32LE(8_000, 24);
wavFixture.writeUInt32LE(16_000, 28);
wavFixture.writeUInt16LE(2, 32);
wavFixture.writeUInt16LE(16, 34);
wavFixture.write("data", 36, "ascii");
wavFixture.writeUInt32LE(wavSamples * 2, 40);
for (let i = 0; i < wavSamples; i++) {
  const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8_000) * 4_000);
  wavFixture.writeInt16LE(sample, 44 + i * 2);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/file.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end("PNGDATA");
    return;
  }
  if (req.method === "GET" && req.url === "/file.wav") {
    res.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": String(wavFixture.length),
    });
    res.end(wavFixture);
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/mcp") {
    res.writeHead(404).end();
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== "Bearer vd_mcp_test") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "unauthorized" },
      }),
    );
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const isBatch = Array.isArray(parsed);
    const rpcs = isBatch ? parsed : [parsed];

    const toolResult = (payload, isError = false) => ({
      content: [
        {
          type: "text",
          text: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
      ],
      isError,
    });

    const handle = (rpc) => {
      if (rpc.method === "tools/list") {
        return {
          tools: [
            {
              name: "whoami",
              description: "who",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "generate_image",
              description: "gen",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      }
      if (rpc.method !== "tools/call") return {};
      const { name, arguments: args } = rpc.params;
      switch (name) {
        case "whoami":
          return toolResult({
            user_id: "u_1",
            email: "e2e@test",
            workspace_id: "w_1",
            echo: args,
          });
        case "get_tool_catalog":
          return toolResult({
            tools: [
              {
                name: "whoami",
                description: "who",
                category: "account",
                lanes: ["account"],
                risks: [],
              },
              {
                name: "generate_image",
                description: "gen",
                category: "asset_generation",
                lanes: ["assets"],
                risks: [],
              },
            ],
          });
        case "get_credits_balance":
          return toolResult({
            planId: "pro",
            availableCredits: 1234,
            totalCreditsMonthly: 5000,
            monthlyCreditsUsed: 100,
            lastMonthlyReset: "2026-07-01T00:00:00.000Z",
            nextMonthlyReset: "2026-08-01T00:00:00.000Z",
          });
        case "generate_image":
          return toolResult({
            job_id: "job_123",
            status: "submitted",
            received: args,
          });
        case "generate_audio":
          return toolResult({
            success: true,
            audioUrl: `${baseUrl}/file.wav`,
            durationSeconds: 12,
            creditCost: 4,
            received: args,
          });
        case "check_generation_status": {
          if (args.job_id === "job_a" || args.job_id === "job_b") {
            // multi-wait jobs: job_a completes on its 2nd poll, job_b on its 1st
            batchPolls[args.job_id] = (batchPolls[args.job_id] ?? 0) + 1;
            const ready =
              args.job_id === "job_b" || batchPolls[args.job_id] >= 2;
            return toolResult(
              ready
                ? {
                    id: args.job_id,
                    status: "completed",
                    outputUrls: [`${baseUrl}/file.png`],
                  }
                : { id: args.job_id, status: "processing", outputUrls: [] },
            );
          }
          statusPolls++;
          return toolResult(
            statusPolls < 2
              ? { id: args.job_id, status: "processing", outputUrls: [] }
              : {
                  id: args.job_id,
                  status: "completed",
                  outputUrls: [`${baseUrl}/file.png`],
                },
          );
        }
        case "generate_video":
          // prompt "x" drives the insufficient-credits exit-4 test; anything
          // else echoes the received args so flag wiring can be asserted.
          if (args.prompt === "x")
            return toolResult(
              "Error: Insufficient credits for this operation",
              true,
            );
          return toolResult({
            job_id: "vjob",
            status: "submitted",
            received: args,
          });
        case "produce_project":
          return toolResult({ status: "production", received: args });
        case "finalize_scene_videos":
          return toolResult({
            finalized: 2,
            failed: 0,
            still_pending: 0,
            pending_remaining: 0,
          });
        case "attach_media_to_shot":
          return toolResult({ ok: true, received: args });
        case "describe_image":
          return toolResult({
            description: "a red fox in snow",
            received: args,
          });
        case "list_ai_studio_sessions":
          return toolResult({
            sessions: [
              { id: "sess_1", name: "Demo", created_at: "2026-06-01" },
            ],
          });
        case "create_ai_studio_session":
          return toolResult({ session_id: "sess_new", name: args.name });
        case "name_current_ai_studio_session":
          return toolResult({
            session: { id: "sess_current", name: args.name },
            renamed: true,
          });
        case "check_export_status":
          return toolResult({
            export_id: args.export_id ?? null,
            project_id: args.project_id ?? null,
            status: "finished",
            video_url: `${baseUrl}/file.png`,
          });
        case "generate_voiceover":
          return toolResult({
            speech_url: `${baseUrl}/file.wav`,
            duration: 2.1,
          });
        default:
          return toolResult(`Error: Unknown tool ${name}`, true);
      }
    };

    if (isBatch) batchRequests++;
    const responses = rpcs.map((rpc) => ({
      jsonrpc: "2.0",
      id: rpc.id,
      result: handle(rpc),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(isBatch ? responses : responses[0]));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vd-e2e-"));
const baseEnv = {
  ...process.env,
  VIDEODRAFT_BASE_URL: baseUrl,
  VIDEODRAFT_API_KEY: "vd_mcp_test",
  VIDEODRAFT_CONFIG_DIR: path.join(tmp, "config"),
  VIDEODRAFT_NO_UPDATE_CHECK: "1",
  VIDEODRAFT_SESSION: "",
  NO_COLOR: "1",
};

async function run(args, { env = {}, expectExit = 0 } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [bin, ...args], {
      env: { ...baseEnv, ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(
      0,
      expectExit,
      `expected exit ${expectExit} for ${args.join(" ")}, got 0`,
    );
    return stdout;
  } catch (err) {
    assert.equal(
      err.code,
      expectExit,
      `expected exit ${expectExit} for ${args.join(" ")}, got ${err.code}\n${err.stderr}\n${err.stdout}`,
    );
    return String(err.stdout ?? "");
  }
}

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const who = JSON.parse(await run(["whoami", "--json"]));
assert.equal(who.user_id, "u_1");
ok("whoami --json");

const credits = await run(["credits"]);
assert.match(credits, /1234/);
assert.match(credits, /pro/);
assert.match(credits, /2026-08-01/);
ok("credits (human)");

const tools = JSON.parse(await run(["tools", "list", "--json"]));
assert.equal(tools.length, 2);
ok("tools list --json");

const echo = JSON.parse(
  await run([
    "call",
    "whoami",
    "--arg",
    "num=2",
    "--arg",
    "label=a red fox",
    "--json",
  ]),
);
assert.equal(echo.echo.num, 2);
assert.equal(echo.echo.label, "a red fox");
ok("call --arg coercion");

const dl = path.join(tmp, "out", "{job_id}_{index}.{ext}");
const gen = JSON.parse(
  await run([
    "generate",
    "image",
    "a",
    "fox",
    "--download",
    dl,
    "--wait-interval",
    "50ms",
    "--json",
  ]),
);
assert.equal(gen.job_id, "job_123");
assert.equal(gen.status, "completed");
const saved = path.join(tmp, "out", "job_123_0.png");
assert.equal(fs.readFileSync(saved, "utf8"), "PNGDATA");
assert.equal(gen.downloaded_files[0].path, saved);
ok("generate image → poll → download template");

const seedAudio = JSON.parse(
  await run([
    "generate",
    "audio",
    "Continue",
    "@Audio1",
    "with",
    "rain",
    "--ref-audio",
    `${baseUrl}/file.wav`,
    "--voice",
    "vivi_mixed_en_zh_ja_es_id",
    "--format",
    "wav",
    "--sample-rate",
    "48000",
    "--speed",
    "1.1",
    "--volume",
    "0.9",
    "--pitch",
    "2",
    "--download",
    path.join(tmp, "seed-audio", "{name}_{index}.{ext}"),
    "--json",
  ]),
);
assert.deepEqual(seedAudio.received.audio_urls, [`${baseUrl}/file.wav`]);
assert.equal(seedAudio.received.voice, "vivi_mixed_en_zh_ja_es_id");
assert.equal(seedAudio.received.output_format, "wav");
assert.equal(seedAudio.received.sample_rate, 48000);
assert.equal(seedAudio.received.speed, 1.1);
assert.equal(seedAudio.received.volume, 0.9);
assert.equal(seedAudio.received.pitch, 2);
assert.match(
  seedAudio.received.idempotency_key,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
assert.deepEqual(seedAudio.output_media, [
  { kind: "audio", url: `${baseUrl}/file.wav` },
]);
const savedSeedAudio = path.join(tmp, "seed-audio", "seed-audio_0.wav");
assert.equal(seedAudio.downloaded_files[0].path, savedSeedAudio);
assert.equal(path.extname(savedSeedAudio), ".wav");
assert.deepEqual(fs.readFileSync(savedSeedAudio), wavFixture);
ok("generate audio: options, audio descriptor, extension, and WAV content");

const vo = JSON.parse(
  await run(["generate", "voiceover", "hello", "world", "--json"]),
);
assert.match(vo.speech_url, /file\.wav$/);
ok("generate voiceover returns speech_url");

const creditsErr = JSON.parse(
  await run(["generate", "video", "x", "--json"], { expectExit: 4 }),
);
assert.equal(creditsErr.exit_code, 4);
ok("insufficient credits → exit 4");

await run(["whoami"], {
  env: { VIDEODRAFT_API_KEY: "vd_mcp_wrong" },
  expectExit: 3,
});
ok("bad token → exit 3");

const exp = JSON.parse(await run(["export-status", "exp_1", "--json"]));
assert.equal(exp.export_id, "exp_1");
const expProj = JSON.parse(
  await run(["export-status", "proj_1", "--project", "--json"]),
);
assert.equal(expProj.project_id, "proj_1");
ok("export-status routes export_id vs --project");

assert.match(await run(["version"]), /^\d+\.\d+\.\d+/);
ok("version command");

await run(["nope-not-a-command"], { expectExit: 2 });
ok("unknown command → exit 2");

// --json contract holds even for commander usage errors (JSON envelope on stdout).
const usageJson = JSON.parse(
  await run(["nope-not-a-command", "--json"], { expectExit: 2 }),
);
assert.equal(usageJson.exit_code, 2);
assert.ok(
  typeof usageJson.error === "string" && usageJson.error.length > 0,
  "usage error has a message",
);
ok("usage error emits a JSON envelope under --json");

const skillPath = (await run(["skills", "path"])).trim();
assert.ok(
  fs.existsSync(path.join(skillPath, "SKILL.md")),
  "skills path resolves to bundled SKILL.md",
);
ok("skills path resolves from dist");

// skills show reads the build-time-baked blob (works in the compiled binary too).
const skillShow = JSON.parse(await run(["skills", "show", "--json"]));
assert.equal(skillShow.section, "SKILL.md");
assert.ok(
  skillShow.content.includes("Showing media to the user"),
  "skills show returns the canonical SKILL.md",
);
ok("skills show serves the embedded skill");

const skillAll = JSON.parse(await run(["skills", "show", "--all", "--json"]));
assert.deepEqual(Object.keys(skillAll.files).sort(), [
  "SKILL.md",
  "references/editor.md",
  "references/examples.md",
  "references/models.md",
  "references/pipeline.md",
]);
ok("skills show --all returns every skill file");

const editorSkill = JSON.parse(await run(["skills", "show", "editor", "--json"]));
assert.equal(editorSkill.section, "references/editor.md");
assert.ok(editorSkill.content.includes("both Code and VideoDraft modes"));
assert.ok(editorSkill.content.includes("make it the default surface for production"));
ok("skills show editor serves the native editor reference");

await run(["skills", "show", "nope", "--json"], { expectExit: 2 });
ok("skills show unknown-section → exit 2");

// A section named after a prototype member must be rejected, not crash.
await run(["skills", "show", "toString", "--json"], { expectExit: 2 });
ok("skills show prototype-key section → exit 2 (no crash)");

const multi = JSON.parse(
  await run([
    "wait",
    "job_a",
    "job_b",
    "--download",
    path.join(tmp, "multi", "{job_id}_{index}.{ext}"),
    "--wait-interval",
    "50ms",
    "--json",
  ]),
);
assert.equal(multi.length, 2);
assert.ok(
  multi.every((r) => r.status === "completed"),
  "both jobs completed",
);
assert.ok(
  fs.existsSync(path.join(tmp, "multi", "job_a_0.png")),
  "job_a downloaded",
);
assert.ok(
  fs.existsSync(path.join(tmp, "multi", "job_b_0.png")),
  "job_b downloaded",
);
assert.ok(
  batchRequests >= 1,
  "multi-wait used JSON-RPC batch requests (one HTTP call per tick)",
);
ok("multi-job wait: one process, batched polling, per-job downloads");

await run(["wait", "job_a", "job_b", "--download", "out.png"], {
  expectExit: 2,
});
ok("multi-job wait rejects an overwriting --download template (exit 2)");

// Seedance 2 reference videos and audio reach the generic generation tool.
const vid = JSON.parse(
  await run([
    "generate",
    "video",
    "subtle product motion",
    "--model",
    "seedance2",
    "--ref-video",
    `${baseUrl}/file.png`,
    "--ref-audio",
    `${baseUrl}/file.wav`,
    "--no-wait",
    "--json",
  ]),
);
assert.deepEqual(vid.received.reference_videos, [`${baseUrl}/file.png`]);
assert.deepEqual(vid.received.reference_audio, [`${baseUrl}/file.wav`]);
assert.equal("multi_prompt" in vid.received, false);
ok("generate video: --ref-video / --ref-audio reach the tool");

// Kling 3.0 Turbo: prompt is optional for multi-prompt-only calls.
const turbo = JSON.parse(
  await run([
    "generate",
    "video",
    "--model",
    "kling-v3-turbo",
    "--segment",
    "logo reveal:2",
    "--segment",
    "product spin:3",
    "--no-wait",
    "--json",
  ]),
);
assert.equal("prompt" in turbo.received, false, "no empty prompt sent");
assert.equal(turbo.received.model, "kling-v3-turbo");
assert.equal(turbo.received.multi_prompt.length, 2);
ok("generate video: prompt optional for Kling 3.0 Turbo multi-prompt");

await run(["generate", "video", "--model", "kling-v3-turbo"], {
  expectExit: 2,
});
ok("generate video: empty invocation (no prompt/segment/start-image) → exit 2");

const img = JSON.parse(
  await run([
    "generate",
    "image",
    "a fox",
    "--video-ref",
    `${baseUrl}/file.png`,
    "--no-wait",
    "--json",
  ]),
);
assert.equal(img.received.video_url, `${baseUrl}/file.png`);
ok("generate image: --video-ref reaches the tool (video_url)");

const prod = JSON.parse(
  await run([
    "produce",
    "proj_1",
    "--mode",
    "full_video",
    "--no-voiceover",
    "--captions",
    "--voice",
    "v1",
    "--json",
  ]),
);
assert.equal(prod.received.mode, "full_video");
assert.equal(prod.received.include_voiceover, false);
assert.equal(prod.received.show_captions, true);
assert.equal(prod.received.voice_id, "v1");
ok("produce: --mode full_video + tri-state flags reach the tool");

// Tri-state captions: unspecified must NOT send show_captions (server default applies).
const prodDefault = JSON.parse(await run(["produce", "proj_1", "--json"]));
assert.equal("show_captions" in prodDefault.received, false);
ok("produce: captions omitted when neither flag is passed");

const fin = JSON.parse(await run(["finalize", "proj_1", "--json"]));
assert.equal(fin.finalized, 2);
ok("finalize command swaps scene videos");

const att = JSON.parse(
  await run([
    "attach",
    "proj_1",
    "--scene",
    "0",
    "--shot",
    "1",
    "--media",
    `${baseUrl}/file.png`,
    "--type",
    "video",
    "--duration",
    "6",
    "--json",
  ]),
);
assert.equal(att.received.media_type, "video");
assert.equal(att.received.scene_index, 0);
assert.equal(att.received.duration_seconds, 6);
assert.equal(att.received.media_url, `${baseUrl}/file.png`);
ok("attach: places media on a shot (attach_media_to_shot)");

const desc = await run(["describe", `${baseUrl}/file.png`]);
assert.match(desc, /a red fox in snow/);
ok("describe: vision describe_image");

const sess = await run(["sessions", "create", "My session", "--json"]);
assert.match(sess, /sess_new/);
ok("sessions create returns a session id");

const named = JSON.parse(
  await run(["sessions", "name", "Purple Seal Rescue Short", "--json"]),
);
assert.equal(named.session.name, "Purple Seal Rescue Short");
assert.equal(named.renamed, true);
ok("sessions name titles the current automatic session");

const pinnedName = JSON.parse(
  await run(["sessions", "name", "Wrong Session", "--json"], {
    env: { VIDEODRAFT_SESSION: "sess_1" },
    expectExit: 2,
  }),
);
assert.equal(pinnedName.exit_code, 2);
assert.match(pinnedName.error, /VIDEODRAFT_SESSION/);
ok("sessions name refuses an explicit session override");

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nE2E: ${passed} checks passed`);
