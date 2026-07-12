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
});
