import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { AppEnvProvider } from "./lib/api-context";
import { readBootstrap } from "./lib/bootstrap";
import { apiClient } from "./lib/http";
import { buildRouter } from "./router";

/**
 * The client's entry: read the shell's bootstrap block, build the query client and the
 * router, mount, and register the service worker.
 *
 * The service-worker registration is HERE because the shell document no longer carries it.
 * `pages/layout.tsx` ran it as the last thing in every page body, and deleting that layout
 * would have silently dropped installability and push on exactly the routes an owner spends
 * their time on. The worker itself is unchanged and still has no fetch handler: it pushes
 * and it opens notifications, and it does not intercept navigation.
 */
const bootstrap = readBootstrap();
const api = apiClient(bootstrap);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A pane's data is worth re-reading when the tab comes back: the owner may have just
      // approved something on a phone, or a bot may have reconnected. The per-resource
      // `staleTime`s in lib/queries decide what "worth" means for each one.
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const router = buildRouter();

const root = document.getElementById("root");
if (root === null) throw new Error("pmcp: the shell document carries no #root");

// The state gallery, and only in preview mode. Vite replaces `import.meta.env.MODE` with a
// literal at build time, so in a production build this condition is `"production" ===
// "preview"` and Rollup drops the branch — the gallery, the fixtures and the frozen clock
// with it. A dynamic import rather than a static one for exactly that reason: a static one
// would be in the graph whether the branch survived or not.
if (import.meta.env.MODE === "preview") {
  await import("./preview/mount");
} else {
  createRoot(root).render(
    <StrictMode>
      <AppEnvProvider value={{ api, bootstrap }}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AppEnvProvider>
    </StrictMode>,
  );

  void navigator.serviceWorker?.register("/sw.js");
}
