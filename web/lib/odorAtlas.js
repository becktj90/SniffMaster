/**
 * odorAtlas.js — curated worldwide smell knowledge for the 20 on-device classes
 * plus multi-class "bouquet" signatures.
 *
 * Honesty: a BME688 is not a lab GC-MS. It cannot name a molecule. The atlas
 * maps the device's classifier scores and climate context to published indoor-air
 * odor families (EPA/WHO/ASHRAE indoor VOC literature, common household sources
 * worldwide). Associations are labeled as such — never as chemical detections.
 *
 * Sources are curated open knowledge, not scraped product databases.
 */

import { ODOR_NAMES } from "./homeInsights.js";

/** Per-class atlas entry. Indexes match firmware odorNames / ODOR_NAMES. */
export const ATLAS = [
  {
    id: "flatulence", name: "Flatulence", family: "sulfur / bio", tone: "poor",
    senses: ["sulfurous", "eggy", "pungent"],
    compounds: ["hydrogen sulfide", "methanethiol", "skatole"],
    sources: ["people", "pets", "drains"],
    regions: ["universal"],
    also: "Often overlaps with sulfur and garbage classes when drains or septic gas are involved.",
    tip: "Air the room. Persistent sulfur without people present points at drains or a gas appliance.",
  },
  {
    id: "musty", name: "Musty", family: "microbial / damp", tone: "fair",
    senses: ["earthy", "damp", "basement", "cork"],
    compounds: ["geosmin", "2-methylisoborneol", "MVOCs from mold"],
    sources: ["damp walls", "HVAC", "closets", "bathrooms"],
    regions: ["humid climates", "monsoon seasons", "coastal"],
    also: "Worldwide, musty air tracks long humidity more than a single mold species.",
    tip: "Check leaks, run a dehumidifier, and look behind furniture.",
  },
  {
    id: "cigarette", name: "Cigarette smoke", family: "combustion", tone: "bad",
    senses: ["smoky", "acrid", "stale tobacco"],
    compounds: ["nicotine residues", "acrolein", "fine particulates"],
    sources: ["smoking", "thirdhand residue on fabric"],
    regions: ["universal"],
    also: "Residue keeps off-gassing from curtains and upholstery for hours.",
    tip: "Ventilate. Wash soft surfaces if it lingers.",
  },
  {
    id: "alcohol", name: "Alcohol", family: "solvent / oxygenated", tone: "fair",
    senses: ["sharp", "sweet-solvent", "disinfectant"],
    compounds: ["ethanol", "isopropanol"],
    sources: ["hand sanitizer", "drinks", "wipes"],
    regions: ["universal"],
    also: "Brief spikes are common after cleaning or parties.",
    tip: "Ventilate briefly; check for a spill.",
  },
  {
    id: "cannabis", name: "Cannabis", family: "terpene / botanical", tone: "fair",
    senses: ["herbal", "skunky", "resinous"],
    compounds: ["terpenes (myrcene, limonene)", "related VOCs"],
    sources: ["smoking or vapor", "plant material"],
    regions: ["universal"],
    also: "Shares terpene notes with some cooking herbs and incense.",
    tip: "Ventilate.",
  },
  {
    id: "cleaning", name: "Cleaning products", family: "fragranced solvent", tone: "fair",
    senses: ["soapy", "citrus-cleaner", "chlorine", "fresh laundry"],
    compounds: ["limonene", "pinene", "glycol ethers", "chlorine byproducts"],
    sources: ["sprays", "mops", "bleach", "all-purpose cleaners"],
    regions: ["universal"],
    also: "Mixing bleach with ammonia or acids creates dangerous gases — never mix.",
    tip: "Ventilate while products dry. Do not mix cleaners.",
  },
  {
    id: "gasoline", name: "Gasoline", family: "petroleum", tone: "bad",
    senses: ["petrol", "sharp hydrocarbon"],
    compounds: ["BTEX aromatics", "alkanes"],
    sources: ["garage", "lawn equipment", "fuel cans"],
    regions: ["universal"],
    also: "Treat as a safety smell — find the source.",
    tip: "Find the source and ventilate. Keep fuel outdoors.",
  },
  {
    id: "smoke", name: "Smoke", family: "combustion", tone: "bad",
    senses: ["burning", "woodsmoke", "acrid"],
    compounds: ["acrolein", "fine soot", "PAHs"],
    sources: ["cooking fire", "candles", "wildfire intrusion", "fireplace"],
    regions: ["wildfire seasons", "winter heating"],
    also: "Outdoor wildfire smoke can track indoor AQI rises.",
    tip: "Check for something burning. Close windows if outdoor AQI is high.",
  },
  {
    id: "cooking", name: "Cooking", family: "food / Maillard", tone: "fair",
    senses: ["savory", "fried", "onion", "spice"],
    compounds: ["aldehydes", "fatty acids", "Maillard volatiles"],
    sources: ["stove", "oven", "wok", "grill"],
    regions: ["worldwide kitchens", "spice-forward cooking"],
    also: "High heat oil cooking and spice toasting raise VOC and temperature together.",
    tip: "Run the range hood and open a window.",
  },
  {
    id: "coffee", name: "Coffee", family: "roasted / pleasant", tone: "good",
    senses: ["roasted", "bitter-sweet", "nutty"],
    compounds: ["furans", "pyrazines"],
    sources: ["brewing", "grinding"],
    regions: ["universal"],
    also: "Usually benign; strong scores without brewing can be burnt food.",
    tip: "Enjoy — or check the toaster if nothing is brewing.",
  },
  {
    id: "garbage", name: "Garbage", family: "putrid / bio", tone: "poor",
    senses: ["rotten", "bin", "sour trash"],
    compounds: ["amines", "organic acids", "sulfides"],
    sources: ["kitchen bin", "compost", "drains"],
    regions: ["universal", "hot climates accelerate it"],
    also: "Heat speeds microbial breakdown of food waste.",
    tip: "Take the trash out and check the bin and drains.",
  },
  {
    id: "body", name: "Body odor", family: "human / bio", tone: "fair",
    senses: ["sweaty", "sour fabric"],
    compounds: ["short-chain fatty acids", "isovaleric acid"],
    sources: ["people", "gym clothes", "bedding"],
    regions: ["universal"],
    also: "Often rises with occupancy and temperature.",
    tip: "Air the room and wash recent bedding or clothes.",
  },
  {
    id: "perfume", name: "Perfume", family: "fragrance", tone: "good",
    senses: ["floral", "sweet", "cosmetic"],
    compounds: ["fragrance terpenes", "musks"],
    sources: ["perfume", "body spray", "scented lotion"],
    regions: ["universal"],
    also: "Benign for most people; can bother fragrance-sensitive households.",
    tip: "Air briefly if anyone is sensitive.",
  },
  {
    id: "laundry", name: "Laundry", family: "fragrance / detergent", tone: "good",
    senses: ["fresh linen", "detergent", "fabric softener"],
    compounds: ["fragrance esters", "residual detergent VOCs"],
    sources: ["dryer", "hanging clothes", "laundry room"],
    regions: ["universal"],
    also: "Damp laundry left in a machine can flip toward musty.",
    tip: "Move damp clothes promptly if humidity is high.",
  },
  {
    id: "sulfur", name: "Sulfur / rotten egg", family: "sulfur", tone: "bad",
    senses: ["rotten egg", "sewer", "gas"],
    compounds: ["hydrogen sulfide", "mercaptans"],
    sources: ["drains", "water heater", "natural gas odorant", "septic"],
    regions: ["universal", "well-water areas"],
    also: "Gas utilities add mercaptans so leaks smell like sulfur.",
    tip: "Check drains and gas appliances. If you smell gas, leave and call your utility.",
  },
  {
    id: "solvent", name: "Solvent", family: "solvent / industrial", tone: "poor",
    senses: ["paint thinner", "glue", "sharp chemical"],
    compounds: ["ketones", "aromatic solvents", "glycols"],
    sources: ["paint", "adhesives", "markers", "hobby supplies"],
    regions: ["universal"],
    also: "New furniture and renovations off-gas for days.",
    tip: "Ventilate and keep the product sealed.",
  },
  {
    id: "pet", name: "Pet / litter", family: "animal / ammonia", tone: "fair",
    senses: ["ammonia", "litter", "wet fur"],
    compounds: ["ammonia", "amines"],
    sources: ["litter boxes", "pet bedding", "accidents"],
    regions: ["universal"],
    also: "Humidity and warm rooms make ammonia more noticeable.",
    tip: "Scoop the litter box and open a window.",
  },
  {
    id: "sour", name: "Sour food", family: "fermentation / spoilage", tone: "poor",
    senses: ["sour", "vinegar", "spoiled dairy"],
    compounds: ["acetic acid", "butyric acid"],
    sources: ["fridge", "forgotten food", "compost"],
    regions: ["universal", "hot kitchens"],
    also: "Often pairs with garbage when food waste sits out.",
    tip: "Look for spoiled food and check the fridge and bin.",
  },
  {
    id: "burnt", name: "Burnt / oil", family: "pyrolysis", tone: "poor",
    senses: ["burnt toast", "hot oil", "overheated dust"],
    compounds: ["acrolein", "char volatiles"],
    sources: ["stove", "oven", "toaster", "HVAC dust"],
    regions: ["universal"],
    also: "First heat of the season can burn dust on heaters.",
    tip: "Check the stove, oven, and toaster.",
  },
  {
    id: "citrus", name: "Citrus", family: "terpene / pleasant", tone: "good",
    senses: ["lemon", "orange peel", "bright"],
    compounds: ["limonene", "citral"],
    sources: ["fruit", "cleaners", "diffusers"],
    regions: ["universal"],
    also: "Limonene can react with ozone to form secondary particles outdoors/in.",
    tip: "Usually pleasant; ventilate if from strong cleaners.",
  },
];

