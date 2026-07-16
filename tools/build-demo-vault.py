#!/usr/bin/env python3
"""Build the Live Git Diff demo vault: a research briefing an agent revised over four days.

WHY A NEW VAULT: the original demo fixture is well written but renders to 1368px — it
FITS in a 1414px viewport, so there is nothing to scroll and a scroll-sync GIF cannot be
filmed on it. This keeps its voice and its story and gives it the length the demo needs,
without rewriting anyone's commit history.

WHAT IT IS COMPOSED FOR — and what it deliberately does NOT do:
The one shape that drifts is a 'mod' pair whose two sides render at different heights: the
diff pairs them, and nothing reserves the difference. Section-level insertions and deletions
are reserved EXACTLY (the base pane is fully rendered, so their heights are known), and word
edits that don't change a wrap cost nothing.

So this is written the way an agent actually revises a brief: it adds sections, deletes the
open-questions block once they're answered, rewrites a paragraph past recognition, and
tightens wording in place. It does NOT contort itself to keep every block the same height —
that would be a rigged demo, and the honest fix was to fix the plugin instead (the parity
and ordering bugs found tonight took the drift from 320px to ~50px).
"""
import subprocess, pathlib, os, sys

VAULT = pathlib.Path.home() / "Documents/LiveGitDiff-Demo"
NOTE = "Pollinator garden briefing.md"

V1 = """# Pollinator Garden — Research Briefing

*Prepared by the research agent from 12 sources. Site visit pending.*

## Summary

A 40 m² pollinator garden on the south lawn supports bees and butterflies from May to September. A single-season build is the fastest path to a working garden.

## Why the south lawn

Three parcels were considered. The south lawn is the only one that clears the tree line before mid-morning, and the only one outside the mower's turning circle.

The verge along the access road scores well on sun but sits in the spray drift of the road salt applied each winter. Salt tolerance would narrow the planting list to a handful of species, none of them strong nectar producers. The strip behind the equipment shed is sheltered and close to water, but takes under three hours of direct sun — enough to keep plants alive, not enough to keep them flowering.

## Recommended plants

| Plant          | Blooms  | Notes                      |
| -------------- | ------- | -------------------------- |
| Lavender       | Jun–Aug | Drought-tolerant           |
| Coneflower     | Jul–Sep | Self-seeds readily         |
| Butterfly bush | Jul–Oct | Fast-growing, showy        |

Bloom windows were chosen to overlap. A gap of more than two weeks sends foraging bees elsewhere, and once they have relocated they do not reliably come back the same season.

## Open questions

Sun hours on the south lawn are an estimate from satellite imagery — confirm on site. The spigot distance might rule out hand-watering entirely.

Whether the community compost bins can cover the soil amendment, or whether it has to be bought in.

## Site assessment

The south lawn receives about six hours of direct sun. Soil is compacted clay and will need amendment before planting. The nearest spigot is 30 m away.

### Sun and exposure

Measured at ground level on two clear days in June. The eastern quarter falls into shade after 15:00 once the neighbouring maples are in leaf; that quarter suits the shade-tolerant end of the list rather than the sun-demanding perennials.

Prevailing wind is from the southwest and unobstructed. Tall stems will need either a windward planting of something sturdy or a season of staking while the roots take hold.

### Soil

Compacted clay throughout, with a measured infiltration rate under 6 mm/hour. Left untreated that drowns roots in spring and bakes hard by August. Amendment is not optional here.

Two core samples came back mildly alkaline at pH 7.4. Tolerable for this list, but it rules out the acid-loving species that would otherwise carry the bloom window into November.

### Water

The nearest spigot is 30 m from the bed. Hand-watering was costed and rejected: at roughly 40 minutes a session, twice weekly through an establishment season, it exceeds the price of the irrigation kit inside a single summer — and it is the first chore to get skipped in August, which is exactly when skipping it kills a first-year planting.

A soaker hose on a mechanical timer is the cheapest arrangement that survives a holiday. Drip line was quoted at three times the cost for a bed this size and buys precision the planting does not need.

## Establishment timeline

First-year losses are the number that decides whether this is worth doing. Regional extension trials put them at 15–25% for plugs in amended clay, concentrated almost entirely in the first eight weeks.

- **Weeks 1–8.** The whole risk window. Water on the timer, no fertiliser, no foot traffic. Anything that dies here dies of drought or compaction, not of the plant list.
- **Weeks 9–20.** Roots take. Weekly weeding matters more than watering; the natives lose to established grass long before they lose to drought.
- **Year two.** The bed reads as intended for the first time. Perennials fill their drifts and the gaps close.

Anyone judging this planting before its second August is judging it early.

## Risks

- **The maple is the real constraint.** It takes both light and water, and it will take more of each every year. The shade line moves; the plant list does not. A spring survey settles how much room the west edge really has.
- **Deer are present but not established.** No browse damage on the neighbouring beds this season. If that changes, the lavender and the coneflower are the first to go, and the fix is fencing rather than a different plant list.
- **The compost supply is a favour, not a contract.** If the bins are reallocated, the $240 soil line item comes back.

## Costs

| Option | Cost | Notes |
| --- | --- | --- |
| Single season | $1,850 | Includes $240 of soil amendment |

## Sources

Twelve sources, weighted toward regional extension publications over general gardening media. Two site visits outstanding: a spring survey to confirm the shade line, and a soil retest after amendment.
"""


