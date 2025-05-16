import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import getPort from "get-port";

import {
  type TemplateName,
  createDev,
  createProject,
} from "../helpers/vite.js";

const js = String.raw;

type Implementation = {
  name: string;
  template: TemplateName;
  /** Build a production app */
  build: ({ cwd }: { cwd: string }) => ReturnType<typeof spawnSync>;
  /** Run a production app */
  run: ({ cwd, port }: { cwd: string; port: number }) => Promise<() => void>;
  /** Run the dev server */
  dev: ({ cwd, port }: { cwd: string; port: number }) => Promise<() => void>;
};

// Run tests against vite and parcel to ensure our code is bundler agnostic
const implementations: Implementation[] = [
  {
    name: "vite",
    template: "rsc-vite",
    build: ({ cwd }: { cwd: string }) =>
      spawnSync("node_modules/.bin/vite", ["build"], { cwd }),
    run: ({ cwd, port }) =>
      createDev(["server.js", "-p", String(port)])({
        cwd,
        port,
      }),
    dev: ({ cwd, port }) =>
      createDev(["node_modules/vite/bin/vite.js", "--port", String(port)])({
        cwd,
        port,
      }),
  },
  {
    name: "parcel",
    template: "rsc-parcel",
    build: ({ cwd }: { cwd: string }) =>
      spawnSync("node_modules/.bin/parcel", ["build"], { cwd }),
    run: ({ cwd, port }) =>
      // FIXME: Parcel prod builds seems to have dup copies of react in them :/
      // Not reproducible in the playground though - only in integration/helpers...
      implementations.find((i) => i.name === "parcel")!.dev({ cwd, port }),
    dev: ({ cwd, port }) =>
      createDev(["node_modules/parcel/lib/bin.js"])({
        // Since we run through parcels dev server we can't use `-p` because that
        // only changes the dev server and doesn't pass through to the internal
        // server.  So we setup the internal server to choose from `RR_PORT`
        env: { RR_PORT: String(port) },
        cwd,
        port,
      }),
  },
];

async function setupRscTest({
  implementation,
  port,
  dev,
  files,
}: {
  implementation: Implementation;
  port: number;
  dev?: boolean;
  files: Record<string, string>;
}) {
  let cwd = await createProject(files, implementation.template);

  let { status, stderr, stdout } = implementation.build({ cwd });
  if (status !== 0) {
    console.error("Error building project", {
      status,
      stdout: stdout.toString(),
      stderr: stderr.toString,
    });
    throw new Error("Error building project");
  }
  return dev
    ? implementation.dev({ cwd, port })
    : implementation.run({ cwd, port });
}

