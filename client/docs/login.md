# Shared EntropyDrop login

Space uses the main account service configured by `VITE_API_BASE_URL` for
`/api/auth/google`, `/api/auth/config`, and `/api/auth/refresh`. Space's own API
origin must not be used for Google authentication.

The account service's public `/api/auth/config` returns `google_client_id` from
`GOOGLE_CLIENT_ID`. A build may override it with `VITE_GOOGLE_CLIENT_ID`, which
must identify the same Google client accepted by the account service.

In that Google OAuth client's **Authorized JavaScript origins**, include both
`https://entropydrop.com` and `https://space.entropydrop.com` (and any explicitly
used development origin). Include the same browser origins in the account
service's `CORS_ORIGINS`. Google setup:
https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid

Deploy the account service cookie fix and configuration endpoint before the main
frontend and Space client. No database migration is required. Do not use an old
account deployment that clears every cookie path on a missing-session refresh.

Both browsers send account requests with credentials. Refresh first checks
`/api/auth/refresh`, then `/skin/api/auth/refresh` for legacy path-scoped cookies.
A failed refresh only clears a submitted cookie at that route's path; a request
without a cookie leaves other sessions untouched. Transport failures remain
retryable instead of being treated as logout.

Main-site launch links and `/space/app` route through `/space/login`, which
restores the session and transfers a short-lived access token in a URL fragment
only to an allowed Space origin. Space removes incoming credentials from the
address bar before starting the world. When opened directly without a session,
Space makes one silent main-site round trip to recover older localStorage-only
logins. The `sso_attempted=1` return marker prevents anonymous redirect loops.

When a login is actually required, the entry screen displays Google's official
button. Login posts the Google credential to the shared account API and reloads
Space with the returned access token. The main-site login link remains available
if Google cannot load or the Space origin is not yet authorized. A rejected
Space token sends `reauth=1` to that link so the main site cannot immediately
return the same rejected cached token.
