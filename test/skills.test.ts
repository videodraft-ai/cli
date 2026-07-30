import { describe, expect, it } from "vitest";
import { bundledSkillFiles } from "../src/commands/skills.js";

// Under vitest the tsup `define` never runs, so __SKILL_ASSETS__ is undefined and
// bundledSkillFiles() exercises the on-disk fallback (reading skills/videodraft/).
// The baked-blob path is covered by the compiled-binary smoke in CI.
describe("bundledSkillFiles", () => {
  it("returns SKILL.md and the four references, each non-empty", () => {
    const files = bundledSkillFiles();
    expect(Object.keys(files).sort()).toEqual([
      "SKILL.md",
      "references/editor.md",
      "references/examples.md",
      "references/models.md",
      "references/pipeline.md",
    ]);
    for (const content of Object.values(files)) {
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("carries the canonical SKILL.md (frontmatter + the media-embedding section)", () => {
    const files = bundledSkillFiles();
    expect(files["SKILL.md"]).toContain("name: videodraft");
    expect(files["SKILL.md"]).toContain("Showing media to the user");
  });

  it("uses VideoDraft ADE consistently for the desktop app", () => {
    const content = Object.values(bundledSkillFiles()).join("\n");

    expect(content).not.toMatch(/(?<!VideoDraft )\bADE\b/u);
    expect(content).not.toContain("VideoDraft desktop app");
    expect(content).toContain("VideoDraft ADE");
    expect(content).toContain("VideoDraft mode");
    expect(content).toContain("VideoDraft Editor");
    expect(content).toContain("videodraft_editor");
  });

  it("keeps asset, hosted project, native editor, and avatar scope unambiguous", () => {
    const files = bundledSkillFiles();
    const skill = files["SKILL.md"];
    const editor = files["references/editor.md"];
    const models = files["references/models.md"];
    const pipeline = files["references/pipeline.md"];

    expect(skill).toContain(
      "First decision: asset, hosted project, or native edit?",
    );
    expect(skill).toContain(
      "A script-only request creates a script-stage project but stops at the script.",
    );
    expect(skill).toContain("The editor can work without showing its UI.");
    expect(skill).toContain("run `videodraft skills show editor` before native editor work");
    expect(skill).toContain(
      "Do not call hosted `produce_project` / `videodraft produce` or `export_video` / `videodraft export` by default.",
    );
    expect(skill).toContain("Hosted fallback pipeline");
    expect(editor).toContain("both Code and VideoDraft modes");
    expect(editor).toContain("make it the default surface for production, timeline assembly, and final export");
    expect(editor).toContain("rather than silently switching surfaces");
    expect(editor).toContain("expectedRevision");
    expect(editor).toContain("videodraft-editor tool manage_project");
    expect(skill).toContain("Managed script/creation is bundled/free");
    expect(models).toContain(
      "A video plus any image/audio references that must all be preserved: use Seedance 2.0.",
    );
    expect(models).not.toContain("speech may add separate costs");
    expect(models).toContain(
      "do not choose this path while `videodraft_editor` is available",
    );
    expect(skill).toContain("videodraft avatar fabric");
    expect(skill).toContain("videodraft avatar lipsync");
    expect(pipeline).toContain("generate_veed_fabric_video");
    expect(pipeline).toContain("generate_sync_lipsync_video");
    expect(skill).toContain("videodraft edit video");
    expect(skill).toContain("videodraft edit motion");
    expect(pipeline).toContain("edit_video");
    expect(pipeline).toContain("generate_motion_control_video");
  });
});
