import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let css = "";

beforeAll(async () => {
  css = await readFile(path.resolve("src/web/assets/collab.css"), "utf8");
  css = css.replace(/\r\n/g, "\n");
});

describe("Collab Mesh flow-state visuals", () => {
  it("defines restrained node states for the full collaboration lifecycle", () => {
    expect(css).toContain('[data-collab-state="sending"]');
    expect(css).toContain('[data-collab-state="transmitting"]');
    expect(css).toContain('[data-collab-state="waiting-reply"]');
    expect(css).toContain('[data-collab-state="processing"]');
    expect(css).toContain('[data-collab-state="stalled"]');
    expect(css).toContain('[data-collab-state="pending"]');
    expect(css).toContain('[data-collab-state="completed"]');
    expect(css).toContain('[data-collab-state="timeout"]');
    expect(css).toContain('[data-collab-state="disconnected"]');
    expect(css).toContain("@keyframes collab-complete-settle");
  });

  it("maps wire and activity trajectories to the same lifecycle semantics", () => {
    expect(css).toContain(".status-sending, .status-dispatching");
    expect(css).toContain(".status-transmitting, .status-processing");
    expect(css).toContain(".status-waiting-reply, .status-waiting");
    expect(css).toContain(".status-stalled");
    expect(css).toContain(".status-pending");
    expect(css).toContain(".status-complete, .status-completed");
    expect(css).toContain(".status-timeout, .status-timed-out");
    expect(css).toContain(".status-disconnected, .status-offline");
    expect(css).toContain("@keyframes collab-transmission-stall");
    expect(css).toContain(".collab-act-item:is(");
  });

  it("preserves static state meaning when reduced motion is requested", () => {
    const reducedMotion = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".status-dot-indicator");
    expect(reducedMotion).toContain(".collab-node .port-handle");
    expect(reducedMotion).toContain("animation: none !important;");
    expect(reducedMotion).toContain(".collab-node.is-receiving");
    expect(reducedMotion).toContain("stroke-dashoffset: 0;");
  });
});
