/** Match the editor's asynchronous save/typecheck lifecycle in integration tests. */
export async function setNodeScript(entity: any, nodeId: string, code: string): Promise<boolean> {
  const accepted = entity.setNodeScript(nodeId, code);
  await entity.scriptRuntimeClient.ready();
  return accepted && !entity.nodeScriptErrors.has(nodeId);
}
export async function setScript(entity: any, code: string): Promise<boolean> {
  return setNodeScript(entity, entity.rootComponentId, code);
}