def edit(text, old, new, why):
    assert old in text, f"anchor missing ({why}): {old[:60]!r}"
    assert text.count(old) == 1, f"anchor not unique ({why})"
    return text.replace(old, new, 1)


# --- v2 (Jul 14, 6:20 PM) — agent adds the maintenance calendar -------------------
V2 = edit(V1, """## Costs""", """## Maintenance calendar

- **Spring:** cut back last year's stems once temperatures hold above 10 °C. Earlier than that and the overwintering insects are still inside them.
- **Summer:** deep-water twice weekly in drought; deadhead coneflowers to extend the bloom.
- **Autumn:** cut everything back and clear the bed for winter.

## Costs""", "v2 calendar")

# --- v3 (Jul 14, 11:20 PM) — queue the site-visit questions -----------------------
V3 = edit(V2, """Whether the community compost bins can cover the soil amendment, or whether it has to be bought in.""",
"""Whether the community compost bins can cover the soil amendment, or whether it has to be bought in.

Whether the bed is worth 2 m² of the kids' soccer run-out zone — worth pacing out on the visit.""", "v3 question")

# --- v4 (Jul 15, 6:20 PM) — apply review round 1 ----------------------------------
V4 = edit(V3, "from 12 sources. Site visit pending.", "from 16 sources and one completed site visit.", "r1 sources")
V4 = edit(V4, "| Butterfly bush | Jul–Oct | Fast-growing, showy        |",
          "| Swamp milkweed | Jun–Aug | Monarch host plant, native |\n| Joe-Pye weed   | Jul–Sep | Late-season nectar, native |", "r1 natives")
V4 = edit(V4, "A 40 m² pollinator garden on the south lawn supports bees and butterflies from May to September. A single-season build is the fastest path to a working garden.",
          "A 40 m² pollinator garden on the south lawn supports bees, butterflies, and native moths from April to October. A phased two-season build is the surest path to a working garden.", "r1 summary")
V4 = edit(V4, """The south lawn receives about six hours of direct sun. Soil is compacted clay and will need amendment before planting. The nearest spigot is 30 m away.""",
"""The south lawn receives six hours of direct sun. Soil is compacted clay and will need amendment before planting. The nearest spigot is 30 m away — a soaker hose on a timer is the cheapest reliable option.

The community compost bins produce roughly 0.8 m³ per month in summer; reserving two months of output covers the full amendment at zero cost, replacing the $240 soil line item. The bins are 60 m from the bed — one wheelbarrow run, not a delivery.""", "r1 site + compost")
V4 = edit(V4, """## Open questions

Sun hours on the south lawn are an estimate from satellite imagery — confirm on site. The spigot distance might rule out hand-watering entirely.

Whether the community compost bins can cover the soil amendment, or whether it has to be bought in.

Whether the bed is worth 2 m² of the kids' soccer run-out zone — worth pacing out on the visit.

""", "", "r1 removes the answered questions")
V4 = edit(V4, "| Single season | $1,850 | Includes $240 of soil amendment |",
          "| Single season | $1,610 | Compost swap applied |\n| Phased (2 seasons) | $860 + $600 | Perennials year one, shrubs year two |", "r1 costs")
