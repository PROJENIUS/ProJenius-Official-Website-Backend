/* =========================================================
   PAGE HEROES — WHAT EACH PAGE'S HERO CAN CHANGE
   The single source for the admin form and the backend checks.
   Each website hero keeps its own built-in content; a saved
   page here replaces it field by field (see the website's
   src/pageHeroes/usePageHero.js).

   Not editable on purpose (fixed design, no photos to swap):
   Hardware & Embedded Systems, Rapid Prototyping, Startup &
   Innovation, Internships and Contact. Home has its own
   editor (Home Hero).

   Image sizes are about twice the largest size shown, measured
   in the browser at 1440 px and 390 px wide.
========================================================= */

const text = (name, label, min, max, extra = {}) => ({ name, type: "text", label, min, max, ...extra });
const phrases = (name, label, max, count = { min: 1, max: 3 }) => ({ name, type: "phrases", label, max, count, help: "Typed one after another in blue." });
const cta = (name, label) => ({ name, type: "cta", label });
const image = (name, label, spec) => ({ name, type: "image", label, ...spec });

const IMAGE = Object.freeze({
  card: { minWidth: 800, minHeight: 680, minRatio: 1, maxRatio: 1.6, recommended: "1200 × 1000 px (6:5)", shown: "Centre card 315 × 273, side cards 233 × 218 and 158 × 152; phone 256 × 216" },
  backdrop: { minWidth: 1600, minHeight: 1000, minRatio: 1.5, maxRatio: 1.8, recommended: "1920 × 1200 px (16:10)", shown: "Full-screen background behind a dark overlay" },
  screen: { minWidth: 920, minHeight: 575, minRatio: 1.2, maxRatio: 1.8, recommended: "1200 × 750 px (16:10) screenshot", shown: "Main window 460 × 287, side window 285 × 242" },
  bench: { minWidth: 1080, minHeight: 900, minRatio: 1.1, maxRatio: 1.5, recommended: "1200 × 1000 px (6:5)", shown: "539 × 479 on desktop, 362 × 250 on phones" },
  tall: { minWidth: 700, minHeight: 950, minRatio: 0.6, maxRatio: 0.85, recommended: "900 × 1200 px (3:4, portrait)", shown: "Tall photo 338 × 458 on desktop, 192 × 298 on phones" },
  square: { minWidth: 520, minHeight: 460, minRatio: 0.9, maxRatio: 1.35, recommended: "800 × 800 px (1:1)", shown: "250 × 222 on desktop, 142 × 142 on phones" },
});

const alt = (name = "alt") => text(name, "Image description (alt text)", 10, 125, { help: "Describe the photo for Google and screen readers." });

const cinematicCards = {
  name: "cards",
  type: "list",
  label: "Photo cards",
  count: { min: 5, max: 5 },
  help: "Five photos in the curved gallery. The first one is in the centre when the page opens.",
  item: [image("image", "Photo", IMAGE.card), alt(), text("category", "Small label", 3, 24), text("title", "Card title", 3, 32)],
};

const cinematic = [
  text("eyebrow", "Eyebrow", 0, 30, { help: "Small label above the heading. Leave empty to hide it." }),
  text("title", "Heading (white)", 3, 26),
  phrases("accent", "Heading highlight (blue)", 22),
  text("description", "Description", 40, 170, { multiline: true }),
  cta("primary", "Main button"),
  cta("secondary", "Second button"),
  cinematicCards,
];

const navyCopy = (titleMax, phraseMax) => [
  text("eyebrow", "Eyebrow", 3, 30),
  text("title", "Heading (white)", 3, titleMax),
  phrases("phrases", "Heading highlight (blue)", phraseMax),
  text("lead", "Description", 40, 170, { multiline: true }),
];

const threePhotos = [
  image("photo1", "Large photo (portrait)", IMAGE.tall), alt("photo1Alt"),
  image("photo2", "Small photo 1", IMAGE.square), alt("photo2Alt"),
  image("photo3", "Small photo 2", IMAGE.square), alt("photo3Alt"),
];

