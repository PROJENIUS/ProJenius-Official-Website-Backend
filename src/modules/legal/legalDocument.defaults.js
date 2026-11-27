/* =========================================================
   LEGAL DOCUMENTS — BUILT-IN TEXT
   Shown on the website until an admin saves the document in
   Admin → Legal pages (then the saved version is shown, with
   its own last-updated date and time). Written for an Indian
   private limited company under the Information Technology
   Act, 2000, the Digital Personal Data Protection Act, 2023,
   the Consumer Protection Act, 2019 and the Consumer
   Protection (E-Commerce) Rules, 2020. Have a qualified
   lawyer review before relying on it.

   effectiveAt: the date this built-in text took effect.
========================================================= */

const COMPANY = "ProJenius Innovation Technology Private Limited";
const ADDRESS = "Plot No 3, Erikarai Street, Velmurugan Nagar, Namachivaya Nagar, Madurai, Tamil Nadu 625003, India";
const CONTACT = "teamprojenius@gmail.com or +91 89254 50473";

export const LEGAL_DEFAULTS_EFFECTIVE_AT = "2026-11-27T10:00:00+05:30";

export const LEGAL_DOCUMENT_DEFAULTS = Object.freeze({
  terms: {
    key: "terms",
    title: "Terms & Conditions",
    effectiveAt: LEGAL_DEFAULTS_EFFECTIVE_AT,
    introduction: `These Terms & Conditions ("Terms") govern your use of the ProJenius website and the services we offer. "ProJenius", "we" and "us" mean ${COMPANY}, ${ADDRESS}. By using the website or registering for a service you agree to these Terms. If you do not agree, please do not use the website.`,
    sections: [
      {
        heading: "Our services",
        body: "ProJenius provides technology services (software, web and mobile applications, IoT and embedded systems, PCB design and fabrication through manufacturing partners, rapid prototyping and 3D printing), product development, startup and incubation support, and learning programmes (courses, workshops, internships and career guidance).\n\nThe details shown for a programme or agreed in a written proposal, quotation or agreement (scope, schedule, price and deliverables) apply to that service. If they differ from these Terms, the specific written agreement prevails for that service.",
      },
      {
        heading: "Using the website",
        body: "You may use the website for lawful, personal or business purposes. You must not: attempt to gain unauthorised access to the website, its servers or admin areas; upload malicious code or files; scrape or copy content in bulk; submit false information or impersonate anyone; or use the website in a way that breaks any law.\n\nWe may suspend access or remove content that breaks these Terms.",
      },
      {
        heading: "Accounts, forms and accurate information",
        body: "When you submit an enquiry, application, registration or booking, you confirm that the information is accurate and that you are allowed to share it. Uploaded files (such as resumes and documents) must be your own or shared with permission, and free of malware.\n\nSubmitting a form or application does not by itself confirm a place, a selection, an engagement or a booking. We confirm these separately.",
      },
      {
        heading: "Registration, fees and payment",
        body: "Prices are shown in Indian Rupees (INR) and include applicable taxes unless stated otherwise. The amount payable is shown before you pay. Payments are processed by our payment partner, Razorpay; we do not see or store your card, UPI or bank details.\n\nA paid registration is confirmed after the payment is successful and verified. A receipt is sent to the email address you provide. Refunds for live training are covered by the Live Training Refund Policy; for project work, by the written proposal or agreement.",
      },
      {
        heading: "Programme delivery and conduct",
        body: "Programmes may be delivered online, in person or both, as described for each programme. We may change a trainer, venue or session time for operational reasons and will inform registered participants in advance.\n\nParticipants must follow programme rules, respect other participants and staff, and not record sessions or share programme material without permission. We may remove a participant for serious misconduct; any refund in that case is at our discretion.",
      },
      {
        heading: "Certificates and outcomes",
        body: "Certificates are issued only where stated for a programme and when its completion requirements are met. Unless a written agreement says so, we do not guarantee employment, placement, funding, investment, grants, patent approval, commercial success or a particular technical result.",
      },
      {
        heading: "Intellectual property",
        body: "The website, its design, text, images, logos, software, course material and the ProJenius name and marks belong to ProJenius or its licensors and are protected by law. You may not copy, reproduce or distribute them without our written permission.\n\nOwnership of work created for a client or during a programme is set by the written proposal or agreement for that work. If none applies, each party keeps the rights it brought, and ProJenius keeps its pre-existing tools, code libraries and know-how.",
      },
      {
        heading: "Confidentiality",
        body: "Both parties will keep confidential any non-public information shared for a project, such as business plans, source code, designs and documents, and use it only for that project. This does not apply to information that is public, already known or required to be disclosed by law.",
      },
      {
        heading: "Third-party services and links",
        body: "The website uses or links to third-party services such as Razorpay (payments), Google Maps, YouTube, Google Analytics (only with your consent) and WhatsApp. These services have their own terms and privacy policies, and we are not responsible for their content or practices.",
      },
      {
        heading: "Limitation of liability",
        body: "The website is provided on an \"as is\" and \"as available\" basis. We try to keep information accurate and the website available, but we do not promise that it will always be error-free or uninterrupted.\n\nTo the extent permitted by law, ProJenius is not liable for indirect, incidental or consequential loss, or for loss of profit, data or business opportunity. Our total liability for any claim relating to a paid service is limited to the amount you paid for that service. Nothing in these Terms limits liability that cannot be limited under Indian law, including your rights under the Consumer Protection Act, 2019.",
      },
      {
        heading: "Indemnity",
        body: "You agree to compensate ProJenius for losses caused by your breach of these Terms, your misuse of the website, or content you submit that infringes another person's rights.",
      },
      {
        heading: "Changes to these Terms",
        body: "We may update these Terms to reflect changes in our services or the law. The current version and its last-updated date and time are shown on this page. Changes apply from that date and do not affect a registration or agreement already confirmed.",
      },
      {
        heading: "Governing law and disputes",
        body: "These Terms are governed by the laws of India. We encourage you to contact us first so we can try to resolve any concern quickly. Subject to your rights under consumer protection law to approach a consumer commission, the courts at Madurai, Tamil Nadu have exclusive jurisdiction.",
      },
      {
        heading: "Grievance Officer and contact",
        body: `In line with the Information Technology Act, 2000 and the Consumer Protection (E-Commerce) Rules, 2020, complaints can be sent to our Grievance Officer at ${CONTACT}, or by post to ${COMPANY}, ${ADDRESS}. We acknowledge a complaint within 48 hours and aim to resolve it within one month.\n\nPlease also read our Privacy Policy, Cookie Policy and, for live training, the Live Training Refund Policy.`,
      },
    ],
  },

  "privacy-policy": {
    key: "privacy-policy",
    title: "Privacy Policy",
    effectiveAt: LEGAL_DEFAULTS_EFFECTIVE_AT,
    introduction: `This Privacy Policy explains how ${COMPANY} ("ProJenius", "we") collects, uses, shares and protects your personal data when you use our website and services, and the rights you have. We process personal data in line with the Digital Personal Data Protection Act, 2023 (DPDP Act), the Information Technology Act, 2000 and the rules made under them. For this purpose ProJenius is the Data Fiduciary.`,
    sections: [
      {
        heading: "Personal data we collect",
        body: "Only what you give us or what is needed to provide the service:\n\n• Contact details: name, email address, phone number, city and organisation, when you send an enquiry or contact us.\n• Registration and booking details: the course, workshop, internship or career guidance session you choose, your year of study or experience, and payment status and transaction reference.\n• Job and internship applications: your resume and the details you enter, such as skills, experience and portfolio links.\n• Newsletter: your email address and the date you gave consent.\n• Technical data: basic data your browser sends (such as device type and pages visited) for security, and analytics data only if you accept analytics cookies.\n\nWe never receive or store your card, UPI or bank details; these are handled by Razorpay.",
      },
      {
        heading: "Why we use it",
        body: "We use personal data to: reply to your enquiry; process registrations, bookings and payments and send receipts; deliver and support programmes; review job and internship applications; send the newsletter if you subscribed; keep the website secure and prevent misuse; improve the website using analytics if you allowed it; and meet legal, tax and accounting obligations.\n\nWe do not sell your personal data and do not use it for automated decisions that significantly affect you.",
      },
      {
        heading: "Legal basis and consent",
        body: "We process personal data with your consent, which you give when you submit a form, register, apply or subscribe, and for legitimate uses permitted by the DPDP Act, such as completing a service you asked for or meeting a legal requirement. You can withdraw consent at any time (see \"Your rights\"); this does not affect processing already done.",
      },
      {
        heading: "Who we share it with",
        body: "Only with people and services that need it to deliver what you asked for, under confidentiality obligations:\n\n• Razorpay, to process payments.\n• Our email service, to send confirmations, receipts and newsletters.\n• Our hosting and database providers (website hosting and cloud database), which store data on our behalf.\n• Google Analytics, only if you accepted analytics cookies.\n• Trainers, mentors and partner institutions, only the details needed to run a programme you joined.\n• Government or law-enforcement authorities, when the law requires it.",
      },
      {
        heading: "Where and how long we keep it",
        body: "Data is stored with reputable cloud providers and may be stored on servers outside India, with safeguards required by Indian law.\n\nWe keep personal data only as long as needed for the purpose it was collected: enquiries for up to 2 years after the last contact; job applications for up to 1 year after the hiring decision, unless you ask us to keep them longer; newsletter data until you unsubscribe; and payment and invoice records for the period required by tax and accounting laws. After that we delete or anonymise it.",
      },
      {
        heading: "Security",
        body: "We use reasonable security practices as required under the Information Technology (Reasonable Security Practices and Procedures and Sensitive Personal Data or Information) Rules, 2011, including encrypted connections (HTTPS), restricted staff access with individual accounts, protected admin sign-in, and checks on uploaded files. No system is completely secure; if a personal data breach occurs, we will inform affected people and the Data Protection Board of India as the law requires.",
      },
      {
        heading: "Your rights",
        body: "Under the DPDP Act you can ask us to: tell you what personal data we hold about you and how it is used; correct, complete or update it; erase it when it is no longer needed (unless the law requires us to keep it); withdraw consent; and nominate another person to exercise your rights in case of death or incapacity.\n\nTo make a request, email teamprojenius@gmail.com from the email address you used with us. We may need to verify your identity. We respond within the time required by law. If you are not satisfied with our response, you may complain to the Data Protection Board of India.",
      },
      {
        heading: "Children",
        body: "Some programmes are open to school students. For anyone under 18, we process personal data only with verifiable consent from a parent or lawful guardian, and we do not track children or show them targeted advertising.",
      },
      {
        heading: "Photos, videos and testimonials",
        body: "We may take photos or videos at workshops and events. We publish identifiable photos, videos or testimonials only with permission. To ask us to remove one, email teamprojenius@gmail.com with a link to it.",
      },
      {
        heading: "Cookies",
        body: "We use only essential browser storage by default. Analytics cookies are set only if you accept them. See the Cookie Policy for details and to change your choice.",
      },
      {
        heading: "Changes to this policy",
        body: "We may update this policy when our services or the law change. The current version and its last-updated date and time are shown on this page. Where a change needs fresh consent, we will ask for it.",
      },
      {
        heading: "Grievance Officer and contact",
        body: `For questions, requests or complaints about your personal data, contact our Grievance Officer at ${CONTACT}, or write to ${COMPANY}, ${ADDRESS}. We acknowledge a complaint within 48 hours and aim to resolve it within one month.`,
      },
    ],
  },

  "cookie-policy": {
    key: "cookie-policy",
    title: "Cookie Policy",
    effectiveAt: LEGAL_DEFAULTS_EFFECTIVE_AT,
    introduction: "This Cookie Policy explains what cookies and similar browser storage the ProJenius website uses, why, and how you can control them. By default we use only what is essential for the website to work; anything else is used only with your consent.",
    sections: [
      {
        heading: "What cookies are",
        body: "Cookies and similar browser storage (such as local storage) are small pieces of information a website saves in your browser. They let a site remember choices, keep pages secure and, with consent, measure how pages are used.",
      },
      {
        heading: "Essential storage (always on)",
        body: "• pj-cookie-consent: remembers your cookie choice so we do not ask on every page. It contains only \"essential\" or \"analytics\".\n• Content cache: remembers the latest home page and page hero content so pages appear faster on your next visit. It holds only public website content.\n\nThe public website does not use cookies to sign you in. The ProJenius admin panel, used only by our staff on its own address, uses a secure sign-in cookie.",
      },
      {
        heading: "Analytics (only with your consent)",
        body: "If you select \"Accept analytics\", we load Google Analytics to understand which pages are useful. It may set cookies such as _ga and _ga_<id>, kept for up to 2 years. We use it only to improve the website, never for advertising. If you choose \"Essential only\", Google Analytics is not loaded.",
      },
      {
        heading: "Third-party services on some pages",
        body: "• Payments: course and career guidance payments open Razorpay's secure checkout, which may use cookies to process the payment and prevent fraud.\n• Maps: the office map on the Contact page and in the footer is a drawing; it opens Google Maps only when you click it, and Google may then set its own cookies.\n• Videos: videos are embedded from YouTube in privacy-enhanced mode (youtube-nocookie.com); YouTube may store information when you play a video.\n• Fonts: fonts load from Google Fonts, which does not set cookies.\n\nEach of these services follows its own privacy and cookie policy.",
      },
      {
        heading: "Changing your choice",
        body: "You can change your choice at any time with the \"Cookie settings\" button on this page or the \"Cookie settings\" link in the website footer. You can also delete cookies and site data in your browser settings; the website will then ask for your choice again.",
      },
      {
        heading: "Changes and contact",
        body: `We update this policy when the cookies we use change. The current version and its last-updated date and time are shown on this page. Questions: ${CONTACT}, ${COMPANY}, ${ADDRESS}.`,
      },
    ],
  },

  "course-terms": {
    key: "course-terms",
    title: "Live Training Refund Policy",
    effectiveAt: LEGAL_DEFAULTS_EFFECTIVE_AT,
    introduction: "This policy applies to paid live training from ProJenius: courses, workshops and career guidance sessions delivered online or in person. Please read it with the course details before paying. By completing payment you agree to it.",
    sections: [
      {
        heading: "Before you register",
        body: "Check the course title, syllabus, delivery mode (online or in person), batch dates and timings, duration, eligibility and fee shown on the course page. If anything is unclear, contact us before paying.",
      },
      {
        heading: "Registration and confirmation",
        body: "Your seat is confirmed once your payment is successful and verified. You receive a confirmation and a payment receipt by email. Class joining details are shared before the batch starts. Seats in each batch are limited and confirmed in order of successful payment.",
      },
      {
        heading: "Fees and payment",
        body: "Fees are shown in Indian Rupees (INR) and include applicable taxes unless stated otherwise. Payment is made through Razorpay. A payment is not complete until Razorpay confirms it; if money is deducted but the registration is not confirmed, see \"Failed and duplicate payments\" below.",
      },
      {
        heading: "Cancellation by you",
        body: "Because seats are reserved and planned for each batch, fees are not refundable if you cancel after payment, do not attend, or change your plans.\n\nYou may request a one-time transfer to a later batch of the same course by emailing us at least 48 hours before your batch starts. Transfers depend on seat availability and our written approval.",
      },
      {
        heading: "Cancellation or changes by ProJenius",
        body: "If ProJenius cancels a batch, or cannot provide the course you paid for, you can choose a full refund or a transfer to another batch. If we reschedule a batch, you can join the new dates or ask for a full refund if the new dates do not suit you.",
      },
      {
        heading: "Failed and duplicate payments",
        body: "If you were charged but your registration was not confirmed, or you were charged more than once for the same registration, email us with the payment reference. After we verify it with Razorpay, the extra or failed amount is refunded in full.",
      },
      {
        heading: "How refunds are paid",
        body: "Approved refunds are made to the original payment method through Razorpay, normally within 7 working days of approval. Your bank or card issuer may take a few more days to show the credit.",
      },
      {
        heading: "Attendance, recordings and certificates",
        body: "Live sessions are not recorded for participants unless the course page says so. Certificates are issued only for courses that offer them and only when the completion requirements (such as attendance and project submission) are met.",
      },
      {
        heading: "How to request a transfer or refund",
        body: "Email teamprojenius@gmail.com with your name, registered email, course name, batch and payment reference. We acknowledge your request within 48 hours and reply with a decision within 7 working days.",
      },
      {
        heading: "Your rights and contact",
        body: `This policy does not affect your rights under the Consumer Protection Act, 2019 or a decision by your bank or payment provider. For any complaint, contact our Grievance Officer at ${CONTACT}, or write to ${COMPANY}, ${ADDRESS}.`,
      },
    ],
  },
});
