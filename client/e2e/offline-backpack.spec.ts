import { writeFile } from 'node:fs/promises';
import { expect, test as base } from '@playwright/test';

// The loopback development fixture already exposes the live game for render diagnostics.
type FixtureWindow = typeof window & {
  game: {
    sceneRenderer: {
      renderer: {
        info: { render: { calls: number; triangles: number } };
        backend: { device: GPUDevice };
      };
    };
  };
};

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({ page }, use, testInfo) => {
    const logs: string[] = [];
    const errors: string[] = [];
    page.on('console', message => logs.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', error => {
      const message = error.stack ?? error.message;
      errors.push(message);
      logs.push(`[pageerror] ${message}`);
    });

    await use(errors);

    if (testInfo.status !== testInfo.expectedStatus) {
      const path = testInfo.outputPath('browser.log');
      await writeFile(path, logs.join('\n') || 'No browser messages captured.', 'utf8');
      await testInfo.attach('browser.log', { path, contentType: 'text/plain' });
    }
  },
});

test('enters the offline Copper world and opens the backpack', async ({ page, pageErrors }) => {
  await test.step('Load Space with WebGPU', async () => {
    const response = await page.goto('?dev_offline=1&world=copper-metropolis');
    expect(response?.ok()).toBe(true);
    const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    expect(hasAdapter, 'Chromium must provide a WebGPU adapter to run Space').toBe(true);
    await expect(page.locator('#space-entry-gate')).toBeHidden({ timeout: 60_000 });
  });

  await test.step('Enter the world and wait for a rendered gameplay frame', async () => {
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#canvas-container > canvas')).toBeVisible();
    const previousCalls = await page.evaluate(() => (window as FixtureWindow).game.sceneRenderer.renderer.info.render.calls);
    await page.waitForFunction(calls => {
      const { render } = (window as FixtureWindow).game.sceneRenderer.renderer.info;
      return render.calls > calls && render.triangles > 0;
    }, previousCalls, { timeout: 10_000 });
    await page.evaluate(() => (window as FixtureWindow).game.sceneRenderer.renderer.backend.device.queue.onSubmittedWorkDone());
  });

  await test.step('Open and close the backpack using game controls', async () => {
    const backpack = page.getByRole('heading', { name: 'Backpack & Market', exact: true });
    await expect(backpack).toBeHidden();
    await page.keyboard.press('b');
    await expect(backpack).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Items', exact: true, selected: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(backpack).toBeHidden();
  });

  expect(pageErrors, 'Uncaught page errors').toEqual([]);
});
