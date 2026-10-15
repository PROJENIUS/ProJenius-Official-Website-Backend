
/* =========================================================
   PROJENIUS BACKEND — AUTH CONTROLLER
   Responsibility: Secure admin authentication and sessions
========================================================= */

import { createHash, randomBytes } from "node:crypto";
import Admin from "./admin.model.js";
import AdminInvitation from "./adminInvitation.model.js";
import PasswordReset from "./passwordReset.model.js";
import AdminAuditEvent from "../management/adminAudit.model.js";
import { DEFAULT_ADMIN_PERMISSIONS, isValidPermissionList } from "../management/permissions.js";
import { sendInvitationEmail, sendPasswordResetEmail } from "./authEmail.service.js";

import {
  findAdminForLogin,
  hashPassword,
  serializeAdmin,
  verifyPassword,
} from "./auth.service.js";

import { normalizeEmail, validateAdminName, validateLogin, validatePassword } from "./auth.validation.js";

const INVITATION_MS = 24 * 60 * 60 * 1000;
const RESET_MS = 30 * 60 * 1000;
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
function adminSiteLink(path, token) {
  const origin = process.env.ADMIN_SITE_ORIGIN?.replace(/\/+$/, "");
  if (!origin) throw new Error("Admin site origin is not configured.");
  return `${origin}${path}?token=${encodeURIComponent(token)}`;
}

// SECTION: SESSION POLICY
const SESSION_POLICY = {
  normal: {
    idleMs: 60 * 60 * 1000,
    absoluteMs: 8 * 60 * 60 * 1000,
  },
  remembered: {
    idleMs: 24 * 60 * 60 * 1000,
    absoluteMs: 7 * 24 * 60 * 60 * 1000,
  },
};

// SECTION: ISSUE CSRF TOKEN
export function getCsrfToken(req, res) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }

  res.set("Cache-Control", "no-store");
  res.json({ csrfToken: req.session.csrfToken });
}

// SECTION: CURRENT ADMIN SESSION
export function getCurrentAdmin(req, res) {
  res.set("Cache-Control", "no-store");
  res.json({ admin: req.admin });
}

// SECTION: ADMIN LOGIN
export async function loginAdmin(req, res, next) {
  try {
    const result = validateLogin(req.body);

    if (!result.valid) {
      return res.status(400).json({
        error: "Please enter valid login credentials.",
      });
    }

    const admin = await findAdminForLogin(result.email);

    // SECTION: VERIFY CREDENTIALS
    const passwordMatches = admin
      ? await verifyPassword(result.password, admin.passwordHash)
      : false;

    if (!admin || !passwordMatches || !admin.isActive ||
        !["superadmin", "admin"].includes(admin.role)) {
      return res.status(401).json({
        error: "Invalid email or password.",
      });
    }

    // SECTION: REGENERATE SESSION AFTER LOGIN
    req.session.regenerate(async (regenerateError) => {
      if (regenerateError) return next(regenerateError);

      try {
        const now = Date.now();
        const rememberMe = result.rememberMe === true;

        const policy = rememberMe
          ? SESSION_POLICY.remembered
          : SESSION_POLICY.normal;

        req.session.adminId = admin._id.toString();
        req.session.adminAuthVersion = admin.sessionVersion || 0;
        req.session.csrfToken = randomBytes(32).toString("hex");

        // SECTION: SERVER-ENFORCED EXPIRATION
        req.session.authenticatedAt = now;
        req.session.lastActivityAt = now;
        req.session.absoluteExpiresAt = now + policy.absoluteMs;
        req.session.idleTimeoutMs = policy.idleMs;
        req.session.rememberMe = rememberMe;

        req.session.cookie.maxAge = policy.idleMs;

        admin.lastLoginAt = new Date(now);
        await admin.save();

        await new Promise((resolve, reject) => {
          req.session.save((saveError) => {
            if (saveError) reject(saveError);
            else resolve();
          });
        });

        res.set("Cache-Control", "no-store");
        res.json({
          admin: serializeAdmin(admin),
          csrfToken: req.session.csrfToken,
        });
      } catch (error) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
}

// SECTION: ADMIN LOGOUT
export function logoutAdmin(req, res, next) {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie(
      process.env.NODE_ENV === "production"
        ? "__Host-pj.sid"
        : "pj.sid",
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      }
    );

    res.set("Cache-Control", "no-store");
    res.status(200).json({
      message: "Signed out successfully.",
    });
  });
}

// SECTION: ADMINISTRATOR INVITATIONS
export async function inviteAdmin(req, res, next) {
  try {
    if (req.admin.role !== "superadmin") return res.status(403).json({ error: "Only a superadmin can invite administrators." });
    const email = normalizeEmail(req.body?.email);
    const name = req.body?.name;
    const permissions = req.body?.permissions === undefined
      ? [...DEFAULT_ADMIN_PERMISSIONS]
      : req.body.permissions;
    if (!email || !validateAdminName(name)) return res.status(400).json({ error: "Enter a valid name and email address." });
    if (!isValidPermissionList(permissions)) return res.status(400).json({ error: "The permission selection is invalid." });
    if (await Admin.exists({ email })) return res.status(409).json({ error: "An administrator already uses that email address." });

    await AdminInvitation.updateMany({ email, usedAt: null }, { $set: { usedAt: new Date() } });
    const token = randomBytes(32).toString("hex");
    const invitation = await AdminInvitation.create({
      email, name: name.trim(), permissions, tokenHash: hashToken(token),
      invitedBy: req.admin.id, expiresAt: new Date(Date.now() + INVITATION_MS),
    });
    try {
      await sendInvitationEmail({ to: email, name: name.trim(), link: adminSiteLink("/accept-invitation", token) });
    } catch (error) {
      await AdminInvitation.deleteOne({ _id: invitation._id });
      return res.status(503).json({ error: "The invitation could not be sent. Please try again later." });
    }
    await AdminAuditEvent.create({ actorId: req.admin.id, targetAdminId: null, action: "invitation.created", metadata: { email, permissions } });
    return res.status(202).json({ message: "Invitation sent." });
  } catch (error) { return next(error); }
}

