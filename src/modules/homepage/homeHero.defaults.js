/* =========================================================
   HOME HERO — STARTING CONTENT
   Shown in the admin editor until the first save, and kept
   word-for-word in step with the website's built-in fallback
   (ProJenius-Official-Website-Frontend/src/Components/Home/
   HomeHero/heroSlides.js).
========================================================= */

export const HOME_HERO_DEFAULT_SLIDES = Object.freeze([
  {
    key: "company",
    isVisible: true,
    caption: "Company Introduction",
    eyebrow: "Technology Company in Madurai",
    title: "Ideas Into Innovation.",
    highlight: "Innovation Into Impact.",
    description: "Software development, IoT and embedded systems, and product engineering for businesses, startups and institutions across India.",
    image: { source: "builtin", builtinKey: "hero-slide-1" },
    alt: "Developer workstation with code on two monitors",
    primary: { label: "Explore Services", to: "#home-services" },
    secondary: { label: "Talk to Us", to: "/contact?type=general#pj-contact-help" },
  },
  {
    key: "partners",
    isVisible: true,
    caption: "Startups & Institutions",
    eyebrow: "Technology Partner",
    title: "Technology Solutions for",
    highlight: "Startups & Institutions",
    description: "From MVP development to IoT products and custom software, we turn ideas into scalable technology that works in the real world.",
    image: { source: "builtin", builtinKey: "hero-slide-2" },
    alt: "Speakers on stage at the CII Connect Madurai AI event",
    primary: { label: "Explore Solutions", to: "/services/development" },
    secondary: { label: "Start a Conversation", to: "/contact?type=partnership#pj-contact-help" },
  },
  {
    key: "learning",
    isVisible: true,
    caption: "Learning & Development",
    eyebrow: "Courses · Internships · Workshops",
    title: "Build Skills Through",
    highlight: "Real-World Technology",
    description: "Industry-oriented courses, internships and hands-on workshops in AI, IoT, embedded systems and full-stack development.",
    image: { source: "builtin", builtinKey: "hero-slide-3" },
    alt: "Students working together on a hardware prototype in a lab",
    primary: { label: "Explore Courses", to: "/services/courses#course-catalog" },
    secondary: { label: "Discover Internships", to: "/services/internship#internship-domains" },
  },
  {
    key: "projects",
    isVisible: true,
    caption: "Projects & Innovation",
    eyebrow: "Engineering Real-World Solutions",
    title: "From Real-World Problems",
    highlight: "to Working Products",
    description: "See the IoT, AI and embedded prototypes we design, build and test to solve practical problems for industry and society.",
    image: { source: "builtin", builtinKey: "hero-slide-4" },
    alt: "Hand holding a phone surrounded by connected IoT device icons",
    primary: { label: "Explore Projects", to: "#home-projects" },
    secondary: { label: "Work With Us", to: "/contact?type=general#pj-contact-help" },
  },
  {
    key: "opportunities",
    isVisible: true,
    caption: "Learning Opportunities",
    eyebrow: "Your Next Opportunity",
    title: "Your Next Learning",
    highlight: "Opportunity Starts Here",
    description: "Explore upcoming technical courses, career guidance and hands-on programs for students and working professionals.",
    image: { source: "builtin", builtinKey: "hero-slide-5" },
    alt: "Students and mentors on stage at a science and innovation recognition event",
    primary: { label: "View Courses", to: "/services/courses#course-catalog" },
    secondary: { label: "Explore Learning", to: "#home-training" },
  },
]);
