'use strict';

const LOCAL_OWNER = 'local';

// App Service Easy Auth strips any client-supplied X-MS-CLIENT-PRINCIPAL-* headers and sets
// them for signed-in users, so the header can be trusted when the app runs behind Easy Auth.
function resolveOwner(headers, { requireAuth }) {
  const principalId = headers['x-ms-client-principal-id'];
  if (typeof principalId === 'string' && principalId.trim()) return principalId.trim();
  return requireAuth ? null : LOCAL_OWNER;
}

module.exports = { LOCAL_OWNER, resolveOwner };
