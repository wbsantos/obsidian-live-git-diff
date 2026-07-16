# Field Guide to Kitchen Fermentation

A working catalog of fermentation methods, failure modes, and the measurements that
tell them apart. Everything here has been run at least twice.

> **Scope note:** this edition covers vegetables and dairy only. Grain ferments have
> their own timing problems and deserve a separate guide.

---

## Why Measure Anything

Most people ferment by looking at the jar. That instinct is the first thing to give up.
A jar that looks right and a jar that is right diverge for about four days, which is
exactly long enough to ruin a batch and learn nothing from it.

The three numbers worth taking:

- **pH** — the only direct read on whether the acid has arrived.
- **Brine density** — tells you whether the salt is where you think it is.
- **Temperature** — the variable everyone assumes is constant and never is.

Taking all three costs about ninety seconds a day. Skipping them costs a batch.

## Reading Lens

> **Reading lens:** the sections below are ordered by how early the failure shows up,
> not by how bad it is. A late-appearing failure is usually a compounding one.

## The Salt Line

Salt concentration is a threshold, not a dial. Below roughly 2% by weight, the
lactobacillus has no advantage over everything else in the jar. Above about 5%, it has
no advantage over nothing at all, because nothing grows.

Between those, the exact number is a texture decision rather than a safety one.

### Measuring by Weight, Not Volume

A tablespoon of flake salt and a tablespoon of fine salt differ by nearly half in mass.
Every recipe that specifies volume is quietly assuming one particular salt, and almost
never says which.

Weigh the vegetables. Weigh the water. Take a percentage of the sum.

## Temperature Windows

| Ferment | Low | Ideal | High |
| --- | --- | --- | --- |
| Sauerkraut | 15C | 18-20C | 24C |
| Kimchi | 4C | 12-15C | 20C |
| Yogurt | 40C | 43C | 46C |
| Kefir | 18C | 22C | 28C |

The "high" column is not a warning about safety. It is where the texture goes soft
before the flavor arrives, which is a different and more annoying failure.

## Failure Modes

### Kahm Yeast

A flat white film, wrinkled like skin on cooled milk. Harmless, and the single most
common reason a first-time fermenter throws out a good jar.

Skim it. Carry on. It means the surface is in contact with air, which is a mechanical
problem and not a biological one.

### Mold

Fuzzy, colored, and raised. Not the same thing as kahm, and the difference is texture,
not color — blue kahm exists and white mold exists.

Discard the batch. There is no partial recovery from a jar with mold in it; the
hyphae reach much further than the visible growth.

### Soft Kraut

Almost always temperature. Occasionally salt. Never, in my experience, time.

```bash
# The check that settles it, run daily
python3 measure.py --jar 4 --ph --brine --temp

# Anything above 22C for more than six hours predicts soft kraut
# with about 80% accuracy on my data.
```

### Off Smells

Yeasty is fine. Sulfurous is fine for the first three days and a problem after.
Anything sharp, solventy, or resembling nail polish is a contamination and the batch
is done.

## Equipment That Actually Matters

You need a way to keep the vegetables under the brine, and a way to let gas out
without letting air in. Everything else is convenience.

- **Weights.** Glass, ceramic, or a brine-filled bag. Not a rock.
- **Airlock.** Optional but it removes the kahm problem entirely.
- **Scale.** The one non-negotiable item.
- **Thermometer.** A cheap probe is fine; a thermal logger is better.

A crock costs two hundred dollars and does nothing a wide-mouth jar does not do.

### Quick Reference

Three things to check before you walk away:
- The vegetables are under the brine.
- The airlock has water in it.
- The jar is out of the sun.

And the order of operations, which people reliably get backwards:
1. Weigh the vegetables.
2. Take a percentage for the salt.
3. Wait for a pH, not for a date.

## Timing

Time is not an ingredient. It is a proxy for acid production, and it is a bad proxy
because it ignores temperature entirely. A five-day ferment at 22C and a five-day
ferment at 15C are not the same ferment and are not close.

Ferment to a pH, not to a date.

## A Note on Records

Keep a log. Not because you will read it, but because the act of writing down the
temperature is the thing that makes you take the temperature.

The log that works is the one that fits on an index card per jar.
