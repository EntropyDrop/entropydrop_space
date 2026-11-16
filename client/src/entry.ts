import { authenticateSpace, checkSpaceDevice, createEntryProgressReporter, renderEntryError } from './bootstrap/SpaceEntryAuth.ts';
import { isMonitoringRoute } from './bootstrap/MonitoringRoute.ts';
import { installNetworkTrafficMonitor } from './bootstrap/NetworkTraffic.ts';
import { SPACE_LOCAL_SESSION } from './bootstrap/SpaceFeatures.ts';

async function openSpace(): Promise<void> {
  try {
    installNetworkTrafficMonitor();
    if (SPACE_LOCAL_SESSION || isMonitoringRoute()
      || (import.meta.env.DEV && new URLSearchParams(location.search).get('dev_offline') === '1')) {
      const { startSpaceGame } = await import('./main.ts');
      await startSpaceGame();
      return;
    }

    checkSpaceDevice();
    const reportProgress = createEntryProgressReporter();
    const auth = await authenticateSpace(reportProgress);
    if (!auth) return;

    reportProgress(20, 'Loading Space…');
    const { startSpaceGame } = await import('./main.ts');
    await startSpaceGame(auth);
  } catch (error) {
    renderEntryError(error);
  } finally {
    if (document.getElementById('space-entry-gate')?.hidden) {
      document.getElementById('space-react-root')?.removeAttribute('inert');
    }
  }
}

void openSpace();
