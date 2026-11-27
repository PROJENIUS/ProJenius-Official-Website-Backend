/* =========================================================
   NEWS & INSIGHTS — FIELD LIMITS
   These posts also feed the home page "Highlights & Updates"
   cards, so the fields shown there are limited to what the
   card can hold without changing size:
     category  → the blue heading "What's Happening in …"
     title     → card heading, at most 3 lines on a phone
     summary   → card text and search-result description
     ctaLabel  → the card button
   Keep in step with the admin form (PublishingManagement).
========================================================= */

export const ARTICLE_LIMITS = Object.freeze({
  title: { label: "Title", max: 70 },
  summary: { label: "Summary", max: 160 },
  category: { label: "Category", max: 20 },
  ctaLabel: { label: "Button text", max: 22 },
  authorName: { label: "Author name", max: 40 },
  authorRole: { label: "Author role", max: 40 },
  seoTitle: { label: "SEO title", max: 60 },
  seoDescription: { label: "SEO description", max: 160 },
});
