# Portfolio pieces

Five pieces from the Fleet Booking Sync Dashboard. All screenshots use made-up demo data; company, boat and model names are fictional.

---

## 1. One Calendar for Five Booking Platforms

![Dashboard overview](01-dashboard-overview.png)

Our staff used to block dates by hand on five booking sites so none of our eight boats was sold twice. I designed this dashboard to replace that. I decided which platforms it covers, what counts as a real booking on each one, and how the page is laid out: one fleet calendar, revenue shown as totals that open into details, and each boat's battery voltage. Today the owner and almost all of our staff use it.

- **Tools:** HTML, CSS and JavaScript on Cloudflare Workers; Node.js; headless Chrome for the screenshot.
- **AI use:** Code written by AI coding assistants (OpenAI Codex, Anthropic Claude Code) to my specifications.

---

## 2. Catching Double Bookings

![Overlap view](02-overlap-view.png)

A boat listed on five platforms can be sold twice for the same nights. I made the warning appear in four places: the mascot lists it, a summary sits above the calendar, the nights are outlined in red, and both orders are flagged with links to their platforms. I also set the rule that a turnover day — one guest leaves in the morning, the next arrives that afternoon — is not a conflict, so staff only see real ones.

- **Tools:** HTML, CSS and JavaScript; puppeteer and headless Chrome to capture the close-ups.
- **AI use:** Code written by AI coding assistants to my rules.

---

## 3. How the System Works

![Architecture](03-architecture.png)

I planned the system around one constraint: we have no official API access to any of the booking platforms. I first tried Cloudflare's free cloud browser, but the quota was too tight and every platform needed a separate login there, so I moved the work to a spare Android phone that stays logged in. The phone reads the orders, the cloud works out which dates to block, and the phone blocks them and reads the calendar back to check.

- **Tools:** Mermaid (diagram as code); headless Chrome to export the image.
- **AI use:** Diagram code generated with Claude Code.

---

## 4. Redesign: Before and After

![Before and after the redesign](04-redesign-before-after.png)

Same demo data, before and after my redesign. I chose a paper-notebook look — tape labels, handwritten-style headings, a dotted page — and a mascot next to the Sync button that shows the sync status at a glance. The redesign changes only the look: every color keeps its meaning and no data rule changed. It also fixed a heading that still said "7 boats" after we added our eighth.

- **Tools:** CSS and JavaScript; mascot images from the fantasy-mouse-ui project.
- **AI use:** Code written by Claude Code in the direction I chose. Mascot artwork from fantasy-mouse-ui (not drawn by me or by AI).

---

## 5. A Mascot That Only Tells the Truth

![Mascot states](05-mascot-states.png)

I wanted a mascot that does a job instead of decorating the page. It has three states, all tied to real data: "orders updated" with the time, a working pose only while the phone is actually syncing, and a red "needs your attention" list where every item links to the problem. It never celebrates or says everything is fine — a mascot that hid a failure would be worse than none.

- **Tools:** CSS and JavaScript; mascot images from the fantasy-mouse-ui project.
- **AI use:** Code written by Claude Code to my rules. Mascot artwork from fantasy-mouse-ui (not drawn by me or by AI).
