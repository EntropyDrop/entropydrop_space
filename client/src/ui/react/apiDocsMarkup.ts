import { renderApiReferenceHtml } from '@entropydrop/space-engine/contraption/ScriptApiContract.ts';
import { spaceAgentConnection } from '../../bootstrap/SpaceAgentGuide.ts';

// Canonical entityAPI documentation with links to the configured Space backend.
// React owns the modal lifecycle and surrounding UI.
export function apiDocsBodyMarkup(apiOrigin: string): string {
  return renderApiReferenceHtml(undefined, spaceAgentConnection(apiOrigin));
}