/**
 * Multi-class bouquet signatures inspired by common indoor atmospheres worldwide.
 * Each blend scores from several odor classes + optional climate gates.
 */
export const BOUQUETS = [
  {
    id: "incense", label: "Incense / ritual smoke",
    why: "Resinous smoke notes common in homes that burn incense or joss sticks.",
    regions: ["South Asia", "East Asia", "Middle East", "ceremony spaces"],
    of: [[7, 0.45], [4, 0.25], [12, 0.2], [18, 0.15]],
  },
  {
    id: "spice_kitchen", label: "Spice-forward cooking",
    why: "Savory cooking with herbal or toasted spice notes.",
    regions: ["worldwide kitchens", "South Asian / Latin / Mediterranean cooking"],
    of: [[8, 0.55], [4, 0.2], [18, 0.15], [19, 0.1]],
  },
  {
    id: "monsoon_damp", label: "Monsoon / humid must",
    why: "Damp-earth character when the air has stayed humid.",
    regions: ["tropical", "monsoon", "coastal"],
    of: [[1, 0.7], [10, 0.15], [17, 0.15]],
    need: { humidityMin: 60 },
  },
  {
    id: "garage_petrol", label: "Garage / workshop",
    why: "Petroleum and solvent notes that often drift from an attached garage.",
    regions: ["homes with attached garages"],
    of: [[6, 0.5], [15, 0.35], [7, 0.15]],
  },
  {
    id: "new_renovation", label: "New paint / renovation",
    why: "Sharp solvent and fragrance leftover from paint, glue, or new finishes.",
    regions: ["universal after renovations"],
    of: [[15, 0.5], [5, 0.25], [12, 0.15], [19, 0.1]],
  },
  {
    id: "sewer_drain", label: "Drain / sewer gas",
    why: "Sulfur plus garbage notes that point at a dry trap or drain, not food.",
    regions: ["universal"],
    of: [[14, 0.55], [0, 0.2], [10, 0.25]],
  },
  {
    id: "thirdhand_smoke", label: "Stale smoke residue",
    why: "Smoky notes that linger after the active smoke class fades.",
    regions: ["universal"],
    of: [[2, 0.55], [7, 0.3], [11, 0.15]],
  },
  {
    id: "litter_ammonia", label: "Litter ammonia bloom",
    why: "Pet/litter with a sharp edge, stronger in warm damp air.",
    regions: ["homes with cats"],
    of: [[16, 0.7], [11, 0.15], [10, 0.15]],
    need: { humidityMin: 45 },
  },
  {
    id: "bakery_roast", label: "Roast / bakery",
    why: "Coffee and cooking together — roasting, toasting, or baking.",
    regions: ["universal"],
    of: [[9, 0.45], [8, 0.35], [18, 0.2]],
  },
  {
    id: "spa_clean", label: "Spa / citrus clean",
    why: "Cleaning, citrus, and laundry fragrance after a tidy-up.",
    regions: ["universal"],
    of: [[5, 0.4], [19, 0.3], [13, 0.3]],
  },
  {
    id: "wildfire_drift", label: "Outdoor smoke drift",
    why: "Smoke character while outdoor air is dirty — windows may be leaking smoke in.",
    regions: ["wildfire seasons"],
    of: [[7, 0.6], [2, 0.25], [18, 0.15]],
    need: { outdoorAqiMin: 100 },
  },
  {
    id: "compost_bin", label: "Compost / food waste",
    why: "Garbage and sour-food together, common near compost or hot kitchen bins.",
    regions: ["universal", "hot climates"],
    of: [[10, 0.5], [17, 0.4], [1, 0.1]],
  },
];

