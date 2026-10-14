# Fleet Booking Sync Dashboard

A web dashboard plus an always-on Android phone that keep the booking calendars of my family's yacht-charter business in sync across five booking platforms — so a boat booked on one site is blocked on all the others, and everyone sees one calendar.

![Dashboard with demo data](docs/images/dashboard.png)

*Demo data. In this public-facing copy the company, boat and model names are fictional ("Tidewyn Charters", "Tidewyn Discovery 2", "Seacat 40", …), and all customer details, order numbers, account IDs and real prices have been removed or replaced. The interface is in Chinese because that is what our team reads.*

---

## The problem

Our company rents out 8 yachts in Phuket, Thailand. The same boats are listed on five booking platforms: **Boataround, Click&Boat, SamBoat, MMK (Booking Manager) and NauSYS**. Each platform has its own calendar and its own back office.

- **Manual cross-checking.** When a boat was booked on one platform, someone had to log in to the other four and block the same dates by hand. Staff even copied bookings into NauSYS one by one.
- **Missed orders and double bookings.** If one platform was forgotten, the same boat could be sold twice for the same nights, or a paid order could be overlooked.
- **Different rules everywhere.** Each platform has its own idea of a "real" booking (paid, deposit paid, accepted, option, reservation…), its own date format, and its own time zone, while the dashboard works in Beijing time (UTC+8).

## What it does

Everything below is implemented in this repository.

- **One calendar for the whole fleet.** Active orders from all five platforms on one page: 8 boats, 15 months ahead, with each order linked back to its platform.
- **Automatic order collection.** Every 3 hours (or when someone presses *Sync now*), the phone reads the active orders from all five platforms and uploads a complete snapshot.
- **Two-way calendar sync.** When a boat is booked on one platform, the phone blocks the same dates on the other platforms and then *reads the calendar back* to confirm. When an order is cancelled, it reopens only the dates it blocked itself.
- **Safety rules.**
  - A platform that fails to load is never treated as "the order was cancelled".
  - If one source is uncertain, the system still blocks new dates but never reopens any ("close-only").
  - Blocks created by staff by hand are never touched — every program-made block is recorded in a ledger.
- **Overlap warnings.** Two orders on the same boat for the same nights are flagged, with links to both.
- **Manual entries.** Orders from WhatsApp or phone calls, and "unavailable" dates (maintenance, owner use), are entered on the dashboard and synced to the platforms too.
- **Future revenue view.** Expected income from today on, per platform, boat and month. Each platform's own net figure is used, and different currencies are never added together.
- **Battery voltage.** Once a day the phone reads each boat's battery voltage and idle time from the boats' GPS trackers and shows them on the boat's card. Low voltage turns the card yellow.
- **Platform health.** The dashboard shows when each platform last synced successfully and why it failed if it did. Expired logins are restored automatically with the phone's saved passwords (no passwords are stored in this code); bot-protection pages are reported, not bypassed.
- **Status mascot.** A notebook-style interface whose mascot only reports real states: *syncing*, *needs your attention (with links)*, or *orders updated at …*.
- **1,580 automated tests** (`npm test`).

## How it works

![Architecture](docs/architecture.png)

```mermaid
flowchart LR
  P1["<b>5 booking platforms</b><br/>orders<br/><small>Boataround · Click&Boat · SamBoat<br/>MMK · NauSYS</small>"]
  COL["<b>Phone</b><br/>order collectors<br/>every 3 hours"]
  REG[("<b>Cloud</b><br/>order registry")]
  PLAN["<b>Cloud</b><br/>planner: dates each<br/>platform must block"]
  EXE["<b>Phone</b><br/>calendar sync:<br/>block / reopen dates,<br/>then read back"]
  P2["<b>Same 5 platforms</b><br/>calendars"]
  UI["<b>Cloud</b><br/>web dashboard<br/>calendar · overlaps · revenue"]
  STAFF(["Owner & staff"])
  GPS["Boat GPS trackers<br/>(Anzhilian cloud)"]
  VOLT["<b>Phone</b><br/>battery voltage<br/>once a day"]

  P1 -->|"read in the phone's<br/>logged-in browser / app"| COL
  COL -->|"complete snapshot"| REG
  REG --> PLAN
  PLAN -->|"calendar plan"| EXE
  EXE --> P2
  EXE -.->|"verified result"| REG
  REG --> UI
  STAFF --> UI
  GPS --> VOLT
  VOLT -->|"readings"| REG
```

