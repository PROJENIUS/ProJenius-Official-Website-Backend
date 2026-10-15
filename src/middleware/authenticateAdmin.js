
/* =========================================================
   PROJENIUS BACKEND — ADMIN AUTHENTICATION MIDDLEWARE
   Responsibility: Validate admin, session age and activity
========================================================= */

import mongoose from "mongoose";
import Admin from "../modules/admin/auth/admin.model.js";

// SECTION: SESSION EXPIRATION
function isSessionExpired(session, now) {
  const {
    authenticatedAt,
    lastActivityAt,
    absoluteExpiresAt,
    idleTimeoutMs,
  } = session;

  // Reject legacy sessions that lack required security metadata.
  if (
    !Number.isFinite(authenticatedAt) ||
    !Number.isFinite(lastActivityAt) ||
    !Number.isFinite(absoluteExpiresAt) ||
    !Number.isFinite(idleTimeoutMs)
  ) {
    return true;
  }

  if (now >= absoluteExpiresAt) return true;

  if (now - lastActivityAt >= idleTimeoutMs) return true;

  return false;
}

// SECTION: REQUIRE AUTHENTICATED ADMIN
export async function authenticateAdmin(req, res, next) {
  try {
    const session = req.session;
    const adminId = session?.adminId;

    if (!adminId || !mongoose.isValidObjectId(adminId)) {
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    // SECTION: ENFORCE SERVER-SIDE TIMEOUTS
    const now = Date.now();

    if (isSessionExpired(session, now)) {
      return req.session.destroy((error) => {
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
        return res.status(401).json({
          error: "Session expired. Please sign in again.",
        });
      });
    }

    // SECTION: VERIFY ACTIVE ADMIN ACCOUNT
    const admin = await Admin.findOne({
      _id: adminId,
      isActive: true,
      role: { $in: ["superadmin", "admin"] },
    })
      .select("_id email name role permissions")
      .select("sessionVersion")
      .lean()
      .exec();

    if (!admin) {
      return req.session.destroy((error) => {
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

        return res.status(401).json({
          error: "Authentication required.",
        });
      });
    }

    if ((session.adminAuthVersion ?? -1) !== (admin.sessionVersion || 0)) {
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie(
          process.env.NODE_ENV === "production" ? "__Host-pj.sid" : "pj.sid",
          { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" }
        );
        return res.status(401).json({ error: "Authentication required." });
      });
    }

    // SECTION: UPDATE IDLE-ACTIVITY TIMESTAMP
    session.lastActivityAt = now;

    // Renew the cookie only up to the absolute deadline.
    const remainingAbsoluteMs = session.absoluteExpiresAt - now;

    session.cookie.maxAge = Math.min(
      session.idleTimeoutMs,
      remainingAbsoluteMs
    );

    req.admin = {
      id: admin._id.toString(),
      email: admin.email,
      name: admin.name || "",
      role: admin.role,
      permissions: Array.isArray(admin.permissions) ? admin.permissions : undefined,
    };

    next();
  } catch (error) {
    next(error);
  }
}
