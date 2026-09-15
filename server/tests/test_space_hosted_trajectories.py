import asyncio
import base64
import uuid

from space.hosting_worker import NodeRuntime
from space.inventory_codec import encode_inventory_resource
from space.entity_pose import parse_hosted_trajectory
from tests.test_space_entities import _entity


def test_hosted_runtime_returns_one_pose_sample_per_fixed_tick_without_extra_simulation():
    definition = _entity('Hosted trajectory')
    definition['root']['script'] = 'self.state.ticks = (self.state.ticks || 0) + 1;'
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
