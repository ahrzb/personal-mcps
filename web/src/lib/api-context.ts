import { createContext, useContext } from "react";
import type { ApiClient } from "./http";
import type { Bootstrap } from "./bootstrap";

/**
 * The API client and the bootstrap, reached by every feature without being threaded through
 * the router's props. Context rather than a module singleton for one concrete reason: the
 * preview gallery mounts the same components against a stubbed client and a frozen
 * bootstrap, and a singleton would make that impossible without patching a module.
 */
export type AppEnv = { api: ApiClient; bootstrap: Bootstrap };

const AppEnvContext = createContext<AppEnv | null>(null);

export const AppEnvProvider = AppEnvContext.Provider;

/** The app's environment, or a throw. Absent means a component was mounted outside the
 *  provider, which is a wiring mistake and not a state to render. */
export function useAppEnv(): AppEnv {
  const value = useContext(AppEnvContext);
  if (value === null) throw new Error("pmcp: useAppEnv outside AppEnvProvider");
  return value;
}

export function useApi(): ApiClient {
  return useAppEnv().api;
}
