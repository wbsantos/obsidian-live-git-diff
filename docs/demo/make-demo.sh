#!/usr/bin/env bash
# make-demo.sh — generate an IP-free demo note with a realistic git history,
# for capturing the README screenshots (hero shot, version picker, word marks).
#
# Creates its own git repo in the target folder, so the version picker shows
# ONLY these commits — nothing from your vault or any surrounding repo.
#
# Usage:
#   bash docs/demo/make-demo.sh "<folder-inside-a-vault>"
#   e.g. bash docs/demo/make-demo.sh ~/Documents/MyVault/plugin-demo
#
# Then in Obsidian: open pollinator-garden-briefing.md in Reading view,
# run "Live Git Diff: Open review against a version…", and pick the first
# commit ("agent: draft pollinator briefing…"). Dates are macOS `date -v`.
set -euo pipefail

TARGET="${1:?usage: make-demo.sh <folder-inside-your-vault>}"
NOTE="pollinator-garden-briefing.md"

mkdir -p "$TARGET"
cd "$TARGET"
if [ -d .git ]; then
  echo "refusing: $TARGET already has a git repo — pick a fresh folder" >&2
  exit 1
fi
git init -q

commit() { # commit <date-offset e.g. -10d or -3H> <subject>
  local when
  when="$(date -v"$1" +"%Y-%m-%dT%H:%M:%S")"
  git add "$NOTE"
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git commit -qm "$2"
}

# ---- v1: the agent's first draft --------------------------------------------
cat > "$NOTE" <<'MD'
# Pollinator Garden — Research Briefing

*Prepared by the research agent from 14 sources. Two site visits pending.*

## Summary

A 40 m² pollinator garden on the south lawn can support bees and butterflies from April to October. The main cost drivers are soil replacement and perennial stock; both drop sharply if planting is phased over two seasons.

## Recommended plants

| Plant | Blooms | Notes |
| --- | --- | --- |
| Lavender | Jun–Aug | Drought-tolerant |
| Coneflower | Jul–Sep | Self-seeds readily |
| Butterfly bush | Jul–Oct | Fast-growing |

## Site assessment

The south lawn receives six hours of direct sun. Soil is compacted clay and will need amendment before planting. Water access is 30 m away — a soaker hose on a timer is the cheapest reliable option.

## Costs

Initial estimate: $1,850 for a single-season build, including soil, plants, mulch, and irrigation.

## Open questions

- Which native species should replace the ornamentals?
- Can compost from the community bins cover the soil amendment?
MD
commit -10d "agent: draft pollinator briefing from research notes"

# ---- v2: agent adds a section and a phased cost option ----------------------
cat > "$NOTE" <<'MD'
# Pollinator Garden — Research Briefing

*Prepared by the research agent from 14 sources. Two site visits pending.*

## Summary

A 40 m² pollinator garden on the south lawn can support bees and butterflies from April to October. The main cost drivers are soil replacement and perennial stock; both drop sharply if planting is phased over two seasons.

## Recommended plants

| Plant | Blooms | Notes |
| --- | --- | --- |
| Lavender | Jun–Aug | Drought-tolerant |
| Coneflower | Jul–Sep | Self-seeds readily |
| Butterfly bush | Jul–Oct | Fast-growing |

## Site assessment

The south lawn receives six hours of direct sun. Soil is compacted clay and will need amendment before planting. Water access is 30 m away — a soaker hose on a timer is the cheapest reliable option.

## Costs

| Option | Cost | Notes |
| --- | --- | --- |
| Single season | $1,850 | Everything planted this spring |
| Phased (2 seasons) | $1,100 + $600 | Perennials year one, shrubs year two |

## Maintenance calendar

- **Spring:** cut back last year's stems after temperatures hold above 10 °C.
- **Summer:** deep-water twice weekly in drought; deadhead coneflowers to extend bloom.
- **Autumn:** leave seed heads standing — they feed birds and shelter overwintering insects.

## Open questions

- Which native species should replace the ornamentals?
- Can compost from the community bins cover the soil amendment?
MD
commit -9d "agent: add maintenance calendar and phased cost option"

# ---- v3: review round 1 — native species swap, summary reworded -------------
cat > "$NOTE" <<'MD'
# Pollinator Garden — Research Briefing

*Prepared by the research agent from 16 sources and one completed site visit.*

## Summary

A 40 m² pollinator garden on the south lawn can support bees, butterflies, and native moths from April to October. Phasing the planting over two seasons cuts the up-front cost by roughly 40% and lets the soil amendment settle before the deep-rooted natives go in.

## Recommended plants

