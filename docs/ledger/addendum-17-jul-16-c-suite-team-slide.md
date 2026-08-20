---
ledger_split: addendum-17
source: cobot_project_conversation_v46.md
source_lines: 11523-11660 (inclusive)
title: C-suite roles finalized; team slide v5
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 17 — July 16, 2026 session (C-suite roles finalized; team slide v5)

## 296. ROLE RESTRUCTURE — CEO / CTO / COO (supersedes all prior role framing)

Per Josh's directive July 16, formal titles and responsibilities are now:

| Founder | Title | Responsibilities |
|---|---|---|
| **Josh Edhlund** | **CEO** | Fundraising, investor relations, marketing, business strategy |
| **Teddy Simpson** | **CTO** | AI platform and technical product roadmap; Boyceville machining/assembly and hardware-software integration |
| **Patrick Smith** | **COO** | Offshore sourcing — China manufacturing, India engineering & IT; his existing manufacturing customer network serves as a go-to-market sales channel |

**CRITICAL SUPERSESSION:** Josh no longer "leads the AI platform" — that language (locked in §71 and carried into the §142 merged slide) is retired. Teddy's CTO scope now includes the AI platform explicitly, resolving the earlier collision-avoidance blend in §142(c). All future bio copy must reflect CEO/CTO/COO titles.

**Closed-loop narrative reassignment (flagged for Josh review):** with the AI platform moving to Teddy, the card eyebrows shift: THE CUSTOMER → Pat (unchanged), **THE AI LAYER → Teddy** (was Josh), **THE CAPITAL → Josh** (new). Merged-slide sub-line updated to "The customer, the AI layer, and the capital are all co-founders — a closed loop competitors can't copy."

## 297. MERGED TEAM SLIDE — v5 copy (position 10, "WHY US · THE TEAM")

Headline "Operators, not theorists." retained. Card copy as rendered:

*Pat — THE CUSTOMER / Co-Founder · COO:* "Owner/president of Jade Molds — 20+ years operating a Wisconsin injection mold manufacturer. 20 years of competitive China sourcing; 8 years of India IT support operations. Early-stage underwriter." Responsibility line: "Leads offshore sourcing, China manufacturing, and India engineering & IT — and opens his manufacturing customer network as our first sales channel."

*Teddy — THE AI LAYER / Co-Founder · CTO:* "Mechanical engineer. Ex-Tesla production line design. MS Product Development, Karlsruhe Institute of Technology. Deep experience designing and building custom automation systems for production floors." (Josh directive July 16: battery/Powerwall detail removed; custom-automation-systems experience added.) Responsibility line: "Leads the AI platform and the technical product roadmap — from machining and assembly in our Boyceville shop to hardware-software integration."

*Josh — THE CAPITAL / Co-Founder · CEO:* "20+ years spanning manufacturing operations and IT leadership. MS in MIS; DBA in Global Operations. Founder/CEO of MFG Edge AI." Responsibility line: "Leads fundraising, investor relations, marketing, and business strategy — the raise, the brand, the investor story, and the commercial partnerships that turn pilots into customers." (Lengthened per Josh, July 16.)

Footer italic line preserves the three v2 slide-10 supporting claims (floor-validated at Jade Molds; Wisconsin manufacturing at 60–70% margins; brain improves across all segments). Card layout adds a divider-separated responsibility line beneath each bio — a new element vs. v3/v4, giving titles and remits equal visual weight.

## 298. DELIVERABLES + REBUILD LIMITATION

- **team_slide_v5.html + team_slide_v5.pdf** — single-slide render (1456×840, Chromium), delivered standalone.
- **LIMITATION:** the project files contain only the **v2 deck** (page-image bundle) and the v31 KB. `deck_v4.html` and `NeuRobots_Investor_Pitch_Deck_v4.pdf` (§145) were produced in a prior session but never uploaded to project files. Rebuilding a full v5 deck from v2 page images would silently regress the v3/v4 changes (pillar 04 swap, subscription reframe, screenshots slide). **Action for Josh: upload deck_v4.html (preferred) or the v4 PDF to project files**; the v5 slide can then be spliced in minutes. This is Lesson 51's failure mode in practice — sources preserved in chat outputs do not persist unless uploaded to the project.

