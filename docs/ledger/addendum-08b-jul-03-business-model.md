---
ledger_split: addendum-08b
source: cobot_project_conversation_v46.md
source_lines: 10618-10744 (inclusive)
title: Three-segment business model, market data (DUPLICATE ADDENDUM #8 IN v46)
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# SESSION ADDENDUM 8 — July 3, 2026 — THREE-SEGMENT BUSINESS MODEL, TRAINABILITY AS CORE MOAT, RESEARCHED MARKET DATA & FINANCIAL PROJECTIONS, EXPANDED COMPETITIVE LANDSCAPE, DETAILED USE OF FUNDS & ROLLOUT

*(Appended in full. Nothing above this line was removed. This July 3 session reframed the business into three revenue segments, elevated AI trainability to the headline strategic advantage, replaced illustrative financials with researched, bottom-up projections, expanded the competitive landscape per Teddy's competitor research (Mujin, GrayMatter, Universal Robots, Standard Bots), and detailed the use of funds and rollout plan to milestone level.)*

## 78. THE THREE-SEGMENT BUSINESS MODEL — Josh's reframe, July 3 2026

The business now sells the same brain three ways:

**Segment 1 — Full-stack: our robot + our brain.** Turnkey NeuRobots cell: robot (mid-tier China-sourced arm), base, gripper/EOAT, vision (camera + lidar), Jetson compute, NeuRobots software. Built and integrated at Boyceville. Highest revenue per unit; the segment we control end-to-end and the one the demo platform proves. This is the current deck's positioning and remains the Phase 1 GTM lead.

**Segment 2 — Brains for new robots.** The NeuRobots brain (perception stack + AI software + controller layer) sold to buyers/OEMs/distributors of other robot brands. This is Mujin's model applied to the factory floor. Gated on the driver library (see §80) — launches after Segments 1 and 3 establish credibility.

**Segment 3 — Retrofit: brains onto robots already installed in factories.** A retrofit kit — camera(s), lidar, Jetson brain box, mounting hardware, NeuRobots software — that makes an existing dumb robot trainable. The customer already owns the robot, so there is no capex barrier to a yes; the sale is the kit + subscription. Per IFR World Robotics 2025, ~4.66 million industrial robots are in operation globally (2024, +9% YoY), nearly all pendant-programmed and single-task. This installed base is a market that requires no new robot purchase. Mujin validates the brain-layer thesis (Series D, Dec 2025, ~$243M initial close jointly led by NTT Group and Qatar Investment Authority, explicitly funding a pivot to product-led MujinOS) but operates in logistics/warehousing; general factory-floor retrofit for mid-market manufacturers is open ground.

**Segment sequencing (strategic decision, confirmed this session):** Full-stack first (prove it end-to-end, control every variable), Retrofit second (same brain in kit form; fastest customer yes; Jade Molds is the first retrofit test bed), Brains-for-new-robots third (requires driver library + market credibility). All three segments carry the same mandatory software subscription, making recurring revenue the unifying layer across the whole business.

## 79. TRAINABILITY AS THE HEADLINE MOAT — "Train it like a new hire"

Elevated from feature to core strategic advantage: NeuRobots robots are trained, not programmed — and retrained to new tasks in minutes, not weeks. The technical basis: cameras + lidar perception fused into a live world model, with the AI brain (program-by-demonstration, programming wizard, part recognition) sitting on top. This is the existing perception stack (§1–§29) plus the four software pillars (§64) marketed as one capability: rapid task acquisition and re-tasking.

Why this is the moat to market:
- **High-mix reality:** mid-market manufacturers change jobs constantly. A robot that takes 2–6 weeks of integrator time to retask is uneconomical for them; a robot retasked by its own operator in an afternoon changes the ROI math categorically.
- **Market language tailwind:** "Physical AI" was the primary theme at CES 2026; Teradyne, GrayMatter, and Mujin all now market under it. ABI Research notes companies remain wary of AI-robotics investment until vendors demonstrate clear ROI — retask-speed IS the demonstrable ROI.
- **Competitive whitespace:** Standard Bots claims AI-native but did not demonstrate AI training in a live demo Teddy attended (§60 caveat still applies: frame as observation). Universal Robots leads on hardware but has no native program-by-demonstration. Mujin's intelligence targets logistics workflows, not general factory retasking. GrayMatter's AI is deep but confined to surface finishing.

**Messaging additions (extends §67):** Primary moat line: "Train it like a new hire. Retask it in minutes." Supporting: "Every robot we touch gets smarter — ours, theirs, or the one already on your floor." Existing taglines ("Robots that learn by watching," "Let's teach the machines") remain; the trainability moat line becomes the strategic-advantage slide headline.

## 80. THE DRIVER LIBRARY — moat #2, enabler of Segments 2 & 3

Each robot brand supported = a driver (socket/API command layer, kinematics, safety envelope). Estun S-Series Gen2 is done (Addendum 7: full socket command set, calibrated DH, articulating digital twin). Every additional brand added expands the serviceable market for Segments 2 and 3 and deepens a moat competitors must rebuild brand-by-brand. Priority queue for next drivers (to be validated against pilot demand): FANUC, ABB, Yaskawa, KUKA (largest installed bases), then UR (largest cobot base). The library is a named line item in the use of funds (§83).

## 81. MARKET DATA — researched, citable, honest ranges (replaces all placeholder market claims)

**Cobot market (Segment 1 TAM):** Analyst estimates cluster at ~$2.5–3.0B (2025–26) growing ~20–23% CAGR: Grand View Research $2.95B (2025) → $17.2B (2033), 23.1% CAGR; Fortune Business Insights $2.8B (2026) → $13.3B (2034), 21.45% CAGR. Cite the band, not one number.

**Phase 1 application growth:** Palletizing/de-palletizing growing at 24.55% CAGR through 2031 (Mordor Intelligence); above-10kg cobots (machine tending / palletizing class) the fastest-growing payload segment at 24%+ CAGR (Grand View). Cobot software revenue growing 27.15% CAGR vs. hardware at 71% of market today (Mordor) — direct support for the subscription layer.

**Installed base (Segments 2+3 TAM):** ~4.66M industrial robots in operation globally, 2024, +9% YoY (IFR World Robotics 2025). At $6–10K/yr brain subscription potential per robot, the brain-layer opportunity on the installed base alone is tens of billions — framed honestly as opportunity space, not projected capture.

**Demand driver:** $2.5T U.S. manufacturing industry with 3.8M unfilled jobs (Deloitte) — same stat GrayMatter used successfully in its $45M Series B.

**Category-leader reality check (use in pitch):** Universal Robots, the global cobot leader, did $293M revenue in 2024; Teradyne's entire robotics group did $365M (2024) and $91M in Q1 2026. The market leader is a ~$300M/yr business in a market projected at $13–17B by the early 2030s. Nobody has won. The market is early. (Sources: The Robot Report, Teradyne SEC filings.)

## 82. COMPETITIVE LANDSCAPE — expanded per Teddy's research (extends §60)

| Company | Funding | What they are | What they lack |
|---|---|---|---|
| **Mujin** | ~$243M Series D initial close Dec 2025 (NTT + Qatar Investment Authority); ~$341M cumulative (PitchBook) | Brain layer (MujinOS) on any robot; logistics/warehouse focus (palletizing, piece picking, truck unloading); pivoting integration→product | No robots of their own; not focused on general factory-floor retasking for mid-market manufacturers |
| **GrayMatter Robotics** | $45M Series B Jun 2024 (Wellington), ~$70M total; ~$7.4M est. revenue @ ~60 employees | Physics-informed AI cells for surface finishing (sanding, grinding, coating); RaaS model; Apr 2026 HII shipbuilding MOU | Single application family; doesn't touch machine tending / palletizing / pick & place |
| **Standard Bots** | $263M+ (Series C $200M, Jun 2026, $1B valuation) | Robots + claimed AI-native positioning; US manufacturing roadmap | AI training not demonstrated in live demo (observation, one demo — §60 caveat) |
| **Universal Robots** | Public (Teradyne); $293M rev 2024, flat-to-declining since 2022 peak $326M | Cobot hardware leader, huge ecosystem | No native physical AI / program-by-demonstration on platform |

**The 2x2 slide:** Mujin = brains, no robots. Standard Bots = robots, AI claimed. GrayMatter = brains + robots, one niche. UR = robots at scale, no AI. **NeuRobots = robots + working AI + low-cost hardware + retrofit path — the only player in the quadrant.** GrayMatter doubles as third-party proof that our Phase 2 (surface finishing) is independently fundable.

## 83. FINANCIAL PROJECTIONS — bottom-up model (replaces "illustrative" placeholders)

**Unit economics (anchored to actual sourcing data in this doc):**

| | Turnkey cell (Seg 1) | Retrofit kit (Seg 3) |
|---|---|---|
| COGS | $18–28K (arm $6–12K + vision $4–6K + base/EOAT/Jetson/assembly) | $8–14K (camera+lidar+Jetson+mounting; no arm) |
| Price | $65–85K | $25–40K |
| Gross margin | ~60–70% | ~60–65% |

Reference points: comparable US integrator machine-tending/palletizing cells sell $80–150K; Standard Bots' arm alone ~$37K. China sourcing (§62) is what makes 60–70% hardware margin possible at an undercut price — the cost advantage made visible in numbers.

**Software subscription (all segments, mandatory bundle):** $500–800/month per robot ($6–10K/yr, ~90% margin). Supported by the 27% software-CAGR market trend. Every brain in the field pays, whether it sits on our arm, their new arm, or a retrofitted one.

**Base-case projection (assumptions stated on-slide):**

| Year | Cells (Seg 1) | Retrofits (Seg 3) | Hardware rev | Recurring rev (cumulative units × ~$7K avg) | Total |
|---|---|---|---|---|---|
| 2027 | 6–10 pilots | 2–4 pilots (Jade Molds first) | ~$0.6–0.9M | ~$50–80K | **~$0.7–1.0M** |
| 2028 | 30–40 | 15–25 | ~$2.8–3.9M | ~$400–550K | **~$3.2–4.5M** |
| 2029 | 80–110 | 60–90 | ~$7.5–10M | ~$1.4–1.9M | **~$9–12M** |

**Upside scenario** (shown as second line, not the ask's basis): Segment 2 (brains-for-new-robots) begins contributing H2 2028 via 1–2 distributor/OEM deals; 2029 total ~$14–18M. Sanity anchor: GrayMatter reached ~$7.4M revenue at roughly the same company age with a single application family and no low-cost hardware arm — our base case is aggressive but inside the credible envelope. Trajectory supports a Series A raise in 2028 at a genuine markup.

**Modeling posture (decision):** Base + upside, two lines. No top-down "1% of TAM" math anywhere in the deck.

## 84. USE OF FUNDS — dollar-level detail (supersedes the illustrative 35/30/15/12/8 of §65)

| Allocation | $ | Deliverables |
|---|---|---|
| Hardware & demo/pilot platforms | $330K | 2 demo cells + 4–6 pilot cells + 2–4 retrofit pilot kits; China sourcing trip; Boyceville tooling |
| Software engineering | $290K | 1–2 engineering hires; Claude API costs; four pillars to pilot-grade; **driver library: 2 additional robot brands** |
| Phase 2 R&D scoping | $140K | Paid engagements w/ welding + inspection SMEs; feasibility cells |
| Sales, marketing & demo program | $150K | Pilot subsidies; FABTECH/Automate presence; demo video production; trainability-moat marketing assets |
| Working capital / operations | $90K | Runway buffer |
| **Total** | **$1.0M** | 12–18 months to Series-A-ready metrics |

**Milestones investors can hold us to:** First 3 paying pilots (mix of cell + retrofit) by Q2 2027 · $700K+ revenue run-rate by Q4 2027 · Driver library at 3 brands by Q1 2028 · Series-A-ready (repeatable playbook, recurring layer live, 6+ qualified pipeline) by mid-2028.

## 85. ROLLOUT PLAN — segment-aware roadmap (extends §66)

| Phase | Timeline | Segment focus | Goals |
|---|---|---|---|
| **Demo** | Q3–Q4 2026 | Seg 1 | Finalize gripper/tooling, confirm vision stack, debug program-by-demonstration; investor demo platform complete |
| **Pilot** | H1 2027 | Seg 1 + Seg 3 | First paying cell pilots; first retrofit pilot at Jade Molds; 3D/TCP viewer complete |
| **Scale** | H2 2027–2028 | Seg 1 + Seg 3, Seg 2 groundwork | Grow cell + retrofit sales; driver library to 3 brands; first Seg 2 distributor conversations; begin Phase 2 dev with SMEs |
| **Expand** | 2028+ | All three | Seg 2 OEM/distributor deals live; Series A; Phase 2 applications (welding, inspection) enter pilots |

## 86. DECK IMPACT — slides to change (queued for next deck revision)

1. **Business model slide (09):** rebuild around the three segments; subscription as the unifying recurring layer across all three. (Prior pending item "reorder to lead with hardware" is superseded by the three-segment structure.)
2. **NEW strategic advantage slide:** trainability moat — "Train it like a new hire. Retask it in minutes." Camera + lidar + AI brain diagram.
3. **Market slide:** cited ranges from §81, incl. 4.66M installed-base stat and UR-revenue "market is early" framing.
4. **Competition slide (07):** expand from Standard Bots two-column to the 2x2 with Mujin, GrayMatter, UR.
5. **NEW financial projections slide:** base + upside table with on-slide assumptions.
6. **Use of funds slide (11):** dollar-level table from §84; remove "illustrative" disclaimer.
7. **Roadmap slide:** segment-aware rollout from §85.
8. One-pager and Chinese deck updated to match after English deck is approved.

## 87. PHOTO / SCREENSHOT INCORPORATION — workflow for Josh

Real photos of working hardware are the single strongest credibility asset a pre-revenue deck can have. Workflow: upload images to the shared project files (JPG or PNG). Naming convention so Claude can place them without guesswork: `photo_<subject>_<nn>.jpg` for physical shots, `screenshot_<software-pillar>_<nn>.png` for UI. Include a `photo_captions.txt` (one line per file: filename — caption — where taken/what it shows). Suggested shot list, in priority order: (1) robot arm in motion at Boyceville, (2) program-by-demonstration UI mid-flow, (3) 3D/TCP viewer with the articulating S10-140 twin, (4) part-recognition camera overlay, (5) vision hardware (camera + lidar) mounted on arm, (6) Jade Molds production floor, (7) team working in the shop. Landscape orientation preferred; highest resolution available (deck will downscale). Claude will map images to slides: demo photos → product/technology slides; Jade Molds → operations/test-bed slide; team shots → team slide backdrop.

## PROCESS LESSONS (45–48)
45. Bottom-up unit economics beat top-down TAM-percentage math with investors every time; state assumptions on the slide.
46. When analyst market estimates diverge widely, cite the band and the sources — honesty reads as rigor.
47. A competitor's success in an adjacent niche (GrayMatter in surface finishing) is third-party validation of your roadmap, not just a threat.
48. Segment sequencing matters as much as segment identification — three revenue lines announced at once reads as unfocused; sequenced, it reads as a land-and-expand strategy.

*Summary of Addendum 8: the business was reframed into THREE SEGMENTS (full-stack robot+brain / brains for new robots / retrofit of installed robots) with confirmed sequencing (full-stack → retrofit → brains-for-new-robots); TRAINABILITY (cameras + lidar + AI brain; retask in minutes) was elevated to the headline strategic moat with new messaging; the DRIVER LIBRARY was named moat #2 and a funded line item; MARKET DATA was researched and locked to citable ranges (cobots ~$2.5–3B @ ~20–23% CAGR; palletizing 24.55% CAGR; software 27% CAGR; 4.66M installed robots; $2.5T US mfg / 3.8M unfilled jobs; UR $293M 2024 revenue as "market is early" proof); the COMPETITIVE LANDSCAPE was expanded to a 2x2 (Mujin ~$341M raised / GrayMatter $70M / Standard Bots $263M / UR public) with NeuRobots alone in the robots+working-AI+low-cost+retrofit quadrant; FINANCIAL PROJECTIONS were rebuilt bottom-up (cells $65–85K @ 60–70% GM; retrofit kits $25–40K; $500–800/mo mandatory subscription; base case ~$0.7–1M / $3.2–4.5M / $9–12M for 2027–29 with an upside line adding Segment 2); USE OF FUNDS was detailed to dollars and deliverables with named milestones; the ROLLOUT was made segment-aware through 2028+; DECK CHANGES were queued (8 items); and a PHOTO WORKFLOW was defined (naming convention + captions file + prioritized shot list). Four new process lessons (45–48). All prior content from v14 through v21 (Addenda 1–7) preserved unchanged.*

---

<!-- v46-content-end -->
