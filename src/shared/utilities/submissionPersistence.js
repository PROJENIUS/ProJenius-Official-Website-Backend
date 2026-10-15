import crypto from "node:crypto";

function makeReference(prefix) {
  const date = new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    .replace(/-/g, "");

  return `${prefix}-${date}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function createUniqueReference(Model, prefix) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const referenceNumber = makeReference(prefix);
    if (!(await Model.exists({ referenceNumber }))) return referenceNumber;
  }

  const error = new Error("Unable to create a submission reference.");
  error.status = 503;
  throw error;
}

function isReferenceDuplicate(error) {
  return error?.code === 11000 && (
    error.keyPattern?.referenceNumber === 1 ||
    Object.hasOwn(error.keyValue || {}, "referenceNumber")
  );
}

export async function saveWithUniqueReference(Model, prefix, fields) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const record = new Model({
      ...fields,
      referenceNumber: await createUniqueReference(Model, prefix),
    });

    try {
      await record.save();
      return record;
    } catch (error) {
      if (!isReferenceDuplicate(error) || attempt === 4) throw error;
    }
  }

  const error = new Error("Unable to create a submission reference.");
  error.status = 503;
  throw error;
}
