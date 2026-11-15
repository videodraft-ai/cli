import { describe, expect, it } from "vitest";
import {
  folderPrefix,
  machineText,
  pulledPath,
  retrying,
  withoutHome,
} from "../src/commands/session.js";

describe("render session pull", () => {
  it("names a folder the way the session does", () => {
    expect(folderPrefix("project/stills/")).toBe("project/stills");
    expect(folderPrefix("./project/stills//")).toBe("project/stills");
    expect(folderPrefix("project\\stills")).toBe("project/stills");
    // Spaces belong to the name: " renders" and "renders" are different folders.
    expect(folderPrefix(" renders/")).toBe(" renders");
    expect(folderPrefix(undefined)).toBe("");
    expect(folderPrefix("./")).toBe("");
  });

  it("puts a folder's files straight into --out", () => {
    expect(pulledPath("project/stills", "project/stills/r1/f0001.png")).toBe(
      "r1/f0001.png",
    );
    expect(pulledPath("./project/stills/", "project/stills/a.png")).toBe(
      "a.png",
    );
    expect(pulledPath("project\\stills", "project/stills/a.png")).toBe("a.png");
  });

  it("keeps one named file's name, and full paths without a folder", () => {
    expect(pulledPath("out/scene.blend", "out/scene.blend")).toBe(
      "scene.blend",
    );
    expect(pulledPath(undefined, "out/scene.blend")).toBe("out/scene.blend");
    expect(pulledPath("", "a/b.txt")).toBe("a/b.txt");
  });

  it("never cuts a sibling folder that only shares the name's start", () => {
    expect(pulledPath("project/stills", "project/stills_old/a.png")).toBe(
      "project/stills_old/a.png",
    );
  });
});

describe("render session machine text", () => {
  it("names the zone once", () => {
    const waiting = {
      phase: "waiting for a free GPU in us-east5-a (not billed)",
      zone: "us-east5-a",
    };
    expect(machineText(waiting, " in ")).toBe(
      "waiting for a free GPU in us-east5-a (not billed)",
    );
    expect(
      machineText(
        { phase: "ready (billed while on)", zone: "us-east5-a" },
        " in ",
      ),
    ).toBe("ready (billed while on) in us-east5-a");
  });
});

describe("render session retries", () => {
  const noWait = async () => undefined;

  it("rides out a dropped connection", async () => {
    let calls = 0;
    const r = await retrying(
      async () => {
        calls++;
        if (calls < 3) throw new TypeError("fetch failed");
        return "ok";
      },
      4,
      noWait,
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("stops after its tries, and never repeats other errors", async () => {
    let calls = 0;
    await expect(
      retrying(
        async () => {
          calls++;
          throw new TypeError("fetch failed");
        },
        3,
        noWait,
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      retrying(
        async () => {
          calls++;
          throw new Error("The session was released.");
        },
        4,
        noWait,
      ),
    ).rejects.toThrow("released");
    expect(calls).toBe(1);
  });
});

describe("render session pull and the home folder", () => {
  const files = [
    { path: "out/a.png" },
    { path: ".home/.local/bin/tool" },
    { path: ".homework/notes.txt" },
  ];
  it("leaves the session's home folder out unless the pull names it", () => {
    expect(withoutHome(undefined, files).map((f) => f.path)).toEqual([
      "out/a.png",
      ".homework/notes.txt",
    ]);
    expect(withoutHome("out", files)).toHaveLength(3);
    expect(withoutHome(".home", files)).toHaveLength(3);
    expect(withoutHome("./.home/.local/", files)).toHaveLength(3);
  });
});
