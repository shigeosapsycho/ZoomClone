import { test as base } from "@playwright/test";
import { createApi, type Api } from "./api";
import { ServiceManager, assertPortsFree, API_URL, SIGNALING_URL } from "./services";

export type Services = {
  restartSignaling: () => Promise<void>;
  urls: { api: string; signaling: string };
};

export const test = base.extend<Record<never, never>, { services: Services; api: Api }>({
  services: [
    async ({}, use) => {
      await assertPortsFree();
      const manager = new ServiceManager();
      // A start that fails must not leave the services that did come up on the real ports.
      try {
        await manager.startAll();
        await use({
          restartSignaling: () => manager.restartSignaling(),
          urls: { api: API_URL, signaling: SIGNALING_URL },
        });
      } finally {
        await manager.stopAll();
      }
    },
    // Its own budget: a slow machine's three starts are not charged to the first test.
    { scope: "worker", timeout: 90_000 },
  ],
  api: [
    async ({ services }, use) => {
      void services;
      const api = createApi();
      await use(api);
      await api.close();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
