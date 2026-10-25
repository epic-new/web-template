import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let a second (verify) dev server use its own build dir so two `next dev`
  // instances in the same project don't collide on `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  devIndicators: false,
  // A wildcard label matches ONE label, so "*.epic.new" does not cover
  // "8080-<sandbox>.proxy.epic.new" — the preview host is a level deeper.
  // Without the deeper pattern Next blocks its own dev resources as
  // cross-origin, React never hydrates, and the page renders perfectly while
  // every form on it is inert: a click submits nothing, and the verify agent
  // reports it as failing scenarios rather than as a broken environment.
  allowedDevOrigins: [
    "*.proxy.epic.new",
    "*.http.cloud.morph.so",
    "*.epic.new",
    "*.lvh.me",
    "*.daytonaproxy01.net",
  ],
  experimental: {
    serverActions: {
      // epic-proxy hands a Server Action to a Daytona preview with the Origin
      // rewritten to Daytona's host while X-Forwarded-Host keeps the preview
      // host, so Next refused every action — sign-in and sign-up included.
      // The proxy rewrites only requests carrying the `next-action` header,
      // which a cross-site page cannot send without passing CORS, so this
      // origin only ever arrives for a same-origin call.
      allowedOrigins: ["*.daytonaproxy01.net"],
    },
  },
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
