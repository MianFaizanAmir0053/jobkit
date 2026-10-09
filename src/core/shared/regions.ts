/**
 * The shared region table (extraction spec, "Shared vocabularies"): names,
 * aliases and major cities mapped to place codes, which are ISO 3166-1
 * country codes plus region codes with their member countries. Extraction,
 * the profile seed and eligibility all use this one table, so a post's "UK"
 * meets the profile's GB, and Germany meets an EU entry.
 */

/** Code, English name, then aliases and cities, separated by "|". */
const COUNTRIES = `
AD|Andorra
AE|United Arab Emirates|uae|emirates|dubai|abu dhabi|sharjah
AF|Afghanistan
AG|Antigua and Barbuda
AI|Anguilla
AL|Albania
AM|Armenia
AO|Angola
AQ|Antarctica
AR|Argentina|buenos aires
AS|American Samoa
AT|Austria|vienna
AU|Australia|sydney|melbourne
AW|Aruba
AX|Åland Islands
AZ|Azerbaijan
BA|Bosnia and Herzegovina|bosnia
BB|Barbados
BD|Bangladesh|dhaka
BE|Belgium|brussels
BF|Burkina Faso
BG|Bulgaria|sofia
BH|Bahrain|manama
BI|Burundi
BJ|Benin
BL|Saint Barthélemy
BM|Bermuda
BN|Brunei
BO|Bolivia
BQ|Caribbean Netherlands
BR|Brazil|sao paulo
BS|Bahamas
BT|Bhutan
BV|Bouvet Island
BW|Botswana
BY|Belarus
BZ|Belize
CA|Canada|toronto|vancouver|montreal
CC|Cocos (Keeling) Islands
CD|Democratic Republic of the Congo|dr congo|drc
CF|Central African Republic
CG|Republic of the Congo|congo
CH|Switzerland|zurich|geneva
CI|Côte d'Ivoire|ivory coast
CK|Cook Islands
CL|Chile
CM|Cameroon
CN|China|beijing|shanghai|shenzhen
CO|Colombia|bogota
CR|Costa Rica
CU|Cuba
CV|Cabo Verde|cape verde
CW|Curaçao
CX|Christmas Island
CY|Cyprus|limassol
CZ|Czechia|czech republic|prague
DE|Germany|berlin|munich|hamburg|frankfurt
DJ|Djibouti
DK|Denmark|copenhagen
DM|Dominica
DO|Dominican Republic
DZ|Algeria
EC|Ecuador
EE|Estonia|tallinn
EG|Egypt|cairo
EH|Western Sahara
ER|Eritrea
ES|Spain|madrid|barcelona
ET|Ethiopia
FI|Finland|helsinki
FJ|Fiji
FK|Falkland Islands
FM|Micronesia
FO|Faroe Islands
FR|France|paris
GA|Gabon
GB|United Kingdom|uk|great britain|britain|england|scotland|wales|northern ireland|london|manchester|edinburgh
GD|Grenada
GE|Georgia|tbilisi
GF|French Guiana
GG|Guernsey
GH|Ghana
GI|Gibraltar
GL|Greenland
GM|Gambia
GN|Guinea
GP|Guadeloupe
GQ|Equatorial Guinea
GR|Greece|athens
GS|South Georgia and the South Sandwich Islands
GT|Guatemala
GU|Guam
GW|Guinea-Bissau
GY|Guyana
HK|Hong Kong
HM|Heard Island and McDonald Islands
HN|Honduras
HR|Croatia|zagreb
HT|Haiti
HU|Hungary|budapest
ID|Indonesia|jakarta
IE|Ireland|dublin
IL|Israel|tel aviv
IM|Isle of Man
IN|India|bangalore|bengaluru|mumbai|delhi|new delhi|pune|chennai
IO|British Indian Ocean Territory
IQ|Iraq
IR|Iran
IS|Iceland
IT|Italy|rome|milan
JE|Jersey
JM|Jamaica
JO|Jordan|amman
JP|Japan|tokyo
KE|Kenya|nairobi
KG|Kyrgyzstan
KH|Cambodia
KI|Kiribati
KM|Comoros
KN|Saint Kitts and Nevis
KP|North Korea
KR|South Korea|korea|seoul
KW|Kuwait|kuwait city
KY|Cayman Islands
KZ|Kazakhstan
LA|Laos
LB|Lebanon|beirut
LC|Saint Lucia
LI|Liechtenstein
LK|Sri Lanka|colombo
LR|Liberia
LS|Lesotho
LT|Lithuania|vilnius
LU|Luxembourg
LV|Latvia|riga
LY|Libya
MA|Morocco
MC|Monaco
MD|Moldova
ME|Montenegro
MF|Saint Martin
MG|Madagascar
MH|Marshall Islands
MK|North Macedonia|macedonia
ML|Mali
MM|Myanmar|burma
MN|Mongolia
MO|Macao|macau
MP|Northern Mariana Islands
MQ|Martinique
MR|Mauritania
MS|Montserrat
MT|Malta
MU|Mauritius
MV|Maldives
MW|Malawi
MX|Mexico|mexico city
MY|Malaysia|kuala lumpur
MZ|Mozambique
NA|Namibia
NC|New Caledonia
NE|Niger
NF|Norfolk Island
NG|Nigeria|lagos
NI|Nicaragua
NL|Netherlands|the netherlands|holland|amsterdam|rotterdam
NO|Norway|oslo
NP|Nepal|kathmandu
NR|Nauru
NU|Niue
NZ|New Zealand|auckland
OM|Oman|muscat
PA|Panama
PE|Peru|lima
PF|French Polynesia
PG|Papua New Guinea
PH|Philippines|manila
PK|Pakistan|lahore|karachi|islamabad|rawalpindi|faisalabad|multan|peshawar
PL|Poland|warsaw|krakow
PM|Saint Pierre and Miquelon
PN|Pitcairn Islands
PR|Puerto Rico
PS|Palestine
PT|Portugal|lisbon|porto
PW|Palau
PY|Paraguay
QA|Qatar|doha
RE|Réunion
RO|Romania|bucharest
RS|Serbia|belgrade
RU|Russia|russian federation|moscow
RW|Rwanda
SA|Saudi Arabia|ksa|riyadh|jeddah|dammam
SB|Solomon Islands
SC|Seychelles
SD|Sudan
SE|Sweden|stockholm
SG|Singapore
SH|Saint Helena
SI|Slovenia
SJ|Svalbard and Jan Mayen
SK|Slovakia
SL|Sierra Leone
SM|San Marino
SN|Senegal
SO|Somalia
SR|Suriname
SS|South Sudan
ST|São Tomé and Príncipe
SV|El Salvador
SX|Sint Maarten
SY|Syria
SZ|Eswatini|swaziland
TC|Turks and Caicos Islands
TD|Chad
TF|French Southern Territories
TG|Togo
TH|Thailand|bangkok
TJ|Tajikistan
TK|Tokelau
TL|Timor-Leste|east timor
TM|Turkmenistan
TN|Tunisia
TO|Tonga
TR|Türkiye|turkey|istanbul
TT|Trinidad and Tobago
TV|Tuvalu
TW|Taiwan|taipei
TZ|Tanzania
UA|Ukraine|kyiv|kiev
UG|Uganda
UM|United States Minor Outlying Islands
US|United States|usa|united states of america|america|us|new york|new york city|nyc|san francisco|bay area|seattle|austin|boston|los angeles|chicago
UY|Uruguay
UZ|Uzbekistan
VA|Vatican City|holy see
VC|Saint Vincent and the Grenadines
VE|Venezuela
VG|British Virgin Islands
VI|U.S. Virgin Islands
VN|Vietnam|viet nam|ho chi minh city|hanoi
VU|Vanuatu
WF|Wallis and Futuna
WS|Samoa
XK|Kosovo
YE|Yemen
YT|Mayotte
ZA|South Africa|cape town|johannesburg
ZM|Zambia
ZW|Zimbabwe
`;

