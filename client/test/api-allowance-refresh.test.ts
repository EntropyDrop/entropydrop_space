import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

const settings = readFileSync(new URL('../src/ui/react/components/SimpleModals.tsx', import.meta.url), 'utf8');
const hud = readFileSync(new URL('../src/ui/react/components/Hud.tsx', import.meta.url), 'utf8');

test('terrain acknowledgement changes refresh pricing and allowances immediately', () => {
  const store = new SpaceUiStore();
  store.setWorldEditSync({ pendingBatches: 1, pendingMutations: 1, acknowledgedBatches: 0 });
  assert.equal(store.getSnapshot().worldEditSync.acknowledgedBatches, 0);
  store.setWorldEditSync({ pendingBatches: 0, pendingMutations: 0, acknowledgedBatches: 1 });
  assert.equal(store.getSnapshot().worldEditSync.acknowledgedBatches, 1);
  assert.match(settings, /useSpaceUi\(state => state\.worldEditSync\.acknowledgedBatches\)/);
  assert.match(settings, /void loadUsage\(\);[\s\S]*?\}, \[loadUsage, acknowledgedBatches, syncIdle\]\)/);
  assert.match(settings, /window\.setInterval\(refresh, 30000\)/, 'external builds still receive periodic refreshes');
});

test('stale allowance responses and unmounted requests cannot replace newer usage', () => {
  assert.match(settings, /const requestId = \+\+usageRequestId\.current/);
  assert.match(settings, /const nextUsage = await client\.usage\(worldId\);\s*if \(requestId !== usageRequestId\.current\) return;\s*setUsage\(nextUsage\)/);
  assert.match(settings, /catch \(error: any\) \{\s*if \(requestId !== usageRequestId\.current\) return;\s*setUsageError/);
  assert.match(settings, /return \(\) => \{\s*active = false;\s*usageRequestId\.current\+\+;/);
});

test('queued bulk acknowledgements are coalesced instead of exhausting the usage endpoint', () => {
  assert.match(settings, /const syncIdle = useSpaceUi\(state => state\.worldEditSync\.pendingBatches === 0 && !state\.worldEditSync\.sending\)/);
  assert.match(settings, /if \(!syncIdle \|\| usageAcknowledgement\.current === acknowledgedBatches\) return;\s*usageAcknowledgement\.current = acknowledgedBatches;\s*void loadUsage\(\)/);
});

test('administrator-exempt allowances show unlimited instead of a misleading unchanged balance', () => {
  assert.match(settings, /\['Terrain changes · this UTC hour', usage\.quotas\.terrain\.hour, usage\.admin_quota_exemptions\]/);
  assert.match(settings, /\['Terrain changes · today \(UTC\)', usage\.quotas\.terrain\.day, usage\.admin_quota_exemptions\]/);
  assert.match(settings, /exempt \? 'Unlimited · administrator'/);
  assert.match(settings, /quota\.used\.toLocaleString\(\)\} used · quota exempt/);
  assert.match(hud, /const quotaText = isAdmin\s*\? `Terrain edit allowance: unlimited \(administrator\)/);
  assert.match(hud, /worldEditSync\.quota\.usedToday\.toLocaleString\(\)\} edits today/);
});
