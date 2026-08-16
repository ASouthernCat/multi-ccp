import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let css = "";
let app = "";

beforeAll(async () => {
  [css, app] = await Promise.all([
    readFile(path.resolve("src/web/assets/collab.css"), "utf8"),
    readFile(path.resolve("src/web/assets/app.js"), "utf8"),
  ]);
  css = css.replace(/\r\n/g, "\n");
  app = app.replace(/\r\n/g, "\n");
});

describe("Collab Mesh responsive CSS", () => {
  it("keeps the mobile dialog and header controls within the viewport", () => {
    expect(css).toContain("max-width: calc(100vw - 12px);");
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain("flex-direction: column;\n    align-items: stretch;");
    expect(css).toContain(".collab-header-right::-webkit-scrollbar");
    expect(css).toContain(".collab-header-right .collab-tool-btn:has(svg:only-child)");
    expect(css).not.toContain(".collab-project-scope");
    expect(css).toContain("overflow-x: auto;\n    overflow-y: hidden;");
  });

  it("keeps task template labels on one horizontally scrollable line", () => {
    expect(css).toContain("flex: 0 0 auto;\n    padding: 5px 9px;");
    expect(css).toContain("font-size: 11px;\n    white-space: nowrap;");
    expect(css).toContain("overflow-x: auto;\n    overflow-y: hidden;");
  });

  it("leaves enough room for all supervisor tabs on small screens", () => {
    expect(css).toContain("margin: 8px 8px 0;");
    expect(css).toContain("min-width: 0;\n    min-height: 40px;");
    expect(css).toContain(".supervisor-panel-body {\n    overflow-x: hidden;");
  });

  it("uses a readable compact topology instead of shrinking the desktop grid", () => {
    expect(app).toContain("const layoutMode = viewportWidth <= 600 ? 'compact' : 'wide';");
    expect(app).toContain("collabMeshState.nodePositions[peerKey] = { x: 111, y: 324 + index * 196 };");
    expect(app).toContain("const minimumZoom = compactLayout ? 0.62 : 0.38;");
    expect(css).toContain(".collab-mesh-card .dialog-toast-region .toast");
  });
});
