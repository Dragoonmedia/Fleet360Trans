import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

// ⚠️ لا يوجد مفتاح افتراضي في الإنتاج: لازم JWT_SECRET يتحط في Environment Variables على Vercel
// (يفضّل 32 حرف عشوائي أو أكتر). في بيئة التطوير فقط بنستخدم مفتاح مؤقت.
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV !== "production") return "dev-only-secret-do-not-use-in-production";
  throw new Error("JWT_SECRET is missing or too short (min 16 chars)");
}

export interface JWTPayload {
  userId: number;
  username: string;
  name?: string;
  role: string;
  permissions: string[];
  tenantId?: string;
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: "24h", algorithm: "HS256" });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, getSecret(), { algorithms: ["HS256"] }) as JWTPayload;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
