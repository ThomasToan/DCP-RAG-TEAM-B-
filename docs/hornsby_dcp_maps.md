# Restriction maps in the Hornsby DCP 2024

Every map in the DCP that draws an area or a line where special controls apply. Found by reading all 217 figure
captions from the PDF's text layer (`hdcp-2024.pdf`, 489 pages), then looking at each candidate page. "PDF page" is the
page number in the PDF, not the number printed on the page.

**How an address can be placed on each map**

- **Zone data**: the area is defined by the land zone, which the app already gets from NSW planning data. No map
  reading needed.
- **NSW boundary**: NSW publishes the same boundary as data. Aligning the two calibrates the picture, so the app can
  draw the property as a dot on the map and the AI reads where the dot falls (tested on Figure 9.7-a: 26 of 26 correct).
- **DCP only**: the boundary exists only in the DCP picture. The map must be calibrated from known points such as
  street intersections. Street names printed on the map make this practical.

## 1. Areas defined by zone (already covered by NSW zone data)

| PDF page | Figure | What it shows |
|---|---|---|
| 63 | 2-a | The Rural Area of Hornsby Shire (where Part 2 Rural applies) |
| 111 | 3-a | Hornsby Housing Strategy Precincts (mixed use / high density, town house redevelopment) |
| 360 | 7.5-a | Health Services Facility Precinct (land zoned SP2 Health Services Facility, Hornsby) |
| 368 | 8-a | River Settlements of Hornsby Shire (where Part 8 applies) |

## 2. Heritage conservation areas (NSW boundary)

| PDF page | Figure | Area | Precincts inside (DCP only) | Street names |
|---|---|---|---|---|
| 440 | 9.7-a | Beecroft-Cheltenham HCA | Northern Triangle, Beecroft North, Beecroft Heritage Town Centre, Beecroft Cheltenham Plateau, The Gullies | No |
| 449 | 9.8-a | Hornsby West Side HCA | Peat Ferry Road, Mount Errington, Pretoria Parade | Yes |
| 456 | 9.9-a | The Crescent, Pennant Hills HCA | none | Yes |
| 459 | 9.10-a | Wahroonga HCA | none | Yes |
| 462 | 9.11-a | Wahroonga North HCA | Northern Precinct, Southern Precinct | Yes |
| 465 | 9.12-a | Barker College HCA | none | Yes |

## 3. Hornsby Town Centre (DCP only)

| PDF page | Figure | What it controls | Street names |
|---|---|---|---|
| 37 | 1.3-b | Parking rate tiers (Tier 1 / Tier 2) | No |
| 272 | 4.5-a | Town Centre boundary and its six planning precincts | No |
| 281 | 4.5-i | Gateways, arrival and feature points | No |
| 282 | 4.5-j | View corridors | No |
| 283 | 4.5-k | Active frontages | Yes |
| 284 | 4.5-l | Heritage and facade retention | Yes |
| 287 | 4.5-m | Building height strategy (storeys per site) | Yes |
| 290 | 4.5-o | Podium heights | Yes |
| 291 | 4.5-p | Primary ground floor setbacks | Yes |
| 292 | 4.5-q | Primary ground floor setbacks, Western Heritage Precinct | Yes |
| 293 | 4.5-r | Secondary above-podium setbacks | Yes |
| 294 | 4.5-s | Above-podium setbacks and podium heights, Western Heritage Precinct | Yes |
| 300 | 4.5-t | Access routes | Yes |
| 301 | 4.5-u | Public car parking | Yes |
| 303 | 4.5-v | Awnings | Yes |
| 307 | 4.5-aa | Movement and place | No |
| 309 | 4.5-bb | Traffic management projects | Yes |
| 311 | 4.5-cc | Open space | Some |

## 4. Centre setbacks (DCP only)