const EU = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE";

/**
 * Regions with their member countries. A region whose membership is
 * ambiguous has none: whether it takes in Pakistan cannot be said, so
 * eligibility reports it as unclear (extraction spec, stage `eligibility`).
 */
const REGIONS: readonly { code: string; name: string; members: string | null; aliases: readonly string[] }[] = [
  { code: "WORLDWIDE", name: "Worldwide", members: "*", aliases: ["anywhere", "global", "anywhere in the world"] },
  { code: "EU", name: "European Union", members: EU, aliases: [] },
  { code: "EEA", name: "European Economic Area", members: `${EU} IS LI NO`, aliases: [] },
  {
    code: "EUROPE",
    name: "Europe",
    members: `${EU} GB NO CH IS LI UA MD BY RS BA ME MK AL XK AD MC SM VA GI FO GG JE IM AX SJ RU`,
    aliases: [],
  },
  { code: "GCC", name: "Gulf Cooperation Council", members: "AE BH KW OM QA SA", aliases: ["gulf", "the gulf", "gulf countries"] },
  {
    code: "MIDDLE_EAST",
    name: "Middle East",
    members: "AE BH KW OM QA SA YE IQ IR JO LB SY IL PS EG TR CY",
    aliases: [],
  },
  { code: "SOUTH_ASIA", name: "South Asia", members: "AF BD BT IN LK MV NP PK", aliases: [] },
  { code: "NORTH_AMERICA", name: "North America", members: "US CA MX", aliases: [] },
  {
    code: "LATAM",
    name: "Latin America",
    members: "AR BO BR CL CO CR CU DO EC SV GT HN MX NI PA PY PE PR UY VE",
    aliases: [],
  },
  { code: "EMEA", name: "Europe, the Middle East and Africa", members: null, aliases: [] },
  { code: "MENA", name: "Middle East and North Africa", members: null, aliases: [] },
  {
    // The IMF's grouping, which includes Pakistan.
    code: "MENAP",
    name: "Middle East, North Africa, Afghanistan and Pakistan",
    members: "AF DZ BH DJ EG IR IQ JO KW LB LY MR MA OM PK QA SA SO SD SY TN AE YE PS",
    aliases: [],
  },
  { code: "APAC", name: "Asia-Pacific", members: null, aliases: ["asia pacific"] },
];

