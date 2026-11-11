// The hidden maple leaves: one at each of these real places all over the Lower Mainland, grouped by area for the
// panel's completion bars. [name, lat, lon, sea?]: land leaves settle on the nearest street or path when their map
// tile loads, sea leaves (1) on the nearest open water, so a few dozen metres of error here don't matter.
// Never reorder or delete an entry: a leaf's id is `${area index}.${index}` in the player's save. Append only.
export const AREAS = [
  ['Downtown', [
    ['Gastown Steam Clock', 49.2844, -123.1089], ['Canada Place', 49.2872, -123.1128], ['Robson Square', 49.2822, -123.1212],
    ['Harbour Centre', 49.2846, -123.1117], ['The Olympic Cauldron', 49.2892, -123.1178], ['Dr. Sun Yat-Sen Garden', 49.2797, -123.1040],
    ['BC Place', 49.2790, -123.1105], ['Science World', 49.2728, -123.1020], ['The English Bay Inukshuk', 49.2846, -123.1437],
    ['A-maze-ing Laughter', 49.2876, -123.1419], ['The Yaletown Roundhouse', 49.2735, -123.1218], ['Library Square', 49.2790, -123.1145],
    ['CRAB Park', 49.2853, -123.1015], ['Sunset Beach', 49.2797, -123.1380],
  ]],
  ['Stanley Park', [
    ['The totem poles', 49.2993, -123.1210], ['The Nine O’Clock Gun', 49.2981, -123.1173], ['Brockton Point lighthouse', 49.3008, -123.1172],
    ['Prospect Point', 49.3137, -123.1418], ['Siwash Rock lookout', 49.30809, -123.15503], ['Third Beach', 49.3030, -123.1565],
    ['Second Beach', 49.2952, -123.1510], ['Lost Lagoon', 49.2955, -123.1410], ['The Hollow Tree', 49.3060, -123.1535],
    ['Girl in a Wetsuit', 49.3027, -123.1265], ['Beaver Lake', 49.3040, -123.1385],
  ]],
  ['West Side & UBC', [
    ['Kitsilano Beach', 49.2745, -123.1535], ['Kits Pool', 49.2753, -123.1575], ['The planetarium’s crab', 49.2763, -123.1445],
    ['Granville Island market', 49.2716, -123.1350], ['Jericho Beach', 49.2727, -123.1930], ['Locarno Beach', 49.2760, -123.2085],
    ['Spanish Banks', 49.2775, -123.2250], ['The UBC Rose Garden', 49.2694, -123.2565], ['Museum of Anthropology', 49.2688, -123.2590],
    ['Wreck Beach', 49.26223, -123.26153], ['The UBC clock tower', 49.2675, -123.2545], ['Camosun Bog', 49.2530, -123.1975],
    ['Queen Elizabeth Park lookout', 49.2418, -123.1126], ['VanDusen Garden', 49.2390, -123.1300], ['City Hall', 49.2607, -123.1139],
    ['Fraser River Park', 49.2052, -123.1475],
  ]],
  ['East Van', [
    ['Grandview Park on the Drive', 49.2755, -123.0695], ['Trout Lake', 49.2555, -123.0625], ['Playland’s wooden coaster', 49.2813, -123.0415],
    ['New Brighton Park', 49.2905, -123.0365], ['Dude Chilling Park', 49.2640, -123.0965], ['The Punjabi Market', 49.2255, -123.1010],
    ['Everett Crowley Park', 49.2125, -123.0300], ['The East Van cross', 49.2665, -123.0795], ['Strathcona Park', 49.2755, -123.0850],
  ]],
  ['North Vancouver', [
    ['Lonsdale Quay', 49.3100, -123.0825], ['The Shipyards', 49.3095, -123.0790], ['Capilano Suspension Bridge', 49.3429, -123.1149],
    ['Cleveland Dam', 49.3605, -123.1105], ['The foot of the Grouse Grind', 49.37109, -123.0982], ['The Grouse chalet', 49.37897, -123.0833],
    ['Lynn Canyon suspension bridge', 49.3435, -123.0180], ['Deep Cove', 49.3290, -122.9485], ['Quarry Rock', 49.3337, -122.93659],
    ['Maplewood Flats', 49.3045, -123.0010], ['Cates Park', 49.3020, -122.9560], ['Mount Seymour', 49.3675, -122.9490],
    ['Dog Mountain', 49.37373, -122.97043], ['Rice Lake', 49.3565, -123.0150],
  ]],
  ['West Vancouver', [
    ['Ambleside Beach', 49.3235, -123.1525], ['Dundarave Pier', 49.3340, -123.1855], ['Lighthouse Park', 49.33153, -123.26449],
    ['Horseshoe Bay', 49.3745, -123.2725], ['Whytecliff Park', 49.3725, -123.2905], ['The Cypress lookout', 49.3560, -123.2010],
    ['Cypress Mountain', 49.3960, -123.2045], ['Caulfeild Cove', 49.3385, -123.2530], ['Lions Bay', 49.4550, -123.2360],
  ]],
  ['Burnaby & New West', [
    ['Kamui Mintara on Burnaby Mountain', 49.2830, -122.9340], ['SFU', 49.2787, -122.9235], ['Deer Lake', 49.2360, -122.9730],
    ['Burnaby Village Museum', 49.2400, -122.9730], ['Metrotown', 49.2260, -123.0030], ['Central Park', 49.2275, -123.0180],
    ['Piper Spit on Burnaby Lake', 49.2475, -122.9395], ['Barnet Marine Park', 49.2905, -122.9265], ['Brentwood', 49.2665, -123.0005],
    ['Confederation Park', 49.2860, -123.0010], ['Burnaby Fraser Foreshore', 49.1940, -122.9990], ['New West Quay', 49.2005, -122.9125],
    ['Queen’s Park', 49.2130, -122.9060],
  ]],
  ['Tri-Cities & Ridge Meadows', [
    ['Rocky Point Park', 49.2800, -122.8495], ['White Pine Beach', 49.3235, -122.8870], ['Buntzen Lake', 49.3370, -122.8590],
    ['Lafarge Lake', 49.2860, -122.7890], ['Mundy Park', 49.2565, -122.8250], ['Colony Farm', 49.2356, -122.8076],
    ['Downtown Port Coquitlam', 49.2625, -122.7810], ['Minnekhada', 49.3010, -122.7090], ['Grant Narrows on Pitt Lake', 49.3490, -122.6160],
    ['Port Haney wharf', 49.2150, -122.6030], ['Kanaka Creek', 49.2030, -122.5600], ['Alouette Lake', 49.2895, -122.4865],
  ]],
  ['Richmond', [
    ['Steveston wharf', 49.1245, -123.1845], ['Garry Point', 49.1255, -123.1930], ['Britannia Shipyards', 49.1215, -123.1660],
    ['The Olympic Oval', 49.1745, -123.1515], ['Iona Beach', 49.2200, -123.2130], ['YVR', 49.1965, -123.1840],
    ['Flight Path Park', 49.1835, -123.1575], ['Terra Nova', 49.1745, -123.1990], ['Minoru Park', 49.1650, -123.1440],
    ['The Night Market', 49.1965, -123.1280], ['The Buddhist temple', 49.1335, -123.1235], ['Finn Slough', 49.1205, -123.1005],
  ]],
  ['Delta', [
    ['Tsawwassen ferry terminal', 49.0085, -123.1300], ['Centennial Beach', 49.0170, -123.0420], ['Ladner Village', 49.0900, -123.0825],
    ['Reifel Bird Sanctuary', 49.0985, -123.1790], ['Deas Island', 49.1230, -123.0590], ['Burns Bog', 49.1480, -122.9330],
    ['Watershed Park', 49.1180, -122.9050],
  ]],
  ['Surrey, White Rock & Langley', [
    ['White Rock Pier', 49.0195, -122.8050], ['Crescent Beach', 49.0560, -122.8830], ['The Peace Arch', 49.0022, -122.7565],
    ['Surrey Central', 49.1915, -122.8490], ['Bear Creek Park', 49.1600, -122.8400], ['Green Timbers', 49.1780, -122.8250],
    ['Tynehead Park', 49.1790, -122.7600], ['The Barnston Island ferry', 49.1960, -122.7250], ['Fort Langley', 49.1685, -122.5800],
    ['Cloverdale', 49.1080, -122.7350], ['Redwood Park', 49.0340, -122.7240], ['Mud Bay', 49.0880, -122.8620],
    ['Brownsville Bar', 49.2045, -122.8900], ['Campbell Valley', 49.0180, -122.6560],
  ]],
  ['On the water', [
    ['Under the Lions Gate', 49.3150, -123.1385, 1], ['Off Siwash Rock', 49.3092, -123.1580, 1], ['Among the freighters', 49.2950, -123.1900, 1],
    ['False Creek', 49.2698, -123.1265, 1], ['Coal Harbour', 49.2930, -123.1240, 1], ['Off Kits Point', 49.2800, -123.1500, 1],
    ['Off Jericho', 49.2795, -123.1950, 1], ['Off Ambleside', 49.3190, -123.1500, 1], ['Point Atkinson', 49.3285, -123.2660, 1],
    ['The Point Grey bell buoy', 49.2850, -123.2650, 1], ['Second Narrows', 49.2955, -123.0265, 1], ['Indian Arm off Deep Cove', 49.3270, -122.9400, 1],
    ['Port Moody Arm', 49.2935, -122.8700, 1],
  ]],
]