| PDF page | Figure | Centre | Street names |
|---|---|---|---|
| 219 | 4.2-b | Berowra Heights | Faint |
| 219 | 4.2-c | Dural Service Centre | Faint |
| 220 | 4.2-d | Hornsby (Bridge Road) | Yes |
| 220 | 4.2-e | Hornsby (Romsey Street) | Faint |
| 221 | 4.2-f | Pennant Hills | Faint |
| 222 | 4.2-g | Thornleigh | Faint |
| 223 | 4.2-h | Waitara | Yes |

## 5. Mixed use precincts (DCP only)

| PDF page | Figure | Precincts (one inset map each) | Street names |
|---|---|---|---|
| 245 | 4.4-a | Asquith Commercial Centre; Bouvardia Street, Asquith; Palmerston Road, Waitara; Normanhurst Road, Normanhurst; Pennant Hills Road, Thornleigh; Thompsons Corner, West Pennant Hills; Beecroft Heritage Precinct | Yes (small) |

## 6. Industrial land (DCP only)

| PDF page | Figure | What it shows | Street names |
|---|---|---|---|
| 322 | 5.1-b | Potentially significant flora and fauna habitat, industrial land at Mount Kuring-gai | No |
| 322 | 5.1-c | Potentially significant flora and fauna habitat, industrial land at Asquith/Hornsby | Some |

## 7. River settlements (DCP only)

| PDF page | Figure | What it shows | Labels |
|---|---|---|---|
| 373 | 8.1-b | Rear building limit, Berowra Waters | Waterway names, lot numbers |
| 374 | 8.1-c | Rear building limit, Calabash Point | Waterway names, lot numbers |
| 375 | 8.1-d | Rear building limit, Coba Point | Waterway names, lot numbers |
| 376 | 8.1-e | Rear building limit, Marra Marra Creek | Waterway names, lot numbers |
| 377 | 8.1-f | Rear building limit, Milsons Passage | Waterway names, lot numbers |
| 378 | 8.1-g | Rear building limit, Neverfail Bay | Waterway names, lot numbers |
| 379 | 8.1-h | Rear building limit, Sunny Corner | Waterway names, lot numbers |
| 388 | 8.2-b | Private waterway structure limits, Dangar Island | Some street names |
| 389 | 8.2-c | Jetty limits, Brooklyn | Street names |
| 390 | 8.2-d | Jetty limits, Brooklyn | Street names |

## 8. State policy area

| PDF page | Figure | What it shows | Notes |
|---|---|---|---|
| 99 | 2.5-a | Resources and Energy SEPP locality, Maroota (extractive industries) | A State policy map; NSW may publish it as data (not checked) |

## Maps that are not restriction areas

Traffic management improvement plans (PDF pages 143, 176, 186, 230, 264), Dural Service Centre traffic management
strategy (231, 232, 325, 326), the commercial centres hierarchy (215, a table), and the Town Centre precinct
illustrations (273 to 276). All other figures are diagrams (setbacks, heights, roof forms, example buildings).

## Totals

49 restriction maps: 4 defined by zone, 6 heritage areas with an NSW boundary, 38 that exist only in the DCP, and 1
State policy map.

## Calibration status

Calibrated so far (`src/lib/server/dcp_maps.json`, made by `scripts/calibrate_maps.py` from `scripts/dcp_map_spec.json`),
each checked by drawing NSW road centrelines over the picture:

- All 6 heritage conservation area maps (section 2).
- 15 of the 18 Hornsby Town Centre maps (section 3): all except Figures 4.5-l, 4.5-q and 4.5-s (PDF pages 284, 292,
  294), which are zoomed-in views of the Western Heritage Precinct without the full Town Centre boundary.

Not yet calibrated: sections 4 to 8 (centre setbacks, mixed use precincts, industrial habitat, river settlements, the
SEPP map) and the three Western Heritage Precinct close-ups.

How the app uses them: heritage maps (only when NSW data puts the property in that area), the parking tier map and the
precinct map go with the first message, with the property drawn as a magenta dot. Any other calibrated map is marked
when a search returns its page.
