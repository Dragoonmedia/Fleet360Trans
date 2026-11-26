// Shared (client + server) permission rules.
// Admin and above can write everywhere; a regular user needs a matching "<module>:write" permission.
// The aliases cover the different keys that older screens used for the same module.

export type Module =
  | "vehicles"
  | "drivers"
  | "fuel"
  | "work_orders"
  | "oil"
  | "tires"
  | "spare_parts"
  | "inspections"
  | "fleet_import";

const ALIASES: Record<Module, string[]> = {
  vehicles: ["vehicles:write", "fleet:write"],
  drivers: ["vehicles:write", "fleet:write"],
  fuel: ["fuel:write", "fleet:write"],
  work_orders: ["maintenance:write", "work_orders:write", "fleet:write"],
  oil: ["oil-changes:write", "oil:write", "fleet:write"],
  tires: ["oil-changes:write", "oil:write", "tires:write", "fleet:write"],
  spare_parts: ["spare-parts:write"],
  inspections: ["inspections:write"],
  fleet_import: ["fleet:write"],
};

const POWER: Record<string, number> = { owner: 4, super_admin: 3, admin: 2, user: 1 };

type PermUser = { role?: string | null; permissions?: unknown } | null | undefined;

function permList(p: unknown): string[] {
  if (Array.isArray(p)) return p.map(String);
  if (typeof p === "string") {
    try {
      const parsed = JSON.parse(p);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return p.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

export function canWrite(user: PermUser, module: Module): boolean {
  if (!user) return false;
  if ((POWER[user.role || "user"] ?? 1) >= 2) return true;
  const perms = permList(user.permissions);
  if (perms.includes("all")) return true;
  return ALIASES[module].some((k) => perms.includes(k));
}