## 299. PENDING ITEMS — updates to §144 table

| Item | Priority | Status |
|---|---|---|
| Upload deck_v4.html / v4 PDF | — | CLOSED/moot — full v5 deck rebuilt from v2 bundle + KB record (§304); upload deck_v5.html + KB v32 instead |
| Josh review: eyebrow reassignment (Teddy = THE AI LAYER, Josh = THE CAPITAL) | HIGH | Rendered as recommended; not yet approved |
| One-pager | — | CLOSED — NeuRobots_One_Pager_v5.docx + .pdf delivered July 16 (see §301) |
| Propagate roles into Simplified Chinese deck | MEDIUM | Carries forward; pairs with native-review item |
| Slogan | — | CLOSED — "Industrial robotics, radically simplified." locked July 16 (see §300) |
| New logo — Josh exploring Ideogram (raster) → Recraft/Vectorizer/designer for vectors; USPTO + reverse-image check before adoption | MEDIUM | Synapse-N remains in materials until replaced |
All other §144/§73/§68 items carry forward unchanged.

## 300. SLOGAN LOCKED — "Industrial robotics, radically simplified."

Josh's directive: slogan must center the USER — anyone can program this thing, not just programmers; ease of use, available to the masses. Iteration arc: initial trainability/physical-AI candidates ("Robots that learn your job.", "Physical AI, put to work.", "Teach it. Don't program it.", "Automation for the rest of us.", etc.) → Josh steered to a "robotics simplified" root → six iterations presented → **Josh selected: "Industrial robotics, radically simplified." for ALL materials** ("it really stands out").

