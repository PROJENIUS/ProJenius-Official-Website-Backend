/* =========================================================
   HOME HERO — CONTENT RULES
   The single source for every Home Hero limit. The admin
   panel reads these from the API, so its counters, preview
   and the backend checks can never disagree. The limits were
   measured in the browser against the website layout: at these lengths the
   white and blue heading lines each stay on one line on every desktop width
   from 1024 px up, so the hero keeps its height on the first screen.
========================================================= */

export const HERO_RULES = Object.freeze({
  slides: { min: 3, max: 10 },
  text: Object.freeze({
    caption: { label: "Image caption", min: 3, max: 28 },
    eyebrow: { label: "Eyebrow", min: 3, max: 34 },
    title: { label: "Heading (white)", min: 3, max: 25 },
    highlight: { label: "Heading highlight (blue)", min: 3, max: 25 },
    description: { label: "Description", min: 40, max: 150 },
    alt: { label: "Image description (alt text)", min: 10, max: 125 },
    ctaLabel: { label: "Button text", min: 2, max: 22 },
  }),
  image: Object.freeze({
    minWidth: 1600,
    minHeight: 1000,
    minRatio: 1.5,
    maxRatio: 1.8,
    recommended: "1920 × 1200 px (16:10), WebP, under 500 KB",
    formats: Object.freeze(["image/webp"]),
    maxBytes: 5 * 1024 * 1024,
  }),
  linkPattern: "^(\\/(?:[a-z0-9-]+(?:\\/[a-z0-9-]+)*)?\\/?(?:\\?[a-z0-9=&_-]*)?(?:#[a-z0-9-]+)?|#[a-z0-9-]+)$",
  linkMax: 200,
});

/* The five photos shipped with the website. A slide may keep one of these
   instead of an upload; the website and admin map each key to its file. */
export const BUILTIN_HERO_IMAGES = Object.freeze(["hero-slide-1", "hero-slide-2", "hero-slide-3", "hero-slide-4", "hero-slide-5"]);

/* Fallback for the admin "Opens" list, used only when the website's
   /site-links.json cannot be read (see siteLinks.service.js). Any other path
   on this website is also accepted. */
export const HERO_LINK_SUGGESTIONS = Object.freeze([
  { label: "Home · Services section", to: "#home-services" },
  { label: "Home · Training section", to: "#home-training" },
  { label: "Home · Highlights & Updates", to: "#home-updates" },
  { label: "Home · Products section", to: "#home-products" },
  { label: "Home · Projects section", to: "#home-projects" },
  { label: "Home · Achievements section", to: "#home-achievements" },
  { label: "About Us", to: "/about" },
  { label: "Software Development", to: "/services/development" },
  { label: "Hardware & Embedded Systems", to: "/services/hardware-embedded-systems" },
  { label: "PCB Design & Fabrication", to: "/services/pcb-design-fabrication" },
  { label: "Rapid Prototyping", to: "/services/rapid-prototyping" },
  { label: "Courses", to: "/services/courses#course-catalog" },
  { label: "Internships", to: "/services/internship#internship-domains" },
  { label: "Workshops", to: "/workshop" },
  { label: "Career Guidance", to: "/services/career-guidance" },
  { label: "Startup & Innovation", to: "/startup" },
  { label: "Incubation", to: "/incubate" },
  { label: "Products", to: "/products" },
  { label: "News & Insights", to: "/news-insights" },
  { label: "Join Our Team", to: "/join-our-team" },
  { label: "Contact · General", to: "/contact?type=general#pj-contact-help" },
  { label: "Contact · Partnership", to: "/contact?type=partnership#pj-contact-help" },
]);
