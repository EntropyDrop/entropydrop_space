import React from 'react';
import { onlineSpaceUrl, ONLINE_SPACE_FEATURES, type OnlineSpaceFeature } from '../../../bootstrap/SpaceSiteLinks.ts';
import { SPACE_TUTORIAL } from '../../../bootstrap/SpaceFeatures.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';

const tutorialDescriptions: Record<OnlineSpaceFeature, string> = {
  market: 'The community market is unavailable in the tutorial.',
  publish: 'Leave the tutorial to publish items from your backpack.',
  'agent-build': 'External agents are unavailable in the tutorial.',
  'api-keys': 'Account services are unavailable in the tutorial.',
  'ai-assistant': 'The code in this tutorial explains how entities work. In the full game, you can usually describe what you want to the Agent in natural language instead of writing code yourself. AI assistance is unavailable in the tutorial.',
  hosting: 'Server hosting is unavailable in the tutorial. Entities can run locally.',
  character: 'Leave the tutorial to customize your character.',
  worlds: 'Multiplayer and linked worlds are unavailable in the tutorial.',
};

export function OnlineSpaceNotice({ feature, compact = false }: { feature: OnlineSpaceFeature; compact?: boolean }) {
  const { title, description, panel, action } = ONLINE_SPACE_FEATURES[feature];
  if (SPACE_TUTORIAL) return (
    <section className={`offline-online-notice${compact ? ' compact' : ''}`} role="note">
      <h3>{title}</h3>
      <p>{tutorialDescriptions[feature]}</p>
      <button type="button" className="small-btn primary" onClick={() => void spaceUiStore.navigateTutorial(false)}>Leave tutorial</button>
    </section>
  );
  return (
    <section className={`offline-online-notice${compact ? ' compact' : ''}`}>
      <h3>{title}</h3>
      <p>{description}</p>
      <p className="settings-desc">Your offline world stays saved in this browser. Online worlds have separate saves.</p>
      <a className="small-btn primary" href={onlineSpaceUrl(panel)}
        target="_blank" rel="noopener noreferrer">{action} ↗</a>
    </section>
  );
}
