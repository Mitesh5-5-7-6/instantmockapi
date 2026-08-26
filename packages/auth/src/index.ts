// @instantmockapi/auth — AuthN/AuthZ helpers: JWT issuance/verification,
// Fastify authenticate plugin, and ownership checks (doc 13 §1–2).

export {
  type TokenType,
  type AuthUser,
  type AuthTokenClaims,
  REFRESH_TOKEN_LIFETIME_SECONDS,
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
  verifyAccessToken,
  verifyRefreshToken,
  extractBearerToken,
} from './tokens.js';

export { hashPassword, verifyPassword, needsRehash, PASSWORD_COST } from './password.js';

export { verifyGoogleCode, type GoogleIdentity } from './google.js';

export { isOwner, assertOwnership } from './ownership.js';

export { authPlugin, type AuthPluginOptions } from './plugin.js';