| Plant | Blooms | Notes |
| --- | --- | --- |
| Lavender | Jun–Aug | Drought-tolerant |
| Coneflower | Jul–Sep | Self-seeds readily |
| Swamp milkweed | Jun–Aug | Monarch host plant, native |
| Joe-Pye weed | Jul–Sep | Late-season nectar, native |

## Site assessment

The south lawn receives six hours of direct sun. Soil is compacted clay and will need amendment before planting. Water access is 30 m away — a soaker hose on a timer is the cheapest reliable option.

## Costs

| Option | Cost | Notes |
| --- | --- | --- |
| Single season | $1,850 | Everything planted this spring |
| Phased (2 seasons) | $1,100 + $600 | Perennials year one, shrubs year two |

## Maintenance calendar

- **Spring:** cut back last year's stems after temperatures hold above 10 °C.
- **Summer:** deep-water twice weekly in drought; deadhead coneflowers to extend bloom.
- **Autumn:** leave seed heads standing — they feed birds and shelter overwintering insects.

## Open questions

- Can compost from the community bins cover the soil amendment?
MD
commit -2d "apply review round 1 — 4 comments from sidecars"

# ---- v4: agent resolves the last open question ------------------------------
cat > "$NOTE" <<'MD'
# Pollinator Garden — Research Briefing

*Prepared by the research agent from 16 sources and one completed site visit.*

## Summary

A 40 m² pollinator garden on the south lawn can support bees, butterflies, and native moths from April to October. Phasing the planting over two seasons cuts the up-front cost by roughly 40% and lets the soil amendment settle before the deep-rooted natives go in.

## Recommended plants

| Plant | Blooms | Notes |
| --- | --- | --- |
| Lavender | Jun–Aug | Drought-tolerant |
| Coneflower | Jul–Sep | Self-seeds readily |
| Swamp milkweed | Jun–Aug | Monarch host plant, native |
| Joe-Pye weed | Jul–Sep | Late-season nectar, native |

## Site assessment

The south lawn receives six hours of direct sun. Soil is compacted clay and will need amendment before planting. Water access is 30 m away — a soaker hose on a timer is the cheapest reliable option.

The community compost bins produce roughly 0.8 m³ per month in summer; reserving two months of output covers the full amendment at zero cost, replacing the $240 soil line item.

## Costs

| Option | Cost | Notes |
| --- | --- | --- |
| Single season | $1,610 | Compost swap applied |
| Phased (2 seasons) | $860 + $600 | Perennials year one, shrubs year two |

## Maintenance calendar

- **Spring:** cut back last year's stems after temperatures hold above 10 °C.
- **Summer:** deep-water twice weekly in drought; deadhead coneflowers to extend bloom.
- **Autumn:** leave seed heads standing — they feed birds and shelter overwintering insects.
MD
commit -1d "agent: source compost on-site; close the last open question"

# ---- v5: review round 2 — tighten the summary -------------------------------
cat > "$NOTE" <<'MD'
# Pollinator Garden — Research Briefing

*Prepared by the research agent from 16 sources and one completed site visit.*

## Summary

A 40 m² pollinator garden on the south lawn supports bees, butterflies, and native moths from April to October. Phasing over two seasons cuts up-front cost by 44% and lets the amended soil settle before the deep-rooted natives go in.

## Recommended plants

| Plant | Blooms | Notes |
| --- | --- | --- |
| Lavender | Jun–Aug | Drought-tolerant |
| Coneflower | Jul–Sep | Self-seeds readily |
| Swamp milkweed | Jun–Aug | Monarch host plant, native |
| Joe-Pye weed | Jul–Sep | Late-season nectar, native |

## Site assessment

The south lawn receives six hours of direct sun. Soil is compacted clay and will need amendment before planting. Water access is 30 m away — a soaker hose on a timer is the cheapest reliable option.

The community compost bins produce roughly 0.8 m³ per month in summer; reserving two months of output covers the full amendment at zero cost, replacing the $240 soil line item.

## Costs

| Option | Cost | Notes |
| --- | --- | --- |
| Single season | $1,610 | Compost swap applied |
| Phased (2 seasons) | $860 + $600 | Perennials year one, shrubs year two |

## Maintenance calendar

- **Spring:** cut back last year's stems after temperatures hold above 10 °C.
- **Summer:** deep-water twice weekly in drought; deadhead coneflowers to extend bloom.
- **Autumn:** leave seed heads standing — they feed birds and shelter overwintering insects.
MD
commit -3H "apply review round 2 — tighten summary, fix cost figure"

echo "✅ demo ready: $TARGET/$NOTE"
echo "   Open it in Reading view → 'Open review against a version…' → pick the first commit."
git log --oneline
