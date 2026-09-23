import { appNewSeeds, appsSeeds } from "./fixtures/apps";
import { appDetailSeeds } from "./fixtures/app-detail";
import { agentDetailSeeds, agentNewSeeds, agentsSeeds } from "./fixtures/agents";
import { auditSeeds } from "./fixtures/audit";
import { approvalDetailSeeds, approvalsSeeds } from "./fixtures/approvals";
import { settingsSeeds } from "./fixtures/settings";
import { deviceSeeds } from "./fixtures/device";
import { consentSeeds } from "./fixtures/consent";
import { loginSeeds } from "./fixtures/login";
import type { PreviewSeeds } from "./seed";

/**
 * Every state of every page, assembled.
 *
 * `PreviewSeeds` is `Record<PreviewName, …>`, so a page added without seeds is a TYPE ERROR
 * — the reason the index can never silently lag the pages.
 *
 * Split by page group across `./fixtures/` because the seeds are bulk: `app-detail` alone
 * has 47 states. The keys are the server fixtures' names one for one (`seed.ts`), which is what lets
 * `scripts/visual-compare.mts` pair each screenshot with its baseline by filename.
 */
export const seeds: PreviewSeeds = {
  apps: appsSeeds,
  "app-detail": appDetailSeeds,
  "app-new": appNewSeeds,
  agents: agentsSeeds,
  "agent-detail": agentDetailSeeds,
  "agent-new": agentNewSeeds,
  audit: auditSeeds,
  approvals: approvalsSeeds,
  "approval-detail": approvalDetailSeeds,
  settings: settingsSeeds,
  device: deviceSeeds,
  "oauth-consent": consentSeeds,
  login: loginSeeds,
};