/**
 * Lower case, without accents, dots or apostrophes, with any other
 * punctuation as a space, and without the words a post puts around a
 * place: "the UAE", "US only", "Remote, UK" and "US-based" name a place.
 */
function lookupKey(text: string): string {
  let key = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  for (let previous = ""; previous !== key; ) {
    previous = key;
    key = key.replace(/^(?:the|remote) /, "").replace(/ (?:only|based)$/, "");
  }
  return key;
}

/**
 * Names two places share, which name neither: Georgia is a country and a
 * US state. (Hyderabad, a city in both India and Pakistan, is simply not
 * listed.)
 */
const SHARED_NAMES: ReadonlySet<string> = new Set(["georgia"]);

interface PlaceEntry {
  code: string;
  name: string;
  /** For a region: its member countries, or null when membership is ambiguous. */
  members?: ReadonlySet<string> | null;
}

const PLACES = new Map<string, PlaceEntry>();
const BY_KEY = new Map<string, string>();

function addName(name: string, code: string): void {
  const key = lookupKey(name);
  if (SHARED_NAMES.has(key)) return;
  const taken = BY_KEY.get(key);
  if (taken !== undefined && taken !== code) {
    throw new Error(`"${name}" names both ${taken} and ${code} in the region table`);
  }
  BY_KEY.set(key, code);
}

// A bare country code is not a name: in a post, "CA", "IN" and "GA" are as
// likely US states, and "IT", "QA" and "AI" words. "US" and "UK" are
// listed as aliases.
for (const line of COUNTRIES.trim().split("\n")) {
  const [code, name, ...aliases] = line.split("|") as [string, string, ...string[]];
  PLACES.set(code, { code, name });
  for (const alias of [name, ...aliases]) addName(alias, code);
}
const ALL_COUNTRIES = [...PLACES.keys()];
for (const region of REGIONS) {
  const members =
    region.members === null
      ? null
      : new Set(region.members === "*" ? ALL_COUNTRIES : region.members.split(" "));
  PLACES.set(region.code, { code: region.code, name: region.name, members });
  for (const alias of [region.code, region.name, ...region.aliases]) addName(alias, region.code);
}

/** The place code for a name as written, looked up whole; null when the table does not know it. */
export function placeCode(text: string): string | null {
  return BY_KEY.get(lookupKey(text)) ?? null;
}

export function isPlaceCode(code: string): boolean {
  return PLACES.has(code);
}

/** A country's code, as opposed to a region's. */
export function isCountryCode(code: string): boolean {
  const entry = PLACES.get(code);
  return entry !== undefined && entry.members === undefined;
}

/** A region whose countries are unclear, such as EMEA, which no country can be matched to. */
export function isUnclearRegion(code: string): boolean {
  return PLACES.get(code)?.members === null;
}

export function placeName(code: string): string {
  return PLACES.get(code)?.name ?? code;
}

/**
 * Whether a place takes in another, a country or a region: a country takes
 * in itself, and a region its members and any region made only of them.
 * "unknown" for a code the table does not know, and for a region whose
 * membership is ambiguous, such as EMEA.
 */
export function placeContains(place: string, other: string): boolean | "unknown" {
  const outer = membersOf(place);
  const inner = membersOf(other);
  if (outer === undefined || inner === undefined) return "unknown";
  if (place === other) return true;
  if (outer === null || inner === null) return "unknown";
  for (const country of inner) if (!outer.has(country)) return false;
  return true;
}

/** A place's countries; null for an ambiguous region, undefined for an unknown code. */
function membersOf(code: string): ReadonlySet<string> | null | undefined {
  const entry = PLACES.get(code);
  if (!entry) return undefined;
  return entry.members === undefined ? new Set([code]) : entry.members;
}
