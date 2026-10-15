
/* =========================================================
   PROJENIUS BACKEND — INITIAL ADMIN SETUP
   Responsibility: Create the first super-admin securely
========================================================= */

import "dotenv/config";

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { connectDatabase, disconnectDatabase, initializeDatabaseModels } from "../src/config/database.js";
import Admin from "../src/modules/admin/auth/admin.model.js";
import { hashPassword } from "../src/modules/admin/auth/auth.service.js";
import { normalizeEmail } from "../src/modules/admin/auth/auth.validation.js";

// SECTION: VALIDATE ENVIRONMENT
if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is not configured.");
}
// SECTION: READ PASSWORD WITHOUT ECHOING IT
function readHiddenPassword(prompt) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(new Error("Run this script in an interactive terminal."));
      return;
    }

    stdout.write(prompt);

    let password = "";

    const onData = (chunk) => {
      const input = chunk.toString();

      for (const character of input) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Setup cancelled."));
          return;
        }

        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(password);
          return;
        }

        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
        } else {
          password += character;
        }
      }
    };

    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// SECTION: CREATE INITIAL ADMIN
async function createInitialAdmin() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    await connectDatabase();
    await initializeDatabaseModels();

    const existingAdmin = await Admin.exists({ role: "superadmin", isActive: true });
    if (existingAdmin) {
      throw new Error(
        "An admin already exists. Initial setup is disabled."
      );
    }

    const emailInput = await rl.question("Admin email: ");
    const email = normalizeEmail(emailInput);

    if (!email) {
      throw new Error("Please enter a valid email address.");
    }

    const nameInput = await rl.question("Admin name: ");
    if (!nameInput.trim() || nameInput.trim().length > 120) {
      throw new Error("Enter a name between 1 and 120 characters.");
    }

    // readline must not remain attached while raw hidden password input is active.
    rl.close();

    const password = await readHiddenPassword("Admin password: ");

    if (
      password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 1024
    ) {
      throw new Error(
        "Use a password between 12 and 1024 bytes."
      );
    }

    const confirmation = await readHiddenPassword(
      "Confirm password: "
    );

    if (password !== confirmation) {
      throw new Error("Passwords do not match.");
    }

    const passwordHash = await hashPassword(password);

    await Admin.create({
      name: nameInput.trim(),
      email,
      passwordHash,
      role: "superadmin",
      isActive: true,
    });

    console.log("Initial superadmin created successfully.");
  } finally {
    rl.close();
    await disconnectDatabase();
  }
}

createInitialAdmin().catch(() => {
  console.error("Initial admin setup failed. Check the prompts and configured database access.");
  process.exitCode = 1;
});
