import React from 'react';

export function AgentApiKeySecurityNotice({
  id,
  rememberApiKey = false,
}: {
  id?: string;
  rememberApiKey?: boolean;
}) {
  return (
    <div
      id={id}
      className={`agent-api-key-security-note ${rememberApiKey ? 'persistent' : 'session-only'}`}
      role="note"
      aria-label="API key security warning"
    >
      {rememberApiKey ? (
        <><strong>Plaintext storage warning:</strong> This API key will be saved unencrypted in localStorage and can be read by scripts running on this site. Use this option only on a trusted, private device.</>
      ) : (
        <><strong>Tab-only by default:</strong> This API key is stored in sessionStorage for this tab and is cleared when the tab closes. Scripts running on this site can still read it.</>
      )}
    </div>
  );
}
