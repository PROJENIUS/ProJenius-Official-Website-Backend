
/* =========================================================
   PROJENIUS BACKEND — AUTH VALIDATION
   Responsibility: Validate authentication input
========================================================= */

// SECTION: EMAIL VALIDATION
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;

  const email = value.trim().toLowerCase();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}

// SECTION: LOGIN VALIDATION
export function validateLogin(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false };
  }

  const email = normalizeEmail(body.email);
  const password = body.password;

  if (
    !email ||
    typeof password !== "string" ||
    password.length === 0 ||
    Buffer.byteLength(password, "utf8") > 1024 ||
    (body.rememberMe !== undefined &&
      typeof body.rememberMe !== "boolean")
  ) {
    return { valid: false };
  }

  return {
    valid: true,
    email,
    password,
    rememberMe: body.rememberMe === true,
  };
}

export function validatePassword(value) {
  return typeof value === "string" && value.length >= 12 &&
    Buffer.byteLength(value, "utf8") <= 1024;
}

export function validateAdminName(value) {
  return typeof value === "string" && value.trim().length >= 1 &&
    value.trim().length <= 120;
}
