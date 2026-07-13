import { describe, expect, it } from "vitest";
import { bundledSkillFiles } from "../src/commands/skills.js";

// Under vitest the tsup `define` never runs, so __SKILL_ASSETS__ is undefined and
// bundledSkillFiles() exercises the on-disk fallback (reading skills/videodraft/).
// The baked-blob path is covered by the compiled-binary smoke in CI.
describe("bundledSkillFiles", () => {
  it("returns SKILL.md and the three references, each non-empty", () => {
    const files = bundledSkillFiles();
    expect(Object.keys(files).sort()).toEqual([
      "SKILL.md",
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

  it("keeps asset/project scope and avatar pricing unambiguous", () => {
    const files = bundledSkillFiles();
    const skill = files["SKILL.md"];
    const models = files["references/models.md"];
    const pipeline = files["references/pipeline.md"];

    expect(skill).toContain(
      "Use it for a multi-scene video, story, ad, explainer, storyboard, editable timeline, or final export",
    );
    expect(skill).toContain(
      "A script-only request also creates a script-stage project but stops at the script.",
    );
    expect(skill).toContain("Managed script/creation is bundled/free");
    expect(models).toContain(
      "A video plus any image/audio references that must all be preserved: use Seedance 2.0.",
    );
    expect(models).not.toContain("speech may add separate costs");
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