| Part | What it is | Where in the repo |
|---|---|---|
| Dashboard | A Cloudflare Worker with a Durable Object for storage. It serves the web page, keeps the order registry and works out which dates each platform must block. Built from a baseline plus a chain of small patches. | `fleet-order-sync/build.mjs`, `*-patch.cjs`, `worker/`, `reverse-sync/planner.mjs` |
| Phone service | Node.js running in Termux on a spare Android phone. It controls the phone's own Chrome (where the platforms are already logged in) through the DevTools protocol, and reads the official Click&Boat app's screen through Android's accessibility tree (uiautomator). | `fleet-order-sync/phone-server/`, `collectors/`, `reverse-sync/*-adapter.mjs` |
| Phone setup | Services that start at boot and a watchdog that restarts them. | `phone-server-deployment/provision/` |
| Battery voltage | The phone uses root to reuse the tracker app's existing login, then asks the tracker company's server for the daily readings. Read-only. | `fleet-order-sync/phone-server/voltage.mjs` |

We have no official API access to these platforms, so the phone works the way a person would: it opens the same pages and app screens, reads them, and clicks the same buttons. Every change is checked by reading the calendar again afterwards.

## Design decisions & iterations

Each item: **problem → my judgment → result.** Dates are from the project's maintenance records.

1. **A phone instead of a cloud server (Sept 2026)**
   - *Problem:* The first version ran the platform readers in Cloudflare's free cloud browser. The free quota was very tight, and each platform needed a separate login inside the cloud browser.
   - *My judgment:* Use a spare Android phone that is already logged in to every platform and can stay on all day.
   - *Result:* The phone has run the sync around the clock since then; nobody's computer needs to be on.

2. **The login bug (14 Sept 2026)**
   - *Problem:* Boataround stopped syncing, and the program concluded the account was logged out and asked for a new login.
   - *My judgment:* That didn't add up — the phone had the password saved and Boataround was working in its Chrome. I pointed that out.
   - *Result:* The investigation found the service was using a separate browser that had never been logged in. It was switched to the phone's own Chrome, and later every platform got automatic login recovery using the browser's saved passwords.

3. **Not fighting bot protection (28–29 Sept 2026)**
   - *Problem:* Click&Boat's website began showing a "verify you are human" page to the automated browser; even solving it by hand did not help.
   - *My judgment:* Don't try to trick the protection. Use the official Click&Boat Android app instead.
   - *Result:* Orders and calendar changes for Click&Boat now go through the app's screen, the way a person uses it. It is slower (about 35–55 seconds per boat) but stable and within the platform's rules.

4. **Never delete what people made by hand (29 Sept 2026)**
   - *Problem:* An automatic sync could, in principle, remove a block that a staff member created on purpose.
   - *My judgment:* The program may only remove blocks it created itself and recorded in its ledger — staff blocks stay, even if they look wrong.
   - *Result:* Every block has an owner, and a cancellation only reopens the program's own blocks.

5. **One broken platform shouldn't stop everything (29 Sept 2026)**
   - *Problem:* When one platform failed to load, all calendar syncing paused — once for about 6 hours.
   - *My judgment:* Keep protecting new bookings, but never reopen dates while any source is uncertain ("close-only").
   - *Result:* The other platforms kept syncing, and nothing could be reopened by mistake.

6. **Battery voltage on the dashboard (Sept–Oct 2026)**
   - *Problem:* Boats can sit unused for days; a flat battery means a bad start to the next charter. The GPS trackers' app shows the voltage, but nobody checks it every day.
   - *My judgment:* Read it automatically once a day and show it next to each boat, read-only, without storing another password.
   - *Result:* Every boat card shows voltage, idle time and power status. On 10 Oct I noticed that one tracker had readings in the tracker app but none on the dashboard; it turned out to be assigned to the wrong boat, and the mapping was fixed.

7. **An order in my email that wasn't on the dashboard (12 Oct 2026)**
   - *Problem:* I received a NauSYS email about a new booking that the dashboard didn't show.
   - *My judgment:* Check how NauSYS itself lists it before assuming a bug.
   - *Result:* It was a "waiting option" queued behind another agency's option; NauSYS lists it as an enquiry, not a booking, so the dashboard was right. When it became a real option, the system picked it up and blocked the dates.

8. **A cancellation the system didn't recognize (12 Oct 2026)**
   - *Problem:* One boat showed a "please verify reopening" warning, and its dates stayed blocked on four platforms although the agency's option had already expired.
   - *My judgment:* I flagged it with a screenshot.
   - *Result:* It turned out NauSYS rewrites the "created by" column when it auto-cancels an expired option, so the cancellation wasn't recognized. The rule was fixed and the dates were reopened the same day.

