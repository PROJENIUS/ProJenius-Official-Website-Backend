# ProJenius administrator permission matrix

Super Admin bypasses module permission checks and is the only role allowed to list, invite, resend invitations, edit permissions, reset another administrator's password, deactivate/reactivate, remove, or inspect the administrator audit log.

New invited Admin accounts receive these explicit permissions by default; the inviter can select a narrower set:

| Module/action | Permission key | Default for new Admin |
| --- | --- | --- |
| Dashboard totals | `dashboard:view` | Yes |
| Enquiries list/search/filter | `enquiries:list` | Yes |
| Enquiry details | `enquiries:details` | Yes |
| Change enquiry status | `enquiries:changeStatus` | Yes |
| Download enquiry receipt/attachment | `enquiries:download` | Yes |
| Career application list/search/filter | `careerApplications:list` | Yes |
| Career application details | `careerApplications:details` | Yes |
| Change career application status | `careerApplications:changeStatus` | Yes |
| Download career receipt/resume | `careerApplications:download` | Yes |
| Administrator management | Super Admin role only | No |

The documented invitation baseline is exactly the nine `Yes` entries above. A Super Admin can remove any of them before sending an invitation. Invitation acceptance copies the selected list to the new `admin` account; it does not assign the Super Admin role.

## Module availability and action scope

| Module | Admin permission choices | Current status |
| --- | --- | --- |
| Dashboard | View totals | Implemented and guarded |
| Enquiries | List/search, details, status change, receipt/attachment download | Implemented and guarded |
| Career Applications | List/search, details, status change, receipt/resume download | Implemented and guarded |
| Administrator Management | Account/invitation/permission management | Super Admin role only; cannot be granted to a regular Admin |
| Courses | List, details, create, edit, status, delete | Unavailable placeholder; disabled in selector and has no permission keys or Admin API |
| Registrations | List, details, create, edit, status, delete | Unavailable placeholder; disabled in selector and has no permission keys or Admin API |
| Blog | List, details, create, edit, publish/unpublish, delete | Unavailable placeholder; disabled in selector and has no permission keys or Admin API |
| Media Library | List, upload, edit, download, delete | Unavailable placeholder; disabled in selector and has no permission keys or Admin API |

The selector displays the future-module action names as disabled informational controls. The backend permission allowlist does not contain those actions, so submitting fabricated future-module keys is rejected. Enquiry and career create operations are public submission flows, not regular-Admin actions; no Admin create/edit/delete permission is exposed where the application has no corresponding protected operation.

Existing regular accounts without a stored permissions field retain their prior contact-operation access for compatibility. Explicitly stored permission arrays are enforced as-is. Permission updates are loaded from MongoDB on every authenticated request, so they take effect on the next request. Courses, registrations, blog, and media currently have placeholder UI only and are not included as working permissions or backend modules.

Administrator removal is a soft removal: it deactivates access, increments the session version, and retains the account and audit history. Account setup and password recovery use single-use expiring tokens; only hashes are stored. Audit metadata is limited to safe action details and never includes tokens, passwords, or password hashes.
