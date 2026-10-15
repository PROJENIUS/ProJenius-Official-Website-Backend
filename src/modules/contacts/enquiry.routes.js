import { Router } from "express";
import rateLimit from "express-rate-limit";
import { submitEnquiry } from "./enquiry.controller.js";
import { uploadEnquiryAttachment } from "./enquiry.upload.js";

const router = Router();

export const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many submissions. Please try again later.",
  },
});

router.post(
  "/",
  contactLimiter,
  uploadEnquiryAttachment,
  submitEnquiry
);

export default router;
