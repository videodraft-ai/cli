import { describe, expect, it } from "vitest";
import { modelTable } from "../src/cli/model-table.js";

// Registry order as the live catalog returns it: Tier 2 Veo and Sora between the Tier 1 models.
const video = {
  recommended: {
    generation: [
      "gemini-omni-1.1-flash",
      "seedance-2.5",
      "seedance-2",
      "kling-3.0",
      "kling-o3",
      "minimax-h3-max",
    ],
    video_edit: [
      "gemini-omni-1.1-flash",
      "grok-imagine-video-edit",
      "happy-horse-video-edit",
      "kling-o3-video-ref-edit",
    ],
  },
  models: [
    {
      id: "gemini-omni-1.1-flash",
      name: "Gemini Omni 1.1 Flash",
      tier: 1,
      category: "generation",
      tool: "generate_video",
      credit_cost: 100,
    },
    {
      id: "google-veo3",
      name: "Veo 3",
      tier: 2,
      category: "generation",
      tool: "generate_video",
      credit_cost: 160,
    },
    {
      id: "google-veo3.1",
      name: "Veo 3.1",
      tier: 2,
      category: "generation",
      tool: "generate_video",
      credit_cost: 60,
    },
    {
      id: "kling-3.0",
      name: "Kling 3.0",
      tier: 1,
      category: "generation",
      tool: "generate_video",
      credit_cost: 65,
    },
    {
      id: "kling-o3",
      name: "Kling O3",
      tier: 1,
      category: "generation",
      tool: "generate_video",
      credit_cost: 60,
    },
    {
      id: "sora-2",
      name: "Sora 2",
      tier: 2,
      category: "generation",
      tool: "generate_video",
      credit_cost: 40,
    },
    {
      id: "seedance-2",
      name: "Seedance 2.0",
      tier: 1,
      category: "generation",
      tool: "generate_video",
      credit_cost: 80,
    },
    {
      id: "seedance-2.5",
      name: "Seedance 2.5",
      tier: 1,
      category: "generation",
      tool: "generate_video",
      credit_cost: 240,
    },
    {
      id: "minimax-h3-max",
      name: "MiniMax H3 Max",
      tier: 1,
      category: "generation",
      tool: "generate_video",
      credit_cost: 40,
    },
    {
      id: "happy-horse-video-edit",
      name: "Happy Horse Video Edit",
      tier: 1,
      category: "video_edit",
      tool: "edit_video",
      credit_cost: 420,
    },
    {
      id: "kling-o3-video-ref-edit",
      name: "Kling O3 Video Edit",
      tier: 1,
      category: "video_edit",
      tool: "edit_video",
      credit_cost: 85,
    },
    {
      id: "grok-imagine-video-edit",
      name: "Grok Video Edit",
      tier: 1,
      category: "video_edit",
      tool: "edit_video",
      credit_cost: 56,
    },
    {
      id: "topaz-upscale-video",
      name: "Topaz Video Upscale",
      tier: null,
      category: "upscale",
      tool: "upscale_video",
    },
  ],
};

describe("models table", () => {
  it("lists recommended video models first, in recommended order, within each category", () => {
    const { headers, rows, hasTiers } = modelTable("video", video);
    expect(hasTiers).toBe(true);
    expect(headers).toEqual(["id", "name", "tier", "category", "tool", "cost"]);
    expect(rows.map((row) => row[0])).toEqual([
      "gemini-omni-1.1-flash",
      "seedance-2.5",
      "seedance-2",
      "kling-3.0",
      "kling-o3",
      "minimax-h3-max",
      // Tier 2 after, still in catalog order.
      "google-veo3",
      "google-veo3.1",
      "sora-2",
      // Categories keep their catalog grouping.
      "grok-imagine-video-edit",
      "happy-horse-video-edit",
      "kling-o3-video-ref-edit",
      "topaz-upscale-video",
    ]);
  });

  it("shows each model's tier, blank where the catalog has none", () => {
    const { rows } = modelTable("video", video);
    const tierOf = (id: string) => rows.find((row) => row[0] === id)?.[2];
    expect(tierOf("seedance-2.5")).toBe("1");
    expect(tierOf("google-veo3.1")).toBe("2");
    expect(tierOf("topaz-upscale-video")).toBe("");
    expect(rows.find((row) => row[0] === "google-veo3.1")).toEqual([
      "google-veo3.1",
      "Veo 3.1",
      "2",
      "generation",
      "generate_video",
      "60",
    ]);
  });

  it("orders image models by the flat recommended list", () => {
    const image = {
      recommended: [
        "nano-banana-2",
        "nano-banana-pro",
        "nano-banana-2-lite",
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst",
      ],
      models: [
        { id: "flux-2-pro", name: "FLUX 2 Pro", tier: 2, credit_cost: 6 },
        { id: "gpt-image-2", name: "GPT-Image-2", tier: 2, credit_cost: 28 },
        {
          id: "gpt-image-2.5-flare",
          name: "GPT Image 2.5 Flare",
          tier: 1,
          credit_cost: 20,
        },
        {
          id: "nano-banana-pro",
          name: "Nano Banana Pro",
          tier: 1,
          credit_cost: 14,
        },
        { id: "nano-banana-2", name: "Nano Banana 2", tier: 1, credit_cost: 7 },
      ],
    };
    const { headers, rows } = modelTable("image", image);
    expect(headers).toEqual(["id", "name", "tier", "cost"]);
    expect(rows).toEqual([
      ["nano-banana-2", "Nano Banana 2", "1", "7"],
      ["nano-banana-pro", "Nano Banana Pro", "1", "14"],
      ["gpt-image-2.5-flare", "GPT Image 2.5 Flare", "1", "20"],
      ["flux-2-pro", "FLUX 2 Pro", "2", "6"],
      ["gpt-image-2", "GPT-Image-2", "2", "28"],
    ]);
  });

  it("leaves untiered sections exactly as before", () => {
    const voices = {
      voices: [
        { voice_id: "b", name: "Beta" },
        { voice_id: "a", name: "Alpha" },
      ],
    };
    const { headers, rows, hasTiers } = modelTable("voices", voices);
    expect(hasTiers).toBe(false);
    expect(headers).toEqual(["id", "name", "cost"]);
    expect(rows).toEqual([
      ["b", "Beta", ""],
      ["a", "Alpha", ""],
    ]);
  });
});
