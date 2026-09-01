// env.d.ts — the root tsconfig's view of the `cloudflare:test` module, runner stage.
//
// Deliberately a minimal hand-rolled shadow, NOT the plugin's own `./types` export:
// that file types `env` as wrangler-generated `Cloudflare.Env`, which this repo does
// not generate yet — the skeletons type every binding `unknown` on purpose, and
// adopting `wrangler types` output (plus its DOM-lib collisions) is a decision for
// the migrations phase (D3), where this file is replaced by the real thing. Until
// then: exactly the names the test tree imports today, nothing more.
declare module "cloudflare:test" {
  /** Mirrors the plugin's shape: one migration file's name and its statements. */
  export interface D1Migration {
    name: string;
    queries: string[];
  }
  /** Bindings from wrangler.jsonc plus vitest.config.mts's `miniflare.bindings`. */
  export const env: {
    DB: unknown;
    APP_CONNECTION: unknown;
    TEST_MIGRATIONS: D1Migration[];
  };
  export function applyD1Migrations(db: unknown, migrations: D1Migration[]): Promise<void>;
  /** The trigger `scheduled()` takes as its 1st argument — the platform's, minted by the
   *  plugin so the cron suite drives `exports.default.scheduled` the way workerd would. */
  export interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
  }
  export function createScheduledController(options?: {
    scheduledTime?: number | Date;
    cron?: string;
  }): ScheduledController;
}
