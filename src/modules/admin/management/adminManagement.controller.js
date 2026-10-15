import mongoose from "mongoose";
import Admin from "../auth/admin.model.js";
import AdminInvitation from "../auth/adminInvitation.model.js";
import AdminAuditEvent from "./adminAudit.model.js";
import { initiatePasswordReset, resendAdminInvitation } from "../auth/auth.controller.js";
import { isValidPermissionList, LEGACY_ADMIN_PERMISSIONS, normalizePermissions } from "./permissions.js";

const PAGE_SIZE_MAX = 100;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pageOptions(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

async function audit(actorId, targetAdminId, action, metadata = {}) {
  return AdminAuditEvent.create({ actorId, targetAdminId, action, metadata });
}

function invalidId(res) {
  return res.status(400).json({ error: "Invalid administrator ID." });
}

export async function listAdministrators(req, res, next) {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const filter = {};
    if (req.query.search) {
      if (typeof req.query.search !== "string" || req.query.search.length > 150) {
        return res.status(400).json({ error: "Invalid administrator search." });
      }
      const pattern = new RegExp(escapeRegex(req.query.search.trim()), "i");
      filter.$or = [{ name: pattern }, { email: pattern }];
    }
    if (req.query.role !== undefined) {
      if (!["admin", "superadmin"].includes(req.query.role)) return res.status(400).json({ error: "Invalid administrator role filter." });
      filter.role = req.query.role;
    }
    if (req.query.status !== undefined) {
      if (!["active", "deactivated", "removed"].includes(req.query.status)) return res.status(400).json({ error: "Invalid account status filter." });
      filter.removedAt = req.query.status === "removed" ? { $ne: null } : null;
      if (req.query.status !== "removed") filter.isActive = req.query.status === "active";
    }

    const [items, total, totalAdministrators, active, deactivated] = await Promise.all([
      Admin.find(filter).select("name email role isActive permissions createdAt lastLoginAt removedAt")
        .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean().exec(),
      Admin.countDocuments(filter),
      Admin.countDocuments(),
      Admin.countDocuments({ isActive: true, removedAt: null }),
      Admin.countDocuments({ isActive: false, removedAt: null }),
    ]);

    return res.json({
      items: items.map((item) => ({
        ...item,
        permissions: normalizePermissions(item.permissions, item.permissions === undefined ? LEGACY_ADMIN_PERMISSIONS : []),
        status: item.removedAt ? "removed" : item.isActive ? "active" : "deactivated",
      })),
      counts: { total: totalAdministrators, active, deactivated },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) { return next(error); }
}

export async function getAdministrator(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const item = await Admin.findById(req.params.id)
      .select("name email role isActive permissions createdAt lastLoginAt removedAt")
      .lean().exec();
    if (!item) return res.status(404).json({ error: "Administrator not found." });
    return res.json({ item: {
      ...item,
      permissions: normalizePermissions(item.permissions, item.permissions === undefined ? LEGACY_ADMIN_PERMISSIONS : []),
      status: item.removedAt ? "removed" : item.isActive ? "active" : "deactivated",
    } });
  } catch (error) { return next(error); }
}

export async function updateAdministratorPermissions(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const permissions = req.body?.permissions;
    if (!isValidPermissionList(permissions)) return res.status(400).json({ error: "The permission selection is invalid." });
    if (req.params.id === req.admin.id) return res.status(400).json({ error: "You cannot change your own permissions." });
    const target = await Admin.findById(req.params.id).exec();
    if (!target) return res.status(404).json({ error: "Administrator not found." });
    if (target.role === "superadmin") return res.status(400).json({ error: "Super Admin permissions are managed by the system role." });
    const previous = normalizePermissions(target.permissions, target.permissions === undefined ? LEGACY_ADMIN_PERMISSIONS : []);
    target.permissions = [...new Set(permissions)];
    await target.save();
    await audit(req.admin.id, target._id, "permissions.changed", { previous, current: target.permissions });
    return res.json({ item: { id: target.id, email: target.email, role: target.role, permissions: target.permissions } });
  } catch (error) { return next(error); }
}

export async function ensureSuperAdminRemains(target) {
  if (target.role !== "superadmin" || !target.isActive) return true;
  const otherActive = await Admin.countDocuments({ role: "superadmin", isActive: true, _id: { $ne: target._id } });
  return otherActive > 0;
}

export async function setAdministratorActive(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    if (typeof req.body?.isActive !== "boolean") return res.status(400).json({ error: "Choose whether the account should be active." });
    if (req.params.id === req.admin.id && !req.body.isActive) return res.status(400).json({ error: "You cannot deactivate your own account." });
    const target = await Admin.findById(req.params.id).exec();
    if (!target) return res.status(404).json({ error: "Administrator not found." });
    if (!req.body.isActive && !await ensureSuperAdminRemains(target)) return res.status(409).json({ error: "The last active Super Admin cannot be deactivated." });
    target.isActive = req.body.isActive;
    target.removedAt = null;
    target.sessionVersion = (target.sessionVersion || 0) + 1;
    await target.save();
    const action = req.body.isActive ? "account.reactivated" : "account.deactivated";
    await audit(req.admin.id, target._id, action);
    return res.json({ item: { id: target.id, email: target.email, role: target.role, isActive: target.isActive } });
  } catch (error) { return next(error); }
}

export async function removeAdministrator(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    if (req.params.id === req.admin.id) return res.status(400).json({ error: "You cannot remove your own account." });
    const target = await Admin.findById(req.params.id).exec();
    if (!target) return res.status(404).json({ error: "Administrator not found." });
    if (!await ensureSuperAdminRemains(target)) return res.status(409).json({ error: "The last active Super Admin cannot be removed." });
    target.isActive = false;
    target.removedAt = new Date();
    target.sessionVersion = (target.sessionVersion || 0) + 1;
    await target.save();
    await audit(req.admin.id, target._id, "account.removed");
    return res.status(200).json({ message: "Administrator access removed." });
  } catch (error) { return next(error); }
}

export async function listPendingInvitations(req, res, next) {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const filter = { usedAt: null, expiresAt: { $gt: new Date() } };
    const [items, total] = await Promise.all([
      AdminInvitation.find(filter).select("name email permissions invitedBy createdAt expiresAt")
        .sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      AdminInvitation.countDocuments(filter),
    ]);
    return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}

export async function resendInvitation(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const result = await resendAdminInvitation(req.params.id, req.admin.id);
    if (!result) return res.status(404).json({ error: "An active pending invitation was not found." });
    return res.status(202).json({ message: "A new account-setup invitation was sent." });
  } catch (error) { return next(error); }
}

export async function triggerPasswordReset(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    if (req.params.id === req.admin.id) return res.status(400).json({ error: "Use the account recovery flow to reset your own password." });
    const target = await Admin.findOne({ _id: req.params.id, isActive: true, removedAt: null }).exec();
    if (!target) return res.status(404).json({ error: "Active administrator not found." });
    await initiatePasswordReset(target, req.admin.id);
    return res.status(202).json({ message: "Password reset instructions were sent to the administrator." });
  } catch (error) { return next(error); }
}

export async function listAdminAuditEvents(req, res, next) {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const [items, total] = await Promise.all([
      AdminAuditEvent.find().populate("actorId", "name email role").populate("targetAdminId", "name email role")
        .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean().exec(),
      AdminAuditEvent.countDocuments(),
    ]);
    return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}