9. **A friendlier interface (13 Oct 2026)**
   - *Goal:* Make the dashboard friendlier, and make the sync status visible at a glance instead of in a long line of text.
   - *My judgment:* I chose a notebook-style redesign with a mascot that only reports real states — no "everything is fine!" celebrations.
   - *Result:* The status sits next to the *Sync now* button, and items that need attention are links straight to the problem.

## My role and use of AI

I started this project in May 2026 and still run it. I decide what it must do, set its rules, design how it looks, test it on our real platforms, and keep it running for the business. The owner and almost all of our staff use it.

**What I did**
- **Product and rules.** I defined what the system must do and its business rules: what counts as a real booking on each platform, "close-only" when a source is uncertain, never touching staff-made blocks, and how revenue is counted and shown.
- **Key decisions.** I moved the work from a cloud browser to a phone, chose the official Click&Boat app over fighting bot protection, added MMK and NauSYS as order sources, and added battery voltage.
- **Interface design.** I laid out the dashboard (for example, revenue shows the total first and details on click) and chose the notebook-and-mascot redesign.
- **Testing and debugging.** I approved and checked live tests on real platform calendars, compared results with the platforms, and reported problems with screenshots — several of the iterations above started from something I noticed.
- **Operations.** I set up and look after the phone, and keep the system running for the business.
- **Audit.** On 10 Oct 2026 I had every platform's back office compared order by order with the dashboard: all 40 active orders matched.

**How I used AI:** The code — dashboard, phone service, platform readers, calendar sync, the 1,580 tests and the deployment scripts — was written by AI coding assistants (**OpenAI Codex**, then **Anthropic Claude Code** from late September 2026) from my requirements. I did not write most of the code by hand.

## What I learned / Next steps

**What I learned**
- *"Saved" is not "done."* A request reaching the server is different from the platform actually showing the change. The system only reports success after reading the calendar back.
- *Missing data is not a cancellation.* A page that fails to load says nothing about the order, so the system keeps the last complete data and says so.
- *Rules have to be exact.* An AI assistant follows the rules I write very literally, so vague rules produce wrong behavior. Writing them precisely became a large part of my work.
- *Respect other people's systems.* Using the official app was slower than working around bot protection, but it is the version I can stand behind.

**Next steps**
- Use official platform APIs where they become available, instead of reading pages.
- Connect the remaining boat/platform pairs (one boat is only on NauSYS; a few SamBoat listings are not linked yet).
- Read battery data over an encrypted (HTTPS) connection — when this was built, the trackers' service could only be reached over plain HTTP.
- An English version of the interface.

## Setup (demo data, no real accounts)

Requires [Node.js](https://nodejs.org/) 22 or later (developed on 24.19).

```bash
git clone https://github.com/maiyuge630/fleet-booking-sync-dashboard.git
cd fleet-booking-sync-dashboard/fleet-order-sync
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run demo
```

Then open <http://localhost:8891/?scenario=normal>. Other demo states: `syncing`, `attention`, `offline`, `loading`, `error` (for example `?scenario=attention`). The demo server uses made-up orders and never contacts a booking platform.

Run the tests (after `npm run build`):

```bash
npm test
```

The phone service itself needs a rooted Android phone with Termux and logged-in platform accounts, so it cannot run from this repository alone. `.env.example` lists the settings a real deployment keeps outside the repository; the demo needs none of them. The phone's watchdog test (`phone-server-deployment/provision/fleet-runtime-watchdog.test.mjs`) needs GNU Bash and runs on the phone.

## Repository layout

```
fleet-order-sync/            dashboard build, patches, phone service, platform readers, tests
  build.mjs                  builds the Cloudflare Worker (after/cloudflare.js)
  phone-server/              the service running on the phone
  collectors/                read orders from each platform
  reverse-sync/              calendar sync: planner, executor, one adapter per platform
  worker/                    order registry inside the Worker
  demo/preview-server.cjs    local demo with made-up data
  evidence/ …                anonymized page samples used by the tests
cloudflare-boataround-orders/, cloudflare-migration/   the original dashboard the patches build on
phone-server-deployment/provision/                     phone install scripts and watchdog
docs/                        architecture diagram and screenshots
```

## Credits

Mascot images come from the [fantasy-mouse-ui](https://github.com/LaoFeng-mouse/fantasy-mouse-ui) project.