export const PAGE_HERO_SCHEMAS = Object.freeze([
  { key: "about", label: "About Us", path: "/about", fields: cinematic },
  {
    key: "software-development",
    label: "Software Development",
    path: "/services/development",
    fields: [
      text("eyebrow", "Eyebrow", 3, 30),
      text("title", "Heading (white)", 3, 26),
      phrases("phrases", "Heading highlight (blue)", 24),
      text("description", "Description", 40, 180, { multiline: true }),
      cta("primary", "Main button"),
      cta("secondary", "Second button"),
      image("backdrop", "Background photo", IMAGE.backdrop),
      image("screen1", "Main app screenshot", IMAGE.screen), alt("screen1Alt"),
      image("screen2", "Second app screenshot", IMAGE.screen), alt("screen2Alt"),
    ],
  },
  {
    key: "pcb-design-fabrication",
    label: "PCB Design & Fabrication",
    path: "/services/pcb-design-fabrication",
    fields: [
      text("kicker", "Eyebrow", 3, 44),
      text("title", "Heading (white)", 3, 24),
      phrases("typed", "Heading highlight (blue)", 20),
      text("description", "Description", 40, 180, { multiline: true }),
      cta("primary", "Main button"),
      cta("secondary", "Second button"),
      { name: "tags", type: "phrases", label: "Tags under the buttons", max: 20, count: { min: 3, max: 3 } },
      image("photo", "Photo", IMAGE.bench), alt("photoAlt"),
      text("badgeKicker", "Photo badge · small line", 3, 34),
      text("badgeTitle", "Photo badge · title", 3, 34),
      { name: "steps", type: "list", label: "Stages along the bottom", count: { min: 4, max: 4 }, item: [text("label", "Stage", 3, 14), text("text", "Line", 3, 28)] },
    ],
  },
  {
    key: "courses",
    label: "Courses",
    path: "/services/courses",
    fields: [
      ...navyCopy(26, 22),
      ...threePhotos,
      { name: "steps", type: "list", label: "How learning works (4 steps)", count: { min: 4, max: 4 }, item: [text("title", "Step", 3, 22), text("text", "Line", 3, 40)] },
    ],
  },
  {
    key: "career-guidance",
    label: "Career Guidance",
    path: "/services/career-guidance",
    fields: [
      ...navyCopy(26, 24),
      text("primaryLabel", "Main button text (opens the booking form)", 3, 26),
      { name: "facts", type: "phrases", label: "Three short facts", max: 28, count: { min: 3, max: 3 } },
    ],
  },
  {
    key: "workshops",
    label: "Workshops",
    path: "/workshop",
    fields: [
      ...navyCopy(26, 24),
      cta("primary", "Main button"),
      ...threePhotos,
      { name: "floats", type: "list", label: "Floating cards on the photos", count: { min: 3, max: 3 }, item: [text("title", "Title", 3, 24), text("text", "Line", 3, 34)] },
    ],
  },
  {
    key: "products",
    label: "Products",
    path: "/products",
    fields: [
      ...navyCopy(26, 24),
      text("primaryLabel", "Main button text (scrolls to the products)", 3, 24),
      text("secondaryLabel", "Second button text (scrolls to “build your own”)", 3, 26),
      { name: "facts", type: "phrases", label: "Three short facts", max: 22, count: { min: 3, max: 3 } },
    ],
  },
  {
    key: "news-insights",
    label: "News & Insights",
    path: "/news-insights",
    fields: [...navyCopy(22, 26)],
  },
  { key: "join-our-team", label: "Join Our Team", path: "/join-our-team", fields: cinematic },
]);

export const PAGE_HERO_KEYS = Object.freeze(PAGE_HERO_SCHEMAS.map((schema) => schema.key));
export const pageHeroSchema = (key) => PAGE_HERO_SCHEMAS.find((schema) => schema.key === key) || null;

export const PAGE_HERO_IMAGE_RULES = Object.freeze({ formats: Object.freeze(["image/webp"]), maxBytes: 5 * 1024 * 1024 });
