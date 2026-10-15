
/* =========================================================
   PROJENIUS BACKEND — AUTH SERVICE
   Responsibility: Password verification and admin lookup
========================================================= */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

import { promisify } from "node:util";
import Admin from "./admin.model.js";
import { LEGACY_ADMIN_PERMISSIONS, normalizePermissions } from "../management/permissions.js";

const scrypt = promisify(scryptCallback);

// SECTION: PASSWORD HASHING
export async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    Buffer.byteLength(password, "utf8") > 1024
  ) {
    throw new Error("Invalid password input.");
  }

  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });

  return [
    "scrypt",
    "32768",
    salt.toString("hex"),
    Buffer.from(derivedKey).toString("hex"),
  ].join("$");
}

// SECTION: PASSWORD VERIFICATION
export async function verifyPassword(password, storedHash) {
  try {
    if (
      typeof password !== "string" ||
      typeof storedHash !== "string" ||
      Buffer.byteLength(password, "utf8") > 1024
    ) {
      return false;
    }

    const parts = storedHash.split("$");

    if (
      parts.length !== 4 ||
      parts[0] !== "scrypt" ||
      parts[1] !== "32768" ||
      !/^[a-f0-9]{32}$/.test(parts[2]) ||
      !/^[a-f0-9]{128}$/.test(parts[3])
    ) {
      return false;
    }

    const salt = Buffer.from(parts[2], "hex");
    const expected = Buffer.from(parts[3], "hex");

    const actual = Buffer.from(
      await scrypt(password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      })
    );

    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

// SECTION: FIND ACTIVE ADMIN
export async function findAdminForLogin(email) {
  return Admin.findOne({ email, isActive: true })
    .select("+passwordHash")
    .exec();
}

// SECTION: PUBLIC ADMIN DETAILS
export function serializeAdmin(admin) {
  return {
    id: admin._id.toString(),
    name: admin.name || "",
    email: admin.email,
    role: admin.role,
    permissions: normalizePermissions(
      admin.permissions,
      admin.permissions === undefined ? LEGACY_ADMIN_PERMISSIONS : []
    ),
  };
}