Usage rules:
- This is the brand tagline across deck, one-pager, marketing, and website.
- "Train it like a new hire. Retask it in minutes." is RETAINED as the supporting product line (trainability moat, §80) — the two pair, not compete.
- Title-slide placement: replaces "Robots that learn by watching." as the hero headline. Rendered with "radically simplified." in amber (#FF9F1C) on Deep Steel (#0F1B2D). "Robots that learn by watching." is retired from the title slide but remains available as a product-slide punchline.
- Closing slide "Let's teach the machines." unchanged (not reviewed this session).
- Chinese deck: slogan needs a native-reviewed translation — do not machine-translate "radically" literally without review (joins the standing native-review item).

Deliverable: **title_slide_v5.html + title_slide_v5.pdf** (1456×840 Chromium render) — standalone, splice-ready alongside team_slide_v5 once deck_v4.html is uploaded (§298).

## 301. ONE-PAGER v5 — full propagation (real .docx at last)

Discovery: the project file `NeuRobots_One_Pager.docx` was actually a **markdown file with a .docx extension** (pipe-table markdown, 3.3KB) — not a Word document. Rebuilt from that content as a genuine .docx via docx-js (US Letter, 0.25" margins, Arial, brand palette: Deep Steel header/banner/ask blocks, amber accents, cream page) and rendered to PDF via LibreOffice. Single page confirmed.

Content changes vs. the prior one-pager, all in one pass:
- **Tagline:** "Robots that learn by watching." → **"Industrial robotics, radically simplified."** (per §300; amber emphasis on "radically simplified.").
- **Solution block:** closing line now "No code. No robotics degree. Anyone on the floor can do it." (user-centered ease-of-use positioning, replacing "No code. Ever.").
- **Team block (per §296/§297):** Josh · CEO (fundraising, IR & marketing; 20+ yrs mfg ops & IT; MS MIS; DBA; founder MFG Edge AI) · Pat · COO (offshore sourcing — 20 yrs China mfg, 8 yrs India engineering & IT; owner Jade Molds; customer network = first sales channel) · Teddy · CTO (leads AI platform & technical roadmap; ex-Tesla line design; MS Karlsruhe/KIT; custom automation systems). Closed-loop italic line updated to "the customer, the AI layer, and the capital."
- **v3 subscription reframe propagated (per §142d):** banner now "CORE SOFTWARE INCLUDED — THE AI BRAIN IS THE SUBSCRIPTION · $500–800/MO PER ROBOT (~90% MARGIN)" with the nobody-bundles-a-learning-brain sub-line; Segment 2 price line → "License + AI subscription".
- All numbers unchanged (segments, market, competition, projections, ask, use of funds, milestones); footer sources line unchanged.

Deliverables: **NeuRobots_One_Pager_v5.docx** (editable, genuine Word format) + **NeuRobots_One_Pager_v5.pdf** + build script preserved (build_onepager.js pattern — docx-js source is the editable master going forward, replacing the HTML-to-PDF path for this document). This closes the long-standing ".docx one-pager" pending item (§73/§144) AND the "propagate v3 changes to one-pager" item in one deliverable. Remaining one-pager gap: Simplified Chinese version (unchanged, carries forward).

## 302. BRAND CLEARANCE SCAN — "NeuRobots" (preliminary, July 16)

Web-based conflict scan on the HIGH-priority TESS pending item (§68). NOT a substitute for a formal TESS search by trademark counsel, but the landscape is now mapped:

**US trademark status — favorable:**
- **NEUROBOT (Petuum, Inc., SN 88462448)** — filed June 2019 for RPA/process-automation SaaS; **ABANDONED Nov 2020** (failure to respond). Dead, not a blocker.
- **NEUROBOTICS (SN 85270981)** — surgical-systems consulting; abandoned 2012. Dead.
- No live federal registration for NEUROBOT/NEUROBOTS surfaced in this scan. Preliminary read: "NeuRobots Manufacturing" appears filable in Classes 7 + 9, but a formal comprehensive search (incl. state marks and common-law) by counsel is still required before filing.

**Name-space occupants (no filing found for any):**
- **Neurobots (Recife, Brazil)** — healthcare neurotech (stroke rehab, EEG exoskeletons), founded 2016, seed-funded. Owns **neurobots.com.br** and the **LinkedIn /company/neurobots handle**. Different industry/class/geography — low legal risk, but they hold the social real estate.
- **NeuroBots / neurobots.world** — anonymous site (launched ~Oct 2025) claiming humanoid + quadruped robots for "security, lifestyle, and industrial applications." Closest category collision AND same capital-B styling — but no location, team, products, or funding visible anywhere. Reads as pre-launch or vaporware. **Monitor**; if they ever file or ship in the US industrial space, this becomes the fight. First-to-use matters: NeuRobots' documented commercial use (deck, pilots, Jade Molds) should be timestamped and preserved.
- **neurobots.com.mx** — Mexican entity, minimal footprint.
- **Petuum** still uses "Neurobots" as an RPA product name on its site (common-law claim in software automation) despite the dead filing — counsel should assess.

**SEO/press consideration (new since brand lock):** as of April 2026, "neurobots" is the widely-reported scientific term for Tufts/Wyss **living biohybrid robots with nervous systems** (IEEE Spectrum, Interesting Engineering et al.). No legal impact, but organic search for "neurobots" is now crowded with biology press — reinforces always using the full **"NeuRobots Manufacturing"** in public materials and SEO.

**Adjacent-name player:** Neura Robotics (Germany; cognitive/humanoid/cobots incl. manufacturing; €120M Series B Jan 2025; US expansion) — phonetic neighbor investors will know. The naming arc (§28) already moved off the "Neura" family; no action, but expect the "any relation to Neura?" question in pitches.

**Actions:** (1) trademark counsel for formal clearance + ITU filing in Classes 7 & 9 — the window is favorable now; (2) register domains (neurobotsmfg.com or fallback — registrar check needed, not verifiable from here); (3) grab available social handles under "neurobotsmfg" since /neurobots is taken on LinkedIn; (4) archive dated evidence of commercial use.

## 303. DEMO VIDEO + DEMO SLIDE (July 16)

Josh provided the full end-to-end demonstration video — "probably our best video": **https://youtube.com/shorts/6a5sjp7LqRM** (YouTube Short, vertical format). Not yet indexed/searchable — likely unlisted or freshly posted; Claude could not view the content, so slide copy describing it is based on Josh's description + locked product messaging.

**New deliverable: demo_slide_v5.html + demo_slide_v5.pdf** ("THE DEMO · Don't take our word for it. Watch it work."). Dark Deep-Steel slide: vertical phone mockup with amber play button (Shorts format), 3-step workflow (Show it / It learns / It works), and a **scannable QR code** (brand navy-on-cream, generated via python qrcode, ERROR_CORRECT_M) linking to the video — verified by machine-decoding the rendered slide (decodes to the exact URL). Sub-line carries the user-centered positioning: "No code. No robotics degree. Anyone on the floor can do it."

**Copy flags for Josh review:** QR caption reads "60 seconds. Live hardware. No cuts that matter." — the 60-seconds claim is safe (Shorts cap) but "live hardware / no cuts" is unverified placeholder; confirm or reword. Placement recommendation: immediately after the solution/product-pillars slide (the "show me" moment), before market/business slides — final position decided at v5 deck splice.

**Video strategy notes:** (1) if the Short is unlisted, decide whether investors get unlisted or public — public strengthens the raise narrative and starts the commercial-use evidence trail (§302); (2) keep a downloaded master copy of the video in the project archive — YouTube links rot; (3) three video-capable surfaces now exist: this QR slide (PDF deck), a tap-to-play link for emailed decks, and future website embed.

**Now three slides splice-ready** for the v5 deck: title_slide_v5, team_slide_v5, demo_slide_v5 — all blocked on the deck_v4.html upload (§298).

## 304. FULL DECK v5 — 18 slides, complete rebuild (July 16)

Josh authorized the full-deck rebuild without waiting for the deck_v4.html upload. Since deck_v4.html was unavailable, **v5 was reconstructed from the v2 page bundle (per-page JPEG + text) + the KB's authoritative record of every v3 change (§142) and the v4 screenshots slide (§145)**, then the v5-session changes were applied. The v4-era screenshot images came from the raw project-file PNGs (all 1568×784, 2:1) rather than §145's hand-cropped 3.15:1 frames — captions match §145's shot list, but crops differ from the v4 renders (flag for Josh comparison if the v4 PDF ever surfaces).

**v5 slide map (18 slides):**
1 Title — NEW: "Industrial robotics, radically simplified." hero (§300)
2 Problem · 3 Solution · 4 Strategic Advantage (AI-brain subtitle: "…Part recognition · Environment perception" per §142a) — faithful v2 rebuilds
5 Four Pillars — pillar 04 = Environment Perception (§142a)
6 Platform screenshots — "Not a concept. Running software." (v4 §145; raw-PNG crops, images height-constrained after an overflow clipped the bottom row on first render)
7 DEMO — NEW: QR slide to the full-demonstration Short (§303)
8 Business Model — v3 subscription banner (§142d)
9 Market · 10 Market Strategy — faithful v2 rebuilds
11 Competition quadrant — faithful v2 rebuild
12 Why Us · Team merged — CEO/CTO/COO cards (§296/§297)
13 Unit Economics — "AI SUBSCRIPTION" header + "none bundle a learning brain" (§142d)
14 Projections — CSS bar chart (1/1, 4/5, 11/16), "AI subscription (~$7K/yr avg)" bullet (§142d)
15 Use of Funds · 16 The Ask · 17 Roadmap ("Environment-perception viewer complete" per §142a) — faithful rebuilds
18 Closing — "Let's teach the machines." + new slogan added as sub-line

**QA (programmatic — image viewer unavailable this session):** 18 pages confirmed; per-page keyword assertions all pass; footers nn/18; QR on page 7 machine-decoded from the final PDF to the exact video URL; screenshot rendering confirmed by pixel-variance; one real defect caught and fixed (slide-6 grid overflow). Contact sheet delivered for Josh's visual review — **Josh's eyeball pass is the remaining QA step**, particularly slide layouts vs v2 (rebuilt from text + design language, not pixel reference) and the slide-6 screenshot crops.

**Deliverables:** NeuRobots_Investor_Pitch_Deck_v5.pdf (18 slides, Chromium 1456×840) + **deck_v5.html** (single-file editable source; screenshots referenced from assets/, NOT base64-embedded — the assets folder must travel with the HTML, or re-embed on next edit) + deck_v5_contact_sheet.jpg. **CRITICAL per Lesson 98: Josh must upload deck_v5.html AND the KB v32 to the project files immediately** — v5 supersedes v4 as the deck of record; the deck_v4.html upload request is now moot.

## PROCESS LESSONS (98)

98. **"Preserved alongside the PDF" only counts if it's in the project files.** deck_v3.html/deck_v4.html were preserved as chat outputs but never uploaded, so this session faced the exact page-image rebuild problem Lesson 51 was written to prevent. New rule: when a session produces an HTML source, explicitly prompt Josh to upload it to the shared project immediately.

---

*Summary of Addendum 17: FULL DECK v5 SHIPPED — 18 slides rebuilt from the v2 page bundle + KB change record (§304): new slogan title slide, v4 platform-screenshots slide from raw project PNGs, new QR demo slide, v3 pillar/subscription changes, CEO/CTO/COO team slide, closing slide gains the slogan; QA'd programmatically (page-6 overflow caught/fixed, QR decode-verified); deck_v5.html + contact sheet delivered; upload deck_v5.html + KB v32 to project files. Demo video received (youtube.com/shorts/6a5sjp7LqRM — the full end-to-end demonstration) and a QR demo slide built and scan-verified (§303), making three splice-ready slides. Brand clearance scan (§302): Petuum's NEUROBOT US filing is dead (abandoned 2020), no live blocking marks found — filing window favorable, formal counsel search recommended; watch-item: anonymous "NeuroBots" humanoid/quadruped site (neurobots.world, no visible operations); Brazilian healthcare Neurobots holds neurobots.com.br + the LinkedIn handle; "neurobots" is now also the press term for Tufts living biohybrid robots (SEO crowding — always use full "NeuRobots Manufacturing"). One-pager v5 delivered as a genuine .docx + PDF (the prior project file was markdown masquerading as .docx), propagating the new slogan, CEO/CTO/COO team block, user-centered solution copy, and the v3 subscription reframe in one pass — closing two long-standing pending items. Slogan locked — "Industrial robotics, radically simplified." (user-centered, ease-of-use positioning; pairs with the retained "Train it like a new hire. Retask it in minutes." product line; title slide v5 rendered). C-suite titles finalized — Josh CEO (fundraising/IR/marketing), Teddy CTO (AI platform + technical roadmap, superseding Josh's "leads the AI platform" framing), Pat COO (China manufacturing, India engineering/IT, customer-network GTM channel). The merged team slide was rebuilt as v5 with reassigned closed-loop eyebrows (Teddy = THE AI LAYER, Josh = THE CAPITAL — pending Josh's sign-off), per-card responsibility lines, and the footer claims preserved. Full-deck v5 splice is blocked on Josh uploading deck_v4.html to project files. Slogan and logo replacement are in flight (Ideogram exploration). One new lesson (98).*

*Last updated: July 16, 2026 (Addendum 17 — Sections 296–299, Lesson 98)*
---

<!-- v46-content-end -->