const validateRSCHtml = (html: string) =>
  expect(html).toMatch(/\(self\.__FLIGHT_DATA\|\|=\[\]\)\.push\(/);

test.describe("RSC", () => {
  implementations.forEach((implementation) => {
    let stop: () => void;

    test.afterEach(() => {
      stop?.();
    });

    test.describe(implementation.name, () => {
      test("Renders a page using server components", async ({ page }) => {
        let port = await getPort();
        stop = await setupRscTest({
          implementation,
          port,
          files: {
            "src/routes/home.tsx": js`
              export function loader() {
                return { message: "Loader Data" };
              }
              export default function ServerComponent({ loaderData }) {
                return <h2 data-home>Home: {loaderData.message}</h2>;
              }
            `,
          },
        });

        await page.goto(`http://localhost:${port}/`);
        await page.waitForSelector("[data-home]");
        expect(await page.locator("[data-home]").textContent()).toBe(
          "Home: Loader Data"
        );

        // Ensure this is actually using RSC lol
        validateRSCHtml(await page.content());
      });

      test("Works with client components using 'use client'", async ({
        page,
      }) => {
        let port = await getPort();
        stop = await setupRscTest({
          implementation,
          port,
          files: {
            "src/routes/home.tsx": js`
              import { ClientCounter } from "./home.client";

              export function loader() {
                return { message: "Loader Data" };
              }

              export default function ServerComponent({ loaderData }) {
                return (
                  <div>
                    <h2 data-home>Home: {loaderData.message}</h2>
                    <ClientCounter />
                  </div>
                );
              }
            `,
            "src/routes/home.client.tsx": js`
              "use client";

              import { useState } from "react";

              export function ClientCounter() {
                const [count, setCount] = useState(0);

                return (
                  <div data-testid="client-component">
                    <p data-count>{count}</p>
                    <button
                      data-increment
                      onClick={() => setCount(c => c + 1)}
                    >
                      Increment
                    </button>
                  </div>
                );
              }
            `,
          },
        });

        await page.goto(`http://localhost:${port}/`);

        // Verify server component rendered
        await page.waitForSelector("[data-home]");
        expect(await page.locator("[data-home]").textContent()).toBe(
          "Home: Loader Data"
        );

        // Verify client component rendered
        await page.waitForSelector("[data-testid=client-component]");
        expect(await page.locator("[data-count]").textContent()).toBe("0");

        // Test interactivity of client component
        await page.click("[data-increment]");
        expect(await page.locator("[data-count]").textContent()).toBe("1");

        // Click again to ensure it's truly interactive
        await page.click("[data-increment]");
        expect(await page.locator("[data-count]").textContent()).toBe("2");

        // Ensure this is using RSC
        validateRSCHtml(await page.content());
      });

      test("Supports React Server Functions", async ({ page }) => {
        let port = await getPort();
        stop = await setupRscTest({
          implementation,
          port,
          files: {
            "src/routes/home.tsx": js`
              let count = 0;
              let name = "Default";

              export function loader() {
                return { name, count };
              }

              export default function ServerComponent({ loaderData }) {
                const updateCounter = async (formData: FormData) => {
                  "use server";
                  name = formData.get("name");
                  ++count
                  return { name, count };
                }

                return (
                  <div>
                    <h2 data-home>Home: {loaderData.name} ({loaderData.count})</h2>
                    <form action={updateCounter}>
                      <input type="hidden" name="name" value="Updated" />
                      <button type="submit" data-submit>Update via Server Function</button>
                    </form>
                  </div>
                );
              }
            `,
          },
        });

        await page.goto(`http://localhost:${port}/`);

        // Verify initial server render
        await page.waitForSelector("[data-home]");
        expect(await page.locator("[data-home]").textContent()).toBe(
          "Home: Default (0)"
        );

        // Submit the form to trigger server function
        await page.click("[data-submit]");

        // Verify server function updated the UI
        await expect(page.locator("[data-home]")).toHaveText(
          "Home: Updated (1)"
        );

        // Submit again to ensure server functions work repeatedly
        await page.click("[data-submit]");
        await expect(page.locator("[data-home]")).toHaveText(
          "Home: Updated (2)"
        );

        // Ensure this is using RSC
        validateRSCHtml(await page.content());
      });

      test("Supports both server-first and client-first routes", async ({
        page,
      }) => {
        let port = await getPort();
        stop = await setupRscTest({
          implementation,
          port,
          files: {
            "src/routes.ts": js`
              import type { ServerRouteObject } from "react-router/rsc";

              export const routes = [
                {
                  id: "root",
                  path: "",
                  lazy: () => import("./routes/root"),
                  children: [
                    {
                      id: "home",
                      index: true,
                      lazy: () => import("./routes/home"),
                    },
                    {
                      id: "dashboard",
                      path: "dashboard",
                      lazy: () => import("./routes/dashboard"),
                    },
                  ],
                },
              ] satisfies ServerRouteObject[];
            `,
            "src/routes/home.tsx": js`
              import { Link } from "react-router";

              export function loader() {
                return { message: "Home Page Data" };
              }

              export default function Home({ loaderData }) {
                return (
                  <div>
                    <h1 data-page="home">Home Page</h1>
                    <p data-content>{loaderData.message}</p>
                    <Link to="/dashboard">Dashboard</Link>
                  </div>
                );
              }
            `,
            "src/routes/dashboard.tsx": js`
              export function loader() {
                return { stats: [10, 20, 30, 40] };
              }

              export { Dashboard as default } from "./dashboard.client";
            `,
            "src/routes/dashboard.client.tsx": js`
              "use client";

              import { useState } from "react";

              // Export the entire route as a client component
              export function Dashboard({ loaderData }) {
                const [clientStats, setClientStats] = useState(loaderData.stats);

                const addStat = () => {
                  setClientStats([...clientStats, clientStats.reduce((a, b) => a + b, 0) / clientStats.length]);
                };

                return (
                  <div>
                    <h1 data-page="dashboard">Dashboard</h1>

                    {/* Server data rendered in client component */}
                    <div data-server-stats>
                      <h2>Server Stats (from loader)</h2>
                      <ul>
                        {loaderData.stats.map((stat, i) => (
                          <li key={i}>{stat}</li>
                        ))}
                      </ul>
                    </div>

                    {/* Client interactive elements */}
                    <div data-testid="client-dashboard">
                      <h2>Client Stats (interactive)</h2>
                      <ul data-client-stats>
                        {clientStats.map((stat, i) => (
                          <li key={i}>{stat}</li>
                        ))}
                      </ul>
                      <button data-add-stat onClick={addStat}>Add Average Stat</button>
                    </div>
                  </div>
                );
              }
            `,
          },
        });

        await page.goto(`http://localhost:${port}/`);

        await page.waitForSelector("[data-page=home]");
        expect(await page.locator("[data-content]").textContent()).toBe(
          "Home Page Data"
        );

        await page.click("a[href='/dashboard']");
        await page.waitForSelector("[data-page=dashboard]");

        // Verify server component
        const initialClientStats = await page
          .locator("[data-client-stats] li")
          .count();
        expect(initialClientStats).toBe(4);

        // Add a stat using client component
        await page.click("[data-add-stat]");

        // Verify client component was updated
        const updatedClientStats = await page
          .locator("[data-client-stats] li")
          .count();
        expect(updatedClientStats).toBe(5);

        // Ensure this is using RSC
        validateRSCHtml(await page.content());
      });

      test.skip("Handles errors in server components correctly", async ({
        page,
      }) => {
        let port = await getPort();
        stop = await setupRscTest({
          implementation,
          port,
          files: {
            "src/routes/home.tsx": js`
              export function loader() {
                throw new Error("Intentional error from loader");
              }

              export default function Home() {
                return <h2>This shouldn't render</h2>;
              }

              export function ErrorBoundary({ error }) {
                return (
                  <>
                    <h2 data-error-title>Error Caught!</h2>
                    <p data-error-message>{error.message}</p>
                  </>
                );
              }
            `,
          },
        });

        await page.goto(`http://localhost:${port}/`);

        console.log(await page.innerHTML("body"));
        // Verify error boundary is shown
        await page.waitForSelector("[data-error-message]");
        expect(await page.locator("[data-error-title]").textContent()).toBe(
          "Error Caught!"
        );
        expect(await page.locator("[data-error-message]").textContent()).toBe(
          "Intentional error from loader"
        );

        // Ensure this is using RSC
        validateRSCHtml(await page.content());
      });
    });
  });
});