export async function acceptAdminInvitation(req, res, next) {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !validatePassword(password)) {
      return res.status(400).json({ error: "The invitation or password is invalid." });
    }
    const invitation = await AdminInvitation.findOneAndUpdate({
      tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() },
    }, { $set: { usedAt: new Date() } }, { new: true }).exec();
    if (!invitation) return res.status(400).json({ error: "This invitation is invalid or has expired." });
    if (await Admin.exists({ email: invitation.email })) return res.status(409).json({ error: "An administrator already uses this email." });
    const admin = await Admin.create({
      name: invitation.name,
      email: invitation.email,
      passwordHash: await hashPassword(password),
      role: "admin",
      isActive: true,
      permissions: isValidPermissionList(invitation.permissions)
        ? invitation.permissions
        : [...DEFAULT_ADMIN_PERMISSIONS],
    });
    await AdminAuditEvent.create({ actorId: admin._id, targetAdminId: admin._id, action: "invitation.accepted", metadata: {} }).catch(() => {});
    return res.status(201).json({ message: "Administrator account created. You can now sign in." });
  } catch (error) { return next(error); }
}

// SECTION: PASSWORD RECOVERY
export async function requestPasswordReset(req, res, next) {
  try {
    const generic = { message: "If an active administrator account matches that email, a reset link will be sent." };
    const email = normalizeEmail(req.body?.email);
    if (email) {
      const admin = await Admin.findOne({ email, isActive: true }).select("_id email name").exec();
      if (admin) {
        try {
          await initiatePasswordReset(admin, null);
        } catch {
          // Keep the public response generic for unknown addresses and delivery failures.
        }
      }
    }
    return res.status(202).json(generic);
  } catch (error) { return next(error); }
}

export async function initiatePasswordReset(admin, actorId) {
  await PasswordReset.updateMany({ adminId: admin._id, usedAt: null }, { $set: { usedAt: new Date() } });
  const token = randomBytes(32).toString("hex");
  const reset = await PasswordReset.create({ adminId: admin._id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_MS) });
  try {
    await sendPasswordResetEmail({ to: admin.email, name: admin.name, link: adminSiteLink("/reset-password", token) });
  } catch (error) {
    await PasswordReset.deleteOne({ _id: reset._id });
    throw error;
  }
  await AdminAuditEvent.create({
    actorId: actorId || admin._id,
    targetAdminId: admin._id,
    action: "password_reset.initiated",
    metadata: { source: actorId ? "superadmin" : "self_service" },
  });
}

export async function resendAdminInvitation(invitationId, actorId) {
  const prior = await AdminInvitation.findById(invitationId).lean().exec();
  if (!prior || prior.usedAt || await Admin.exists({ email: prior.email })) return null;
  await AdminInvitation.updateMany({ email: prior.email, usedAt: null }, { $set: { usedAt: new Date() } });
  const token = randomBytes(32).toString("hex");
  const replacement = await AdminInvitation.create({
    email: prior.email,
    name: prior.name,
    permissions: isValidPermissionList(prior.permissions) ? prior.permissions : [...DEFAULT_ADMIN_PERMISSIONS],
    tokenHash: hashToken(token),
    invitedBy: actorId,
    expiresAt: new Date(Date.now() + INVITATION_MS),
  });
  try {
    await sendInvitationEmail({ to: prior.email, name: prior.name, link: adminSiteLink("/accept-invitation", token) });
  } catch (error) {
    await AdminInvitation.deleteOne({ _id: replacement._id });
    throw error;
  }
  await AdminAuditEvent.create({ actorId, targetAdminId: null, action: "invitation.resent", metadata: { email: prior.email, permissions: replacement.permissions } });
  return replacement;
}

export async function resetAdminPassword(req, res, next) {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !validatePassword(password)) {
      return res.status(400).json({ error: "The reset link or password is invalid." });
    }
    const reset = await PasswordReset.findOneAndUpdate({
      tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() },
    }, { $set: { usedAt: new Date() } }, { new: true }).exec();
    if (!reset) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    const admin = await Admin.findOne({ _id: reset.adminId, isActive: true }).exec();
    if (!admin) return res.status(400).json({ error: "This reset link is invalid or has expired." });
    admin.passwordHash = await hashPassword(password);
    admin.sessionVersion = (admin.sessionVersion || 0) + 1;
    await admin.save();
    await AdminAuditEvent.create({ actorId: admin._id, targetAdminId: admin._id, action: "password_reset.completed", metadata: {} }).catch(() => {});
    return res.status(200).json({ message: "Password updated. You can now sign in." });
  } catch (error) { return next(error); }
}
