import asyncio
import base64
import uuid

from space.hosting_worker import NodeRuntime
from space.inventory_codec import encode_inventory_resource
from space.entity_pose import parse_hosted_trajectory
from tests.test_space_entities import _entity
from routers import space_realtime
from space.hosting_cores import MAX_HOSTING_CORES


def test_relay_retains_the_full_hosting_pool_and_evicts_oldest_or_expired_trajectories(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(space_realtime.time, 'monotonic', lambda: clock[0])
    hub = space_realtime.SpaceRealtimeHub()
    body = {'id': 'root', 'position': [0, 20, 0], 'quaternion': [0, 0, 0, 1],
            'velocity': [0, 0, 0], 'angularVelocity': [0, 0, 0]}
    ids = [str(uuid.uuid4()) for _ in range(MAX_HOSTING_CORES + 2)]

    def receive(entity_id, revision=1):
        hub._accept_hosted_trajectory('world', {
            'entity_id': entity_id, 'execution_epoch': 1, 'revision': revision,
            'first_sequence': revision * 20, 'poses': [[body]],
        })

    for entity_id in ids[:MAX_HOSTING_CORES]:
        receive(entity_id)
        clock[0] += 0.001
    states = hub.hosted_trajectories['world']
    assert set(states) == set(ids[:MAX_HOSTING_CORES])

    receive(ids[0], revision=2)
    refreshed = states[ids[0]]
    receive(ids[0], revision=1)
    assert states[ids[0]] is refreshed, 'late revisions cannot replace a newer trajectory'
    receive(ids[-2])
    assert len(states) == MAX_HOSTING_CORES
    assert ids[0] in states and ids[1] not in states, 'evict by freshness, not insertion order'

    clock[0] += space_realtime.HOSTED_TRAJECTORY_TTL_SECONDS + 0.001
    receive(ids[-1])
    assert set(states) == {ids[-1]}, 'expired trajectories must not consume hosting capacity'


def test_hosted_runtime_returns_one_pose_sample_per_fixed_tick_without_extra_simulation():
    definition = _entity('Hosted trajectory')
    definition['root']['script'] = 'self.state.setNumber("ticks", self.state.getNumber("ticks") + 1);'
    entity_id = str(uuid.uuid4())
    payload = {'seed': 1, 'steps': 20, 'entities': [{
        'id': entity_id, 'running': True, 'anchor': [80, 80], 'position': [80, 220, 80],
        'yaw_quarter_turns': 0, 'snapshot': None,
        'definition_base64': base64.b64encode(encode_inventory_resource('entity', definition)).decode(),
    }], 'chunks': [{'chunk_x': x, 'chunk_z': z, 'revision': 0, 'standard': [], 'micro': []}
                  for x in range(3, 8) for z in range(3, 8)]}
    async def run():
        runtime = NodeRuntime()
        try:
            return await asyncio.wait_for(runtime.step(payload), 15)
        finally:
            await runtime.close()
    result = asyncio.run(run())
    assert not result.get('error') and not result.get('faults'), result
    item = result['entities'][0]
    assert item['elapsed_ms'] == 1000
    assert item['snapshot']['states']['root']['ticks'] == 20
    assert len(item['poses']) == 20
    assert item['poses'][0][0]['position'][1] > item['poses'][-1][0]['position'][1]
    assert item['poses'][-1][0]['position'] == item['snapshot']['bodies'][0]['position']
    assert item['poses'][-1][0]['collisionEnabled'] is True
    assert parse_hosted_trajectory({'entity_id': entity_id, 'execution_epoch': 1,
        'revision': 2, 'first_sequence': 1, 'poses': item['poses']})