function scoreOf(odors, i) {
  const v = Number(odors?.[i]);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

/** Rank every device class with atlas context. */
export function rankOdors(odors, { min = 8 } = {}) {
  return ATLAS.map((entry, i) => {
    const score = scoreOf(odors, i);
    return {
      index: i,
      score: Math.round(score),
      active: score >= min,
      strong: score >= 65,
      name: entry.name,
      family: entry.family,
      tone: entry.tone,
      senses: entry.senses,
      compounds: entry.compounds,
      sources: entry.sources,
      regions: entry.regions,
      also: entry.also,
      tip: entry.tip,
      label: ODOR_NAMES[i] || entry.name,
    };
  }).sort((a, b) => b.score - a.score);
}

/** Score worldwide bouquet signatures from the live class vector + climate. */
export function rankBouquets(odors, climate = {}) {
  const rh = Number(climate.humidity);
  const aqi = Number(climate.outdoorAqi);
  return BOUQUETS.map((b) => {
    if (b.need?.humidityMin != null && !(Number.isFinite(rh) && rh >= b.need.humidityMin)) {
      return null;
    }
    if (b.need?.outdoorAqiMin != null && !(Number.isFinite(aqi) && aqi >= b.need.outdoorAqiMin)) {
      return null;
    }
    let score = 0;
    let weight = 0;
    for (const [idx, w] of b.of) {
      score += scoreOf(odors, idx) * w;
      weight += w;
    }
    const v = weight ? score / weight : 0;
    if (v < 18) return null;
    return {
      id: b.id,
      label: b.label,
      why: b.why,
      regions: b.regions,
      score: Math.round(v),
      strength: v >= 55 ? "strong" : v >= 35 ? "likely" : "hint",
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

export function atlasHonesty() {
  return "SniffMaster maps gas fingerprints to smell families used in indoor-air science. It does not identify molecules the way a lab analyzer does. Compound names are common associations for that smell family, not a chemical assay.";
}
