import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getPublicGoogleReviews } from "./googleReviews.controller.js";

export function createGoogleReviewsRouter(options = {}) {
  const router = Router();
  const limiter = rateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    limit: options.limit ?? 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many review requests. Please try again later." },
  });

  router.get("/", limiter, getPublicGoogleReviews);
  return router;
}

export default createGoogleReviewsRouter();