V4 = edit(V4, "Twelve sources, weighted toward regional extension publications over general gardening media. Two site visits outstanding: a spring survey to confirm the shade line, and a soil retest after amendment.",
          "Sixteen sources, weighted toward regional extension publications over general gardening media. One site visit completed; a soil retest is scheduled after amendment.", "r1 sources tail")

# --- v5 (Jul 15, 7:25 PM) — the autumn rule, from the master gardener talk --------
V5 = edit(V4, "- **Autumn:** cut everything back and clear the bed for winter.",
"""- **Autumn:** leave the seed heads standing — they feed birds and shelter overwintering insects. Cutting back in autumn is the single most common way a pollinator bed is quietly sterilised.
- **Winter:** no intervention. The bed looks untidy by design; tidying it is what removes the habitat.""", "v5 autumn")

# --- v6 (Jul 15, 8:34 PM) — layout, sourcing, and the soccer-zone question --------
V6 = edit(V5, "## Sources", """## Planting layout

Tall natives at the back along the fence — Joe-Pye weed and milkweed both clear a metre — with coneflower mid-bed and lavender edging the path where it gets brushed in passing. Leave a 60 cm maintenance path along the fence line; everything should be reachable without stepping into the bed.

- Group each species in drifts of three or five, not singles — pollinators forage more efficiently on massed blooms.
- Keep the lavender out of the compost-amended zone; it prefers the lean soil as it is.
- The sprinkler shadow near the maple stays bare mulch — nothing establishes there.

## Sourcing

The native plant sale at the county extension runs the first weekend of May — order forms open in March, and the milkweed sells out in days. Everything else is stock at the two nurseries on Route 9. Ask for plugs, not gallon pots: they establish faster in amended clay and cost a third as much.

## Decision needed

Whether the garden is worth 2 m² of the kids' soccer run-out zone. The bed can shift 1.5 m north to spare it, at the cost of an hour less afternoon sun — which the plant list tolerates.

Both options work. This one is a household preference, not a research finding, and it is the only thing still blocking a build date.

## Sources""", "v6 layout + sourcing + decision")

COMMITS = [
    (V1, "2026-07-12 09:30:00 -0400", "draft the garden briefing from the first research pass"),
    (V2, "2026-07-14 18:20:00 -0400", "add the maintenance calendar"),
    (V3, "2026-07-14 23:20:00 -0400", "queue the questions for tomorrow's site visit"),
    (V4, "2026-07-15 18:20:00 -0400", "apply review round 1 — natives, compost swap, phased costs"),
    (V5, "2026-07-15 19:25:00 -0400", "autumn rule from the master gardener talk"),
    (V6, "2026-07-15 20:34:00 -0400", "layout, sourcing, and the soccer-zone question"),
]

if __name__ == "__main__":
    if "--check" in sys.argv:
        for i, (t, _, m) in enumerate(COMMITS, 1):
            print(f"  v{i}: {len(t.splitlines()):3d} lines  {len(t):5d} bytes   {m[:56]}")
        sys.exit()

    VAULT.mkdir(parents=True, exist_ok=True)
    run = lambda *a, **k: subprocess.run(a, cwd=VAULT, check=True, capture_output=True, text=True, **k)
    if not (VAULT / ".git").exists():
        run("git", "init", "-q", "-b", "main")
    for text, date, msg in COMMITS:
        (VAULT / NOTE).write_text(text)
        run("git", "add", "--", NOTE)
        subprocess.run(["git", "commit", "-q", "-m", msg], cwd=VAULT, check=True,
                       env={**os.environ, "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})
    print(f"built {VAULT} — {len(COMMITS)} commits")
