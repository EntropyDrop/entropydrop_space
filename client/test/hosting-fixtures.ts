export function hostingStatus(overrides: Record<string, unknown> = {}) {
  return {
    entity_id: '3cd7daba-d196-44e8-a433-cf139258f617', world_id: 'world-1', name: 'Hosted Walker',
    position: { x_cm: 100, y_cm: 3200, z_cm: 200 }, teleport_position: { x_cm: 3600, y_cm: 3400, z_cm: 200 },
    can_manage: true, core_id: 0, revision: 2, execution_epoch: 1,
    execution_mode: 'hosted', enabled: true, state: 'starting',
    reason: null, error: null, credits_per_hour: 1, remaining_ms: 3_500_000,
    budget_remaining_credits: 1, billed_hours: 1, last_tick_at: null, activity_radius_chunks: 2,
    ...overrides,
  };
}

export function hostingList(overrides: Record<string, unknown> = {}) {
  return { enabled: true, worker_available: true,
    capacity: { limit: 128, total: 128, used: 1, available: 127 }, items: [hostingStatus()], ...overrides };
}
