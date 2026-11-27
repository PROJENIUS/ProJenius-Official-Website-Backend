import mongoose from "mongoose";
import { PAGE_HERO_KEYS } from "./pageHero.schemas.js";

/* One document per page. `values` is checked field by field against the
   page's schema (pageHero.schemas.js) before every save; `mediaIds` lists
   every uploaded image it uses, so public image access is a simple lookup. */
const pageHeroSchema = new mongoose.Schema({
  key: { type: String, required: true, enum: PAGE_HERO_KEYS },
  values: { type: mongoose.Schema.Types.Mixed, required: true },
  mediaIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  revision: { type: Number, required: true, min: 1, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
}, { timestamps: true, strict: "throw", collection: "website_page_heroes", minimize: false });

pageHeroSchema.index({ key: 1 }, { unique: true });
pageHeroSchema.index({ mediaIds: 1 }, { name: "page_hero_media" });

export default mongoose.models.PageHero || mongoose.model("PageHero", pageHeroSchema);
