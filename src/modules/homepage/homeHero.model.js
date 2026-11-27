import mongoose from "mongoose";
import { BUILTIN_HERO_IMAGES, HERO_RULES } from "./homeHero.rules.js";

const text = (name) => ({ type: String, required: true, trim: true, maxlength: HERO_RULES.text[name].max });

const ctaSchema = new mongoose.Schema({
  label: text("ctaLabel"),
  to: { type: String, required: true, trim: true, maxlength: HERO_RULES.linkMax },
}, { _id: false, strict: "throw" });

const imageSchema = new mongoose.Schema({
  source: { type: String, enum: ["builtin", "upload"], required: true },
  builtinKey: { type: String, enum: [...BUILTIN_HERO_IMAGES, null], default: null },
  mediaId: { type: mongoose.Schema.Types.ObjectId, default: null },
  mimeType: { type: String, enum: ["image/png", "image/jpeg", "image/webp", null], default: null },
  size: { type: Number, max: HERO_RULES.image.maxBytes, default: null },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
}, { _id: false, strict: "throw" });

const slideSchema = new mongoose.Schema({
  key: { type: String, required: true, match: /^[a-z0-9-]{1,40}$/ },
  isVisible: { type: Boolean, default: true },
  caption: text("caption"),
  eyebrow: text("eyebrow"),
  title: text("title"),
  highlight: text("highlight"),
  description: text("description"),
  image: { type: imageSchema, required: true },
  alt: text("alt"),
  primary: { type: ctaSchema, required: true },
  secondary: { type: ctaSchema, required: true },
}, { _id: false, strict: "throw" });

const homeHeroSchema = new mongoose.Schema({
  key: { type: String, required: true, enum: ["home-hero"], default: "home-hero" },
  slides: { type: [slideSchema], required: true },
  revision: { type: Number, required: true, min: 1, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
}, { timestamps: true, strict: "throw", collection: "website_home_hero" });

homeHeroSchema.index({ key: 1 }, { unique: true });
homeHeroSchema.index({ "slides.image.mediaId": 1 }, { name: "home_hero_media" });

export default mongoose.models.HomeHero || mongoose.model("HomeHero", homeHeroSchema);
