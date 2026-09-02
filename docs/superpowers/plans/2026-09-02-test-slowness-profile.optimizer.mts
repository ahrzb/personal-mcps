// Experiment config (never committed): repo config + dependency pre-bundling for the
// `worker` project, restricted to DIRECT deps (pnpm strict layout) with node:/cloudflare:
// externalised, to measure whether the 1,678 per-file module round-trips can be collapsed.
import base from "C:/Users/AmirHossein/repos/github.com/ahrzb/personal-mcps/vitest.config.mts";
const cfg = base as any;
cfg.root = "C:/Users/AmirHossein/repos/github.com/ahrzb/personal-mcps";
cfg.cacheDir = "C:/Users/AMIRHO~1/AppData/Local/Temp/claude/C--Users-AmirHossein-repos-github-com-ahrzb-personal-mcps/a7afa262-2659-4a56-a971-21da6b70ee17/scratchpad/profile/.vite-optimizer";
const worker = cfg.test.projects.find((p: any) => p.test?.name === "worker");
worker.test.deps = {
  optimizer: {
    ssr: {
      enabled: true,
      include: ["better-auth", "@better-auth/oauth-provider", "@better-auth/passkey", "@better-auth/infra", "@sentry/cloudflare", "hono", "webpush-webcrypto"],
      rolldownOptions: { external: [/^node:/, /^cloudflare:/] },
      esbuildOptions: { external: ["node:*", "cloudflare:*"] },
    },
  },
};
export default cfg;
