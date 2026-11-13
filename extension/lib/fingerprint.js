const BRANDS = ["Xiaomi", "HUAWEI", "OPPO", "vivo", "HONOR", "realme", "OnePlus", "Google", "samsung", "motorola"];
const DEVICES = [
  { brand: "Xiaomi", model: "23127PN0CC", android: 14, chrome: 126, build: "UKQ1.231003.002" },
  { brand: "HUAWEI", model: "NOH-AN00", android: 12, chrome: 121, build: "HUAWEINOH-AN00" },
  { brand: "OPPO", model: "PHA120", android: 13, chrome: 124, build: "TP1A.220905.001" },
  { brand: "vivo", model: "V2227A", android: 13, chrome: 123, build: "TP1A.220624.014" },
  { brand: "HONOR", model: "PGT-AN10", android: 13, chrome: 124, build: "HONORPGT-AN10" },
  { brand: "realme", model: "RMX3706", android: 14, chrome: 127, build: "UKQ1.230924.001" },
  { brand: "OnePlus", model: "PJD110", android: 14, chrome: 128, build: "UKQ1.230924.001" },
  { brand: "Google", model: "Pixel 7", android: 14, chrome: 129, build: "UQ1A.240205.002" },
  { brand: "samsung", model: "SM-S9180", android: 13, chrome: 125, build: "TP1A.220624.014" },
  { brand: "motorola", model: "XT2301-3", android: 13, chrome: 122, build: "T2SNS33.73-22-3" }
];
const SYSTEMS = ["Linux armv8l", "Linux aarch64"];
const LANGUAGES = ["zh-CN,zh;q=0.9", "zh-CN,zh-Hans;q=0.9,en;q=0.8"];
function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function fingerprintFor(seed) {
  const key = seed && String(seed).trim() ? String(seed).trim() : "default";
  const h = hash32(key);
  const device = DEVICES[h % DEVICES.length];
  return {
    userAgent: `Mozilla/5.0 (Linux; Android ${device.android}; ${device.model} Build/${device.build}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${device.chrome}.0.${6e3 + h % 900}.${100 + h % 90} Mobile Safari/537.36`,
    terminal: device.brand,
    system: SYSTEMS[(h >>> 8) % SYSTEMS.length],
    language: LANGUAGES[(h >>> 16) % LANGUAGES.length]
  };
}
export {
  BRANDS,
  fingerprintFor
};
