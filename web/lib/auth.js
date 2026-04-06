import crypto from "node:crypto";

function normalizedHeader(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value.trim() : "";
}

function extractBearerToken(req) {
  const auth = normalizedHeader(req.headers?.authorization);
  if (!auth) return "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function getSecretFromRequest(req) {
  const headerKey = normalizedHeader(req.headers?.["x-sniffmaster-key"]);
  if (headerKey) return headerKey;

  const bearer = extractBearerToken(req);
  if (bearer) return bearer;

  const bodyKey = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  return bodyKey;
}

function constantTimeEqual(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireSharedSecret(req, res, envVar, realm = "sniffmaster") {
  const expected = process.env[envVar] || "";
  const supplied = getSecretFromRequest(req);

  if (!constantTimeEqual(supplied, expected)) {
    res.setHeader("WWW-Authenticate", `Bearer realm="${realm}"`);
    res.status(401).json({ error: "invalid key" });
    return false;
  }
  return true;
}

export function requireDeviceAuth(req, res) {
  return requireSharedSecret(req, res, "SNIFFMASTER_API_KEY", "sniffmaster-device");
}

export function requireOwnerAuth(req, res) {
  const owner = process.env.SNIFFMASTER_OWNER_KEY || "";
  if (owner) {
    return requireSharedSecret(req, res, "SNIFFMASTER_OWNER_KEY", "sniffmaster-owner");
  }

  // Easy-but-still-gated fallback: if no dedicated owner key is configured,
  // reuse the device key for owner actions. The key is still supplied at
  // runtime and never embedded in the public frontend.
  return requireSharedSecret(req, res, "SNIFFMASTER_API_KEY", "sniffmaster-owner");
}

export function sanitizePostedBody(body) {
  if (!body || typeof body !== "object") return {};
  const { key, ...rest } = body;
  return rest;
}
