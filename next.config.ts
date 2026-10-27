import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";
import { envList } from "./lib/env-list";

const nextConfig: NextConfig = {
  // Let a second (verify) dev server use its own build dir so two `next dev`
  // instances in the same project don't collide on `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  devIndicators: false,
  // The hosts a preview of this app is served from are the environment's to
  // name, not this file's: Epic sets EPIC_DEV_ORIGINS on the machines it runs,
  // so a new preview domain never needs a change here. Its proxy already
  // admits the preview's own requests for dev resources, so the list is only
  // for hosts that reach `next dev` directly.
  allowedDevOrigins: envList("EPIC_DEV_ORIGINS"),
  // Pin the Turbopack root to this checkout. Git worktrees live inside the
  // repo (.worktrees/*), so lockfile inference would otherwise resolve the
  // workspace root to the parent checkout and share its .next/dev/lock,
  // making concurrent per-worktree dev servers fail.
  turbopack: {
    root: import.meta.dirname,
  },
};

// The verify server serves the app to a browser for scenario checks and never
// runs workflows. `withWorkflow` bundles workflow directives with esbuild, and
// a second `next dev` running that bundler concurrently with the port-8080 dev
// server panics esbuild (bundler conflict). Skip it for the verify server via
// DISABLE_WORKFLOW_BUILD so two dev servers can coexist. The main app keeps the
// full workflow build.
export default process.env.DISABLE_WORKFLOW_BUILD
  ? nextConfig
  : withWorkflow(nextConfig);
