/* =========================================================
   JOB OPENINGS — FIELD RULES
   The single source for the admin form and the backend checks
   (the admin panel reads these from the API). Shaped after
   common careers pages: a searchable list of roles, each with
   its own page (summary, responsibilities, requirements,
   benefits) and an application form.
========================================================= */

export const JOB_OPENING_RULES = Object.freeze({
  text: Object.freeze({
    title: { label: "Job title", min: 3, max: 70 },
    department: { label: "Team", min: 2, max: 40 },
    location: { label: "Location", min: 2, max: 60 },
    experience: { label: "Experience", min: 2, max: 40 },
    salary: { label: "Salary (optional)", min: 0, max: 40 },
    summary: { label: "Short summary", min: 40, max: 300 },
  }),
  lists: Object.freeze({
    responsibilities: { label: "What you will do", min: 3, max: 10, itemMax: 180 },
    requirements: { label: "What we look for", min: 3, max: 10, itemMax: 180 },
    niceToHave: { label: "Good to have (optional)", min: 0, max: 8, itemMax: 180 },
    benefits: { label: "What you get (optional)", min: 0, max: 8, itemMax: 140 },
    skills: { label: "Skills tags", min: 0, max: 12, itemMax: 30 },
  }),
  employmentTypes: Object.freeze(["Full-time", "Part-time", "Internship", "Contract"]),
  workModes: Object.freeze(["On-site", "Hybrid", "Remote"]),
  statuses: Object.freeze(["draft", "open", "closed"]),
  positions: { min: 1, max: 50 },
  departments: Object.freeze(["Software", "Hardware & IoT", "Training & Learning", "Design", "Operations", "Sales & Marketing"]),
});
