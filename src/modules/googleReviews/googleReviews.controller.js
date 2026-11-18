import { getGoogleReviews } from "./googleReviews.service.js";
import { parseReviewPagination } from "./googleReviews.validation.js";

export async function getPublicGoogleReviews(req, res) {
  const parsed = parseReviewPagination(req.query);
  if (parsed.error) {
    return res.status(400).json({
      error: parsed.error,
      code: "INVALID_GOOGLE_REVIEWS_QUERY",
    });
  }

  try {
    const result = await getGoogleReviews(parsed.value);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
    return res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 503;
    const configured = error?.code === "GOOGLE_REVIEWS_NOT_CONFIGURED";
    if (process.env.NODE_ENV !== "production") {
      console.warn("Google Reviews request failed:", error?.code || "GOOGLE_REVIEWS_UNKNOWN_ERROR");
    }
    return res.status(status).json({
      error: configured
        ? "Google Reviews integration is not configured."
        : "Google Reviews are temporarily unavailable.",
      code: configured ? "GOOGLE_REVIEWS_NOT_CONFIGURED" : "GOOGLE_REVIEWS_UNAVAILABLE",
    });
  }
}
